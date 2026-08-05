// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"sort"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type azureProvider struct{}

func (p *azureProvider) Name() string { return "azure" }

func (p *azureProvider) RequiredCLIs() []string {
	// CLI-free: the runner mints the AKS AAD token in-process (kube-token exec-plugin,
	// workload-identity federated assertion), replacing `az aks get-credentials` + kubelogin.
	return []string{"kubectl", "helm"}
}

// ValidateConfig refuses an Azure project config the AKS templates cannot provision: the shared
// node-pool sizing invariants, the `aks_disk_size_gb` floor (30 GB — the Azure OS-disk minimum,
// which the canvas's single cross-cloud `min: 20` undershoots), and the VNet-CIDR floor implied
// by the four /20 subnets the vnet module carves.
func (p *azureProvider) ValidateConfig(config *types.ProjectConfig) error {
	if config == nil {
		return fmt.Errorf("ProjectConfig is required")
	}
	if err := validateNodeSizing(config); err != nil {
		return err
	}
	if err := validateNodeDiskSize(config, "aks_disk_size_gb", azureNodeDiskFloorGB); err != nil {
		return err
	}
	return validateNetworkCIDR(config, "vnet_cidr", azureMaxNetworkPrefix)
}

func (p *azureProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	// Seeded by the canvas's DNS switches; an explicit provider_config key still overrides (#1810).
	wafEnabled := config.DNS.WafEnabled
	if v, ok := config.DNS.ProviderConfig["azure_waf"]; ok {
		if b, ok := v.(bool); ok {
			wafEnabled = b
		}
	}
	// No `managed_certificate` override here: Azure's certificate is issued in-cluster by
	// cert-manager (#1825), so the template declares no certificate variable for one to act on.
	//
	// The escape hatch still WORKS — it moved to `managedCertificateAsk` in
	// packages/core/argocd/infra_facts.go, which is where the decision now lives. Overriding there
	// covers every cloud, converged or not, and is written once instead of restated per provider.
	// Leaving a copy here would keep accepting the key and change nothing, which is the defect this
	// programme exists to remove.

	provisionVnet := config.Network.ProvisionNetwork
	if !provisionVnet && config.Network.NetworkID == "" {
		provisionVnet = true
	}

	tfvars := map[string]interface{}{
		"project_name":    config.ProjectName,
		"subscription_id": config.CloudAccountID,
		"location":        resolveRegion("azure", config.Region),
		"environment":     config.EnvironmentStage,

		// Network
		"provision_vnet":           provisionVnet,
		"vnet_cidr":                orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_nat_gateway":       config.Network.SingleNatGateway,
		"vnet_allowed_cidr_blocks": ensureStringSlice(config.Network.AllowedCidrBlocks),

		// AKS. Default resolves from the catalog SSOT (catalog.json default_k8s_version) — keep it on
		// a version in Azure's STANDARD support window, since an AKS create rejects a version that has
		// aged into LTS-only ("K8sVersionNotSupported"). Bump it in catalog.json, not here (#775).
		"provision_aks":       true,
		"aks_cluster_version": resolveK8sVersion("azure", config.Cluster.ClusterVersion),

		// DNS
		"azure_dns_enabled":   config.DNS.Enabled,
		"azure_dns_domain":    config.DNS.DomainName,
		"azure_dns_zone_name": config.DNS.ZoneID,

		// WAF
		"azure_waf_enabled": wafEnabled,

		// TLS — no tfvar. Azure's managed certificate is issued IN-CLUSTER by cert-manager
		// (#1825), so nothing in the template consumes the switch and `azure_managed_certificate`
		// is not emitted. The user's ask still reaches the runner, by the path it always used:
		// InfraFacts.ManagedCertificate reads vc.DNS.ManagedCertificate from the config snapshot,
		// never a tfvar or an output.
		//
		// Emitting it anyway would be worse than dead weight. OpenTofu drops a root variable the
		// template does not declare, so the key would vanish at plan time while the offer-parity
		// guard still traced the emit and scored the cell as carried — a green cell for a value
		// that never reaches a plan.

		// Service Bus
		"create_service_bus": len(config.Queues) > 0 || len(config.Topics) > 0,
		"service_bus_queues": buildServiceBusQueues(config.Queues),
		"service_bus_topics": buildServiceBusTopics(config.Topics),

		// Azure Cache
		"create_azure_cache": len(config.Caches) > 0,

		// Cosmos DB
		"create_cosmos_db":      len(config.NosqlTables) > 0,
		"cosmos_db_collections": buildCosmosDBCollections(config.NosqlTables),

		// ACR
		"provision_acr": len(config.ContainerRegistries) > 0,

		// Storage
		"create_storage_account": len(config.StorageBuckets) > 0,
		"storage_containers":     buildAzureContainers(config.StorageBuckets),

		// Secrets
		"custom_secrets": buildGCPSecrets(config.Secrets),

		// Azure DB
		"create_azure_db": len(config.Databases) > 0,
	}

	if len(config.Databases) > 0 {
		db := config.Databases[0]
		fam := db.EngineFamily
		if fam == "" {
			fam = "postgres"
			if db.Engine == "mysql" || db.Engine == "aurora-mysql" {
				fam = "mysql"
			}
		}
		tfvars["azure_db_engine"] = fam
		if _, version := resolveDBEngine("azure", db); version != "" {
			tfvars["azure_db_engine_version"] = version
		}
		if db.InstanceClass != "" {
			tfvars["azure_db_sku_name"] = db.InstanceClass
		}
		if db.Port != nil {
			tfvars["azure_db_port"] = *db.Port
		}
		if db.BackupRetentionDays != nil {
			tfvars["azure_db_backup_retention_days"] = *db.BackupRetentionDays
		}
		if db.IamAuth != nil {
			tfvars["azure_db_iam_auth"] = *db.IamAuth
		}
		// Generic passthrough — see mergeProviderConfig (aws_provider.go). azure_db_iam_auth is
		// reserved UNCONDITIONALLY: db.IamAuth == nil leaves it unset, and without this a
		// provider_config key could switch keyless on for a cell the canvas never offered, walking
		// around the offer-parity guard (#1508). `log_exports` is AWS-only — no Azure template
		// variable declares a log-export set — so it is reserved rather than emitted undeclared.
		mergeProviderConfig(tfvars, db.ProviderConfig, "log_exports", "azure_db_iam_auth")
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]
		// Size. `azure_cache_sku_name` is the EXACT Managed Redis sku and it wins over the legacy
		// Basic/Standard/Premium map below (infra/templates/project/azure/azure-cache-redis.tf), so
		// emitting it is what makes MemoryGB — the cloud-indifferent size the canvas offers — mean
		// something on Azure. Without this, azure read no size axis at all: the only size-ish signal
		// was NumCacheNodes>1 flipping the tier to "Standard".
		if sku := resolveCacheNodeType("azure", cache); sku != "" {
			tfvars["azure_cache_sku_name"] = sku
		}
		if cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1 {
			tfvars["azure_cache_sku"] = "Standard"
		}
		if cache.EngineVersion != "" {
			tfvars["azure_cache_redis_version"] = cache.EngineVersion
		}
		if cache.MultiAz != nil {
			tfvars["azure_cache_multi_az"] = *cache.MultiAz
		}
	}

	if inst := resolveInstanceTypes("azure", config.Cluster); len(inst) > 0 {
		tfvars["aks_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["aks_node_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["aks_node_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["aks_node_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["aks_disk_size_gb"] = *config.Cluster.NodeDiskSizeGB
	}

	// B4.1 + A2.2: cluster_admins → AKS admin_group_object_ids, UNIONed with an explicit
	// provider_config["aks_admin_group_object_ids"] list (the e2e self-admin seam). Only set
	// when non-empty so the AAD-integrated RBAC block stays unrendered (Kubernetes-RBAC-only,
	// unchanged) for the common case. The AKS-authorized-CIDR and DB-allow-list knobs
	// (aks_authorized_ip_ranges / azure_db_allowed_cidrs) still flow through the generic
	// provider_config passthrough below; aks_admin_group_object_ids is consumed HERE (and
	// reserved from that passthrough) so the two sources merge instead of one clobbering the
	// other.
	if ids := resolveAKSAdminGroupObjectIDs(config.Cluster); len(ids) > 0 {
		tfvars["aks_admin_group_object_ids"] = ids
	}

	if !provisionVnet && config.Network.NetworkID != "" {
		tfvars["vnet_id"] = config.Network.NetworkID
	}
	// Brownfield subnet selection (#1352): the user-picked subnet name(s). Written only on
	// an existing VNet and only when non-empty; the template uses subnet_ids[0] instead of
	// the unordered subnets[0] guess. Empty selection leaves the key absent (today's
	// behaviour).
	if !provisionVnet && len(config.Network.SubnetIDs) > 0 {
		tfvars["subnet_ids"] = config.Network.SubnetIDs
	}

	// Generic passthrough — see mergeProviderConfig (aws_provider.go). Reserved keys
	// are consumed above under a different tfvar name.
	// B1.2: classification → resource tags (+ the always-on project-id/environment-id sweep
	// handles), Azure-styled (`alethia:...`). Set before mergeProviderConfig so a user's
	// provider_config can't shadow it. Consumed by the classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, azureTagStyle)

	// aks_admin_group_object_ids is consumed above (unioned from cluster_admins + the explicit
	// provider_config list), so reserve it from the generic passthrough — otherwise a
	// provider_config value would be re-injected verbatim and could drop the cluster_admins half.
	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig, "aks_admin_group_object_ids")
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "azure_waf", "managed_certificate")

	return tfvars
}

func (p *azureProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no AKS cluster name in outputs")
	}

	// CLI-free: write a kubeconfig that authenticates via the runner's own `kube-token`
	// exec-plugin (in-process AKS AAD token from the workload-identity federated assertion)
	// instead of shelling `az aks get-credentials`. A short-lived AAD token (not a
	// long-lived admin cert) survives AKS local-account hardening and leaks nothing durable.
	// Endpoint + CA come from the tofu outputs (non-secret; the admin cert is never surfaced).
	endpoint := extractOutputString(outputs, "aks_cluster_endpoint")
	if endpoint == "" {
		endpoint = extractOutputString(outputs, "cluster_endpoint") // BYO-IaC generic fallback
	}
	ca := extractOutputString(outputs, "aks_cluster_ca_certificate")
	if ca == "" {
		ca = extractOutputString(outputs, "cluster_ca_certificate") // BYO-IaC generic fallback
	}
	if endpoint == "" || ca == "" {
		return fmt.Errorf("missing AKS endpoint/CA in tofu outputs (aks_cluster_endpoint/aks_cluster_ca_certificate or generic cluster_endpoint/cluster_ca_certificate)")
	}
	fmt.Fprintf(stdout, "Configuring kubeconfig for AKS cluster %s...\n", clusterName)
	return writeExecKubeconfig(
		clusterName,
		endpoint,
		ca,
		[]string{"kube-token", "--provider", "azure"},
		stdout,
	)
}

func extractOutputString(outputs map[string]interface{}, key string) string {
	if val, ok := outputs[key]; ok {
		if m, ok := val.(map[string]interface{}); ok {
			if v, ok := m["value"].(string); ok {
				return v
			}
		}
		if s, ok := val.(string); ok {
			return s
		}
	}
	return ""
}

// resolveAKSAdminGroupObjectIDs collects the Entra group OBJECT IDs to grant AKS
// AAD-integrated cluster-admin from BOTH supported sources, unioned + deduped + sorted so
// the resulting tfvar is deterministic:
//
//   - config.Cluster.ClusterAdmins (B4.1) — each admin's `groups` hold Entra group object IDs.
//   - config.Cluster.ProviderConfig["aks_admin_group_object_ids"] — an explicit list. This is
//     the e2e self-admin seam (BYOC A2.2): AAD-integrated RBAC only renders when the admin
//     group list is non-empty (aks/main.tf), so on the managed-cluster default (empty) the
//     runner's short-lived AAD token 401s the fresh API server — the same "runner never
//     authorized" gap seen on EKS/GKE. The infra/azure-e2e stack outputs an Entra admin group
//     (with the e2e service principal as a member) whose object id the e2e cluster JSON drops
//     here (via ALETHIA_E2E_CLUSTER_JSON → the snapshot's cluster.provider_config), so the
//     runner is authorized at create time. The customer default is unchanged: neither source
//     supplying an id leaves this nil and the AAD RBAC block off (Kubernetes-RBAC-only).
func resolveAKSAdminGroupObjectIDs(cluster types.ProjectClusterConfig) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(s string) {
		if s == "" {
			return
		}
		if _, dup := seen[s]; dup {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	for _, id := range azureAdminGroupObjectIDs(cluster.ClusterAdmins) {
		add(id)
	}
	if raw, ok := cluster.ProviderConfig["aks_admin_group_object_ids"]; ok {
		if list, ok := raw.([]any); ok {
			for _, v := range list {
				if s, ok := v.(string); ok {
					add(s)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

// azureAdminGroupObjectIDs flattens the Entra group object IDs carried by the project's
// cluster_admins into a deduped list for the AKS admin_group_object_ids knob. Each admin
// entry is a JSONB object ({username, groups[]}); its `groups` hold Entra group object
// IDs. Returns nil when none are present so the caller leaves the AAD RBAC block off.
func azureAdminGroupObjectIDs(admins []any) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, a := range admins {
		m, ok := a.(map[string]any)
		if !ok {
			continue
		}
		groups, ok := m["groups"].([]any)
		if !ok {
			continue
		}
		for _, g := range groups {
			s, ok := g.(string)
			if !ok || s == "" {
				continue
			}
			if _, dup := seen[s]; dup {
				continue
			}
			seen[s] = struct{}{}
			out = append(out, s)
		}
	}
	return out
}

// buildServiceBusQueues maps each canvas queue onto one entry of the `service_bus_queues` tfvar.
//
// Ordered delivery on Azure is a Service Bus SESSION: `requires_session` makes the queue hand every
// message carrying one SessionId to a single receiver, in arrival order.
//
// `requires_session` is emitted for EVERY queue, not only when the canvas switch was touched. The
// key used to appear only when `Ordered != nil`, which made the tfvars shape depend on whether a
// user had ever opened the field — two queues that look identical in the console produced different
// input to the template. The module declares `optional(bool, false)`, so emitting the OFF position
// explicitly is a no-op diff for every queue that exists today.
func buildServiceBusQueues(queues []types.ProjectQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		cfg := map[string]interface{}{
			"max_delivery_count": 10,
			"lock_duration":      "PT1M",
			"requires_session":   derefBoolOr(q.Ordered, false),
		}
		if q.VisibilityTimeout != nil {
			cfg["lock_duration"] = fmt.Sprintf("PT%dS", *q.VisibilityTimeout)
		}
		if q.MessageRetention != nil {
			cfg["default_message_ttl"] = fmt.Sprintf("PT%dS", *q.MessageRetention)
		}
		if d, ok := providerInt(q.ProviderConfig, "delay_seconds"); ok {
			cfg["forward_dead_lettered_messages_to"] = ""
			cfg["max_delivery_count"] = 10
			// Azure Service Bus doesn't have a direct delay_seconds equivalent,
			// but we can pass it for scheduled enqueue support
			cfg["delay_seconds"] = d
		}
		result[q.Name] = cfg
	}
	return result
}

func buildServiceBusTopics(topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]interface{}{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]interface{}{
				"name":               s.Endpoint,
				"max_delivery_count": 10,
			})
		}
		result[t.Name] = map[string]interface{}{
			"subscriptions": subs,
		}
	}
	return result
}

// buildCosmosDBCollections maps the canvas's NoSQL tables onto the Cosmos DB container shape the
// azure template declares (`cosmos_db_collections`).
//
// `point_in_time_recovery` carries the switch's OWN VALUE rather than gating a key, because on Cosmos
// point-in-time restore is an account-level backup MODE — `backup { type = "Continuous" }` — and the
// template folds these per-container flags into that one mode.
//
// This used to write `analytical_storage_enabled = true` instead (#1838). Analytical storage is
// Synapse Link column storage: a different product, separately billed, and not a backup at all. A
// user who asked for recoverability got an extra bill and no recoverability. `analytical_storage_enabled`
// is still an accepted key of the container shape for anyone who genuinely wants Synapse Link — it is
// simply no longer derived from this switch.
func buildCosmosDBCollections(tables []types.ProjectNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		result = append(result, map[string]interface{}{
			"name":                   t.Name,
			"partition_key":          orDefault(t.PartitionKey, "/id"),
			"billing_mode":           ddbCapacityMode(string(t.CapacityMode)),
			"point_in_time_recovery": t.PointInTimeRecovery,
		})
	}
	return result
}

// buildAzureContainers turns the canvas's buckets into the `storage_containers` tfvar.
//
// The key is `access_type`, not `container_access_type`. The module has always declared and read
// `access_type` (modules/storage-account) and mapped it onto the resource's own
// `container_access_type` argument; sending the resource's spelling meant the value landed on a name
// nothing read and every container was created private whatever the user chose.
//
// `versioning_enabled` is emitted PER CONTAINER even though Azure blob versioning is a property of
// the storage ACCOUNT, and this template gives a project exactly one. Keeping the per-bucket intent
// visible in the tfvars is what lets the template aggregate it in one place, with one comment
// explaining the coarsening — rather than the provider silently deciding for the whole project here.
func buildAzureContainers(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		accessType := "private"
		if b.PublicAccess {
			accessType = "blob"
		}
		result = append(result, map[string]interface{}{
			"name":               b.Name,
			"access_type":        accessType,
			"versioning_enabled": b.Versioning,
		})
	}
	return result
}

var _ CloudProvider = (*azureProvider)(nil)
