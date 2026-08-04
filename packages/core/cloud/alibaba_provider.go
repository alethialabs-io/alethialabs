// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// alibabaProvider provisions a full managed stack on Alibaba Cloud (ACK cluster + ApsaraDB /
// Redis / MNS / Tablestore / OSS / ACR / KMS / Alibaba DNS), reaching parity with AWS/GCP/Azure.
// Auth is keyless: the runner activates ALICLOUD_ACCESS_KEY/_SECRET/_STS_TOKEN in the env from
// the OIDC identity (AssumeRoleWithOIDC) — no static keys in tfvars/state. Kubeconfig is produced
// by the ACK resource and surfaced as a (sensitive) OpenTofu output the runner reads back.
type alibabaProvider struct{}

func (p *alibabaProvider) Name() string { return "alibaba" }

func (p *alibabaProvider) RequiredCLIs() []string {
	return []string{"kubectl", "helm"}
}

// ValidateConfig refuses an Alibaba project config the ACK templates cannot provision: the
// shared node-pool sizing invariants, the `ack_disk_size_gb` floor, and the VPC-CIDR floor
// implied by the vswitch carve.
func (p *alibabaProvider) ValidateConfig(config *types.ProjectConfig) error {
	if config == nil {
		return fmt.Errorf("ProjectConfig is required")
	}
	if err := validateNodeSizing(config); err != nil {
		return err
	}
	if err := validateNodeDiskSize(config, "ack_disk_size_gb", alibabaNodeDiskFloorGB); err != nil {
		return err
	}
	return validateNetworkCIDR(config, "network_cidr", alibabaMaxNetworkPrefix)
}

func (p *alibabaProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	// Seeded by the canvas's DNS switches; an explicit provider_config key still overrides (#1810).
	managedCert := config.DNS.ManagedCertificate
	if v, ok := config.DNS.ProviderConfig["managed_certificate"]; ok {
		if b, ok := v.(bool); ok {
			managedCert = b
		}
	}
	wafEnabled := config.DNS.WafEnabled
	if v, ok := config.DNS.ProviderConfig["application_waf"]; ok {
		if b, ok := v.(bool); ok {
			wafEnabled = b
		}
	}

	provisionNetwork := config.Network.ProvisionNetwork
	if !provisionNetwork && config.Network.NetworkID == "" {
		provisionNetwork = true
	}

	tfvars := map[string]interface{}{
		"project_name":    config.ProjectName,
		"region":          resolveRegion("alibaba", config.Region),
		"environment":     config.EnvironmentStage,
		"alibaba_account": config.CloudAccountID,

		// Network (VPC + VSwitch)
		"provision_network": provisionNetwork,
		"network_cidr":      orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_cloud_nat":  config.Network.SingleNatGateway,

		// ACK (managed Kubernetes)
		"provision_ack":       true,
		"ack_cluster_version": resolveK8sVersion("alibaba", config.Cluster.ClusterVersion),

		// DNS (Alibaba Cloud DNS) + WAF
		"alidns_enabled":             config.DNS.Enabled,
		"alidns_domain":              config.DNS.DomainName,
		"alidns_zone_name":           config.DNS.ZoneID,
		"alidns_managed_certificate": managedCert,
		"application_waf_enabled":    wafEnabled,

		// MNS (queues + topics)
		"create_mns": len(config.Queues) > 0 || len(config.Topics) > 0,
		"mns_queues": buildMNSQueues(config.Queues),
		"mns_topics": buildMNSTopics(config.Topics),

		// ApsaraDB for Redis (kvstore)
		"create_kvstore": len(config.Caches) > 0,

		// Tablestore (OTS)
		"create_ots": len(config.NosqlTables) > 0,
		"ots_tables": buildOTSTables(config.NosqlTables),

		// Container Registry (CR Enterprise Edition). `cr_repos` drives the module's for_each — one
		// repository per NATIVE registry component. The module used to create an instance and a
		// namespace and no `alicloud_cr_ee_repo` at all (#1837), so a project with a native registry
		// got a PAID Enterprise Edition instance with nowhere to push an image. Both keys derive
		// from the one builder so the flag and the repositories cannot disagree; see the GCP
		// emitter for why the builder is called twice rather than hoisted to a local.
		"provision_cr": len(buildCRRepos(config)) > 0,
		"cr_repos":     buildCRRepos(config),

		// OSS (object storage)
		"create_oss":  len(config.StorageBuckets) > 0,
		"oss_buckets": buildOSSBuckets(config.StorageBuckets),

		// KMS secrets
		"custom_secrets": buildAlibabaSecrets(config.Secrets),

		// ApsaraDB RDS
		"create_rds": len(config.Databases) > 0,
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
		engine := "PostgreSQL"
		if fam == "mysql" {
			engine = "MySQL"
		}
		tfvars["rds_engine"] = engine
		if _, version := resolveDBEngine("alibaba", db); version != "" {
			tfvars["rds_engine_version"] = version
		}
		if db.InstanceClass != "" {
			tfvars["rds_instance_type"] = db.InstanceClass
		}
		if db.Port != nil {
			tfvars["rds_port"] = *db.Port
		}
		if db.BackupRetentionDays != nil {
			tfvars["rds_backup_retention_days"] = *db.BackupRetentionDays
		}
		// Generic passthrough — see mergeProviderConfig (aws_provider.go). No IAM-auth flag to reserve:
		// Alibaba has no keyless DB cell (ApsaraDB exposes no data-plane token login we could find), so
		// db.IamAuth is never emitted here and the offer-parity baseline records the gap. `log_exports`
		// is AWS-only — no Alibaba template variable declares a log-export set.
		mergeProviderConfig(tfvars, db.ProviderConfig, "log_exports")
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]
		if cache.EngineVersion != "" {
			tfvars["kvstore_engine_version"] = cache.EngineVersion
		}
		if it := resolveCacheNodeType("alibaba", cache); it != "" {
			tfvars["kvstore_instance_class"] = it
		}
		if cache.MultiAz != nil {
			tfvars["kvstore_multi_az"] = *cache.MultiAz
		}
	}

	if inst := resolveInstanceTypes("alibaba", config.Cluster); len(inst) > 0 {
		tfvars["ack_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["ack_node_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["ack_node_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["ack_node_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["ack_disk_size_gb"] = *config.Cluster.NodeDiskSizeGB
	}

	if !provisionNetwork && config.Network.NetworkID != "" {
		tfvars["network_id"] = config.Network.NetworkID
	}
	// Brownfield subnet selection (#1352): the user-picked vSwitch ids. Written only on an
	// existing VPC and only when non-empty; the template prefers these (ordered) over the
	// unordered data.alicloud_vswitches.existing[0] discovery. Empty selection leaves the
	// key absent (today's behaviour).
	if !provisionNetwork && len(config.Network.SubnetIDs) > 0 {
		tfvars["subnet_ids"] = config.Network.SubnetIDs
	}

	// Generic passthrough — see mergeProviderConfig (aws_provider.go). Reserved DNS keys are
	// consumed above under a different tfvar name.
	// B1.2: classification → resource tags (+ the always-on project-id/environment-id sweep
	// handles), Alibaba-styled (`alethia:...`). Set before mergeProviderConfig so a user's
	// provider_config can't shadow it. Consumed by the classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, alibabaTagStyle)

	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig)
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "managed_certificate", "application_waf")

	return tfvars
}

// ConfigureKubeconfig writes a working kubeconfig for the ACK cluster and points KUBECONFIG at it.
// Two paths, mirroring aws_provider.go:
//   - DEDICATED / BYO: the ACK tofu run emitted a full `kubeconfig` sensitive output — write it verbatim.
//   - OUTPUT-FREE placement (namespace/vcluster, #1129): no tofu ran, so only the synthesized
//     `ack_cluster_name` key is present. Resolve the cluster BY NAME via the keyless RRSA-signing client
//     (name → ClusterId → DescribeClusterUserKubeconfig), which returns a complete, SHORT-LIVED user
//     kubeconfig (embedded x509 client cert — ACK has no exec-plugin bearer model), and write that.
func (p *alibabaProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	// Dedicated / BYO: a ready-made kubeconfig output is written directly.
	if kubeconfig := alibabaOutputString(outputs, "kubeconfig"); kubeconfig != "" {
		fmt.Fprintf(stdout, "Writing ACK kubeconfig for cluster %s...\n", ExtractClusterName(outputs))
		return p.writeKubeconfig(kubeconfig, stdout)
	}

	// Output-free placement: resolve the existing cluster by name via the signing client.
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no kubeconfig and no ACK cluster name in outputs")
	}
	region := resolveRegion("alibaba", config.Region)
	if region == "" {
		return fmt.Errorf("ack placement: no region on the config snapshot — cannot resolve cluster %q output-free", clusterName)
	}
	fmt.Fprintf(stdout, "Resolving ACK cluster %q (region %s) output-free via keyless RRSA...\n", clusterName, region)

	client, err := newAlibabaSigningClient(ctx, region)
	if err != nil {
		return fmt.Errorf("ack placement: build keyless signing client: %w", err)
	}
	clusterID, err := ResolveACKClusterID(ctx, client, region, clusterName)
	if err != nil {
		return fmt.Errorf("ack placement: resolve cluster id for %q: %w", clusterName, err)
	}
	kubeconfig, err := ResolveACKUserKubeconfig(ctx, client, region, clusterID)
	if err != nil {
		return fmt.Errorf("ack placement: fetch user kubeconfig for %q (%s): %w", clusterName, clusterID, err)
	}
	fmt.Fprintf(stdout, "Writing short-lived ACK kubeconfig for cluster %s (%s)...\n", clusterName, clusterID)
	return p.writeKubeconfig(kubeconfig, stdout)
}

// writeKubeconfig persists a kubeconfig to the per-worker HOME path (0600) and points KUBECONFIG at it.
func (p *alibabaProvider) writeKubeconfig(kubeconfig string, stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	kubeDir := filepath.Join(home, ".alethia")
	kubeconfigPath := filepath.Join(kubeDir, "kubeconfig")
	if err := os.MkdirAll(kubeDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(kubeconfigPath, []byte(kubeconfig), 0600); err != nil {
		return err
	}
	os.Setenv("KUBECONFIG", kubeconfigPath)
	fmt.Fprintf(stdout, "Kubeconfig written to %s\n", kubeconfigPath)
	return nil
}

// alibabaOutputString reads a string OpenTofu output, tolerating both the `{"value": ...}`
// wrapper (from `tofu output -json`) and a bare string.
func alibabaOutputString(outputs map[string]interface{}, key string) string {
	val, ok := outputs[key]
	if !ok {
		return ""
	}
	if m, ok := val.(map[string]interface{}); ok {
		if s, ok := m["value"].(string); ok {
			return s
		}
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	return ""
}

func buildMNSQueues(queues []types.ProjectQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		cfg := map[string]interface{}{}
		if q.VisibilityTimeout != nil {
			cfg["visibility_timeout"] = *q.VisibilityTimeout
		}
		if q.MessageRetention != nil {
			cfg["message_retention_period"] = *q.MessageRetention
		}
		result[q.Name] = cfg
	}
	return result
}

func buildMNSTopics(topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]string{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]string{
				"protocol": string(s.Protocol),
				"endpoint": s.Endpoint,
			})
		}
		result[t.Name] = map[string]interface{}{"subscriptions": subs}
	}
	return result
}

// buildOTSTables shapes the canvas's NoSQL tables into `ots_tables`.
//
// The key name is load-bearing and was wrong (#1836). This emitted a scalar `primary_key` plus a
// `primary_key_type`, while `modules/ots/main.tf` reads
// `try(each.value.primary_keys, [{ name = "id", type = "String" }])` — a LIST under a different
// name. `try` swallows the miss, so the plan was always clean and every Tablestore table in every
// Alibaba project was built with the module's fallback key `id`/`String` rather than the partition
// key the user chose. Nothing failed; the choice was simply discarded.
//
// So the emit is a list under the name the module actually reads. Tablestore's primary key is
// immutable, so correcting this REPLACES any table that was built with the wrong key — which is the
// cost of the table having been wrong, not a new hazard introduced here.
func buildOTSTables(tables []types.ProjectNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		entry := map[string]interface{}{
			"name": t.Name,
			"primary_keys": []map[string]interface{}{
				{
					"name": t.PartitionKey,
					"type": otsKeyType(string(t.PartitionKeyType)),
				},
			},
		}
		result = append(result, entry)
	}
	return result
}

// otsKeyType maps a cloud-neutral key type (S/N/B) to Tablestore's type names.
func otsKeyType(t string) string {
	switch t {
	case "N":
		return "Integer"
	case "B":
		return "Binary"
	default:
		return "String"
	}
}

// buildCRRepos collects the Container Registry repositories the template must create, keyed by the
// registry component's logical name — the same key the `cr_repository_urls` output is keyed by.
//
// It did not exist, and neither did the repositories: `modules/cr` created an
// `alicloud_cr_ee_instance` and an `alicloud_cr_ee_namespace` and stopped there (#1837). A namespace
// is not a place to push an image, so a native Alibaba registry produced a paid Enterprise Edition
// subscription and nothing usable. That absence is also why `registry:immutable_tags` could not be
// wired on Alibaba: `tag_immutability` is an argument on the repository, and there was no repository.
//
// Only NATIVE registry components produce a repository, and the switch travels per repository — the
// instance's own arguments are never touched by it. That matters more here than elsewhere: the CR EE
// instance is `payment_type = "Subscription"`, so landing a canvas switch on one of its arguments
// would put a monthly commitment behind a checkbox and, worse, could force its replacement.
func buildCRRepos(config *types.ProjectConfig) map[string]interface{} {
	out := map[string]interface{}{}
	for _, r := range config.ContainerRegistries {
		// A pluggable registry (connectors.slug) is not CR's to create.
		if r.Provider != "" && r.Provider != "native" {
			continue
		}
		if r.Name == "" {
			continue
		}
		// A nil switch is an older row or a hand-written snapshot. Read it as the SAFE setting
		// rather than as false, so an upgrade never turns a live repository's tags mutable.
		immutable := true
		if r.ImmutableTags != nil {
			immutable = *r.ImmutableTags
		}
		out[r.Name] = map[string]interface{}{
			"summary":        "Container images for " + r.Name,
			"immutable_tags": immutable,
		}
	}
	return out
}

// ossSSEAlgorithm resolves the OSS server-side-encryption algorithm from the bucket's
// provider_config (encryption_algorithm), defaulting to AES256 when encryption is enabled.
// Mirrors s3SSEAlgorithm.
//
// AES256 (SSE-OSS) is the only safe default: Alibaba bills it as "None. Free of charge.", while
// SSE-KMS incurs a per-call KMS fee. A tenant who wants KMS asks for it explicitly and accepts the
// bill. "SM4" is deliberately NOT reachable by default even though the Terraform provider's own
// ValidateFunc accepts it — PutBucketEncryption documents only AES256/KMS and answers anything else
// with InvalidEncryptionAlgorithmError, so a provider-valid SM4 would plan clean and fail at apply.
// modules/oss/variables.tf refuses it fail-closed at plan time for the same reason.
func ossSSEAlgorithm(b types.ProjectStorageBucketConfig) string {
	if b.ProviderConfig != nil {
		if v, ok := b.ProviderConfig["encryption_algorithm"].(string); ok && v != "" {
			return v
		}
	}
	return "AES256"
}

// buildOSSBuckets renders the canvas's storage buckets into the `oss_buckets` tfvar.
//
// `name_suffix` (not `name`) is the cross-cloud spelling — GCP's cloud-storage module and AWS's s3
// module both take a suffix and compose the real name from the project's own prefix. This builder
// emitted `name_suffix` while modules/oss keyed on `b.name`, so EVERY Alibaba project carrying a
// bucket died at plan with "This object does not have an attribute named name" (#1834). That is
// fixed on the template side rather than here, which keeps the three clouds spelled alike — and the
// suffix is the honest name besides: OSS bucket names are globally unique across all of Alibaba
// Cloud, so a raw "assets" could never have been created even once the key names lined up.
func buildOSSBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		acl := "private"
		if b.PublicAccess {
			acl = "public-read"
		}
		// BOTH POSITIONS ARE EMITTED, and that is the point. OSS applies NO default server-side
		// encryption to a new bucket — GetBucketEncryption answers 400 NoSuchServerSideEncryptionRule,
		// and PutBucket's x-oss-server-side-encryption header has no documented default on a page
		// where every other optional header states one. So unlike S3/GCS/Blob, leaving this switch
		// uncarried does not land on an encrypted bucket. It lands on unencrypted objects (#1814).
		//
		// Emitting the key ONLY in the `true` branch would be half a fix: the OFF position would
		// silently inherit whatever the template defaults to, which is exactly the shape that scores
		// green while the gap survives (#1829). "None" is OSS's own spelling for "no rule", and the
		// module turns it into an absent server_side_encryption_rule block.
		sseAlgorithm := "None"
		if b.EncryptionEnabled {
			sseAlgorithm = ossSSEAlgorithm(b)
		}
		entry := map[string]interface{}{
			"name_suffix":   b.Name,
			"acl":           acl,
			"versioning":    b.Versioning,
			"cors_origins":  b.CorsOrigins,
			"sse_algorithm": sseAlgorithm,
		}
		result = append(result, entry)
	}
	return result
}

func buildAlibabaSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(secrets))
	for _, s := range secrets {
		if !secretProvisionedNatively(s.Provider) {
			continue // read via ESO from its pluggable/cross-account store, not created here
		}
		result = append(result, map[string]interface{}{
			"name":          s.Name,
			"generate":      s.Generate,
			"length":        s.Length,
			"special_chars": s.SpecialChars,
		})
	}
	return result
}

var _ CloudProvider = (*alibabaProvider)(nil)
