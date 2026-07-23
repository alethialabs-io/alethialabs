// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type gcpProvider struct{}

func (p *gcpProvider) Name() string { return "gcp" }

func (p *gcpProvider) RequiredCLIs() []string {
	// CLI-free: the runner mints the GKE OAuth token in-process (kube-token exec-plugin),
	// replacing gcloud + gke-gcloud-auth-plugin. Only cluster tooling remains.
	return []string{"kubectl", "helm"}
}

func (p *gcpProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	enableAutopilot := false
	if v, ok := config.Cluster.ProviderConfig["enable_autopilot"]; ok {
		if b, ok := v.(bool); ok {
			enableAutopilot = b
		}
	}

	cloudArmorEnabled := false
	managedCert := false
	if v, ok := config.DNS.ProviderConfig["cloud_armor"]; ok {
		if b, ok := v.(bool); ok {
			cloudArmorEnabled = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["managed_certificate"]; ok {
		if b, ok := v.(bool); ok {
			managedCert = b
		}
	}

	provisionNetwork := config.Network.ProvisionNetwork
	if !provisionNetwork && config.Network.NetworkID == "" {
		provisionNetwork = true
	}

	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"project_id":   config.CloudAccountID,
		"region":       resolveRegion("gcp", config.Region),
		"environment":  config.EnvironmentStage,

		// Network
		"provision_network": provisionNetwork,
		"network_cidr":      orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_cloud_nat":  config.Network.SingleNatGateway,

		// GKE
		"provision_gke":        true,
		"gke_cluster_version":  resolveK8sVersion("gcp", config.Cluster.ClusterVersion),
		"gke_enable_autopilot": enableAutopilot,

		// DNS
		"cloud_dns_enabled":             config.DNS.Enabled,
		"cloud_dns_domain":              config.DNS.DomainName,
		"cloud_dns_zone_name":           config.DNS.ZoneID,
		"cloud_dns_managed_certificate": managedCert,

		// Cloud Armor
		"cloud_armor_enabled": cloudArmorEnabled,

		// Pub/Sub
		"create_pubsub": len(config.Queues) > 0 || len(config.Topics) > 0,
		"pubsub_topics": buildPubSubTopics(config.Topics, config.Queues),

		// Memorystore
		"create_memorystore": len(config.Caches) > 0,

		// Firestore. The template's Firestore model is a SINGLE per-project database
		// (create_firestore + firestore_database_type/location vars) — GCP allows one Firestore
		// DB per project and NoSQL "tables" are collections within it, created by the app, not
		// tofu. The old per-table `firestore_databases` list var was never declared in
		// variables.tf, so it was silently dropped; dropped here too (buildFirestoreDatabases is
		// retained only for its unit test, out of this issue's scope).
		"create_firestore": len(config.NosqlTables) > 0,

		// Artifact Registry (container registry)
		"provision_artifact_registry": len(config.ContainerRegistries) > 0,

		// Cloud Storage
		"create_cloud_storage":  len(config.StorageBuckets) > 0,
		"cloud_storage_buckets": buildGCSBuckets(config.StorageBuckets),

		// Secrets
		"custom_secrets": buildGCPSecrets(config.Secrets),

		// Cloud SQL
		"create_cloud_sql": len(config.Databases) > 0,
		// TODO: wire from ProjectConfig when an AuthorizedNetworks field is added
		"cloud_sql_authorized_networks": []map[string]interface{}{},
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
		engine := "POSTGRES"
		if fam == "mysql" {
			engine = "MYSQL"
		}
		tfvars["cloud_sql_engine"] = engine
		if _, version := resolveDBEngine("gcp", db); version != "" {
			tfvars["cloud_sql_engine_version"] = version
		}
		if db.InstanceClass != "" {
			tfvars["cloud_sql_tier"] = db.InstanceClass
		}
		if db.Port != nil {
			tfvars["cloud_sql_port"] = *db.Port
		}
		if db.BackupRetentionDays != nil {
			tfvars["cloud_sql_backup_retention_days"] = *db.BackupRetentionDays
		}
		if db.IamAuth != nil {
			tfvars["cloud_sql_iam_auth"] = *db.IamAuth
		}
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]
		// Map ProjectCacheConfig onto the ONLY Memorystore tfvars the GCP template declares:
		// memorystore_tier (BASIC|STANDARD_HA), memorystore_memory_size_gb (whole GB), and
		// memorystore_redis_version (the REDIS_x_y enum). The provider previously emitted
		// memorystore_engine / memorystore_instance_type / memorystore_multi_az — none declared
		// in variables.tf, so a customer's cache shape was silently dropped (this wiring gap).
		//
		// Tier: STANDARD_HA (replicated, high-availability) when the config asks for more than one
		// node OR explicit multi-AZ; otherwise the template default (BASIC) stands.
		if (cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1) || (cache.MultiAz != nil && *cache.MultiAz) {
			tfvars["memorystore_tier"] = "STANDARD_HA"
		}
		// Size: the cloud-indifferent MemoryGB is the memorystore_memory_size_gb number directly.
		// GCP requires whole GB, so round. The M1..M4 NearestCacheTier labels are the console tier
		// NAMES, not this template's size/tier model, so they are deliberately NOT used here.
		if cache.MemoryGB > 0 {
			tfvars["memorystore_memory_size_gb"] = int(math.Round(cache.MemoryGB))
		}
		// Version: the var accepts only the REDIS_x_y enum — passing a raw "7.1" fails the apply.
		if v := gcpMemorystoreRedisVersion(cache.EngineVersion); v != "" {
			tfvars["memorystore_redis_version"] = v
		}
	}

	if inst := resolveInstanceTypes("gcp", config.Cluster); len(inst) > 0 {
		tfvars["gke_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["gke_node_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["gke_node_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["gke_node_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["gke_disk_size_gb"] = *config.Cluster.NodeDiskSizeGB
	}

	if !provisionNetwork && config.Network.NetworkID != "" {
		tfvars["network_id"] = config.Network.NetworkID
	}

	// Generic passthrough — see mergeProviderConfig (aws_provider.go). Reserved keys
	// are consumed above under a different tfvar name.
	// B1.2: classification → resource labels (+ the always-on project-id/environment-id sweep
	// handles), GCP-styled (lowercase `alethia_...`, ≤63). Set before mergeProviderConfig so a
	// user's provider_config can't shadow it. Consumed by the classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, gcpTagStyle)

	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig, "enable_autopilot")
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "cloud_armor", "managed_certificate")

	return tfvars
}

func (p *gcpProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no GKE cluster name in outputs")
	}
	fmt.Fprintf(stdout, "Configuring kubeconfig for GKE cluster %s...\n", clusterName)

	// CLI-free: write a kubeconfig that authenticates via the runner's own `kube-token`
	// exec-plugin (in-process GKE OAuth token from the keyless WIF creds) instead of
	// shelling `gcloud container clusters get-credentials`. Endpoint + CA come from the
	// tofu outputs (sensitive, consumed in-process — never persisted).
	endpoint := extractOutputString(outputs, "gke_cluster_endpoint")
	if endpoint == "" {
		endpoint = extractOutputString(outputs, "cluster_endpoint") // BYO-IaC generic fallback
	}
	ca := extractOutputString(outputs, "gke_cluster_ca_certificate")
	if ca == "" {
		ca = extractOutputString(outputs, "cluster_ca_certificate") // BYO-IaC generic fallback
	}
	if endpoint == "" || ca == "" {
		return fmt.Errorf("missing GKE endpoint/CA in tofu outputs (gke_cluster_endpoint/gke_cluster_ca_certificate or generic cluster_endpoint/cluster_ca_certificate)")
	}
	if !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	return writeExecKubeconfig(
		clusterName,
		endpoint,
		ca,
		[]string{"kube-token", "--provider", "gcp"},
		stdout,
	)
}

func buildPubSubTopics(topics []types.ProjectTopicConfig, queues []types.ProjectQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]interface{}{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]interface{}{
				"name":                 s.Endpoint,
				"ack_deadline_seconds": 10,
			})
		}
		result[t.Name] = map[string]interface{}{
			"message_retention_duration": "86400s",
			"subscriptions":              subs,
		}
	}
	for _, q := range queues {
		ackDeadline := 10
		if q.VisibilityTimeout != nil {
			ackDeadline = *q.VisibilityTimeout
		}

		retention := "86400s"
		if q.MessageRetention != nil {
			retention = fmt.Sprintf("%ds", *q.MessageRetention)
		}

		subs := []map[string]interface{}{
			{"name": q.Name + "-sub", "ack_deadline_seconds": ackDeadline},
		}
		result[q.Name] = map[string]interface{}{
			"message_retention_duration": retention,
			"subscriptions":              subs,
		}
	}
	return result
}

// gcpMemorystoreRedisVersion maps a plain Redis version ("7.1", "6.2", "5") to the REDIS_x_y enum
// that the GCP template's memorystore_redis_version variable (and the google_redis_instance API)
// requires — a raw semver like "7.1" fails the apply. GCP offers REDIS_7_2, REDIS_7_0, REDIS_6_X,
// REDIS_5_0, REDIS_4_0, REDIS_3_2; a version with no exact enum snaps to the nearest lower one in
// its major (e.g. "7.1" -> REDIS_7_0). Returns "" for an empty or unmappable version, so the caller
// leaves the template default. An already-enum value ("REDIS_7_0") passes through unchanged.
func gcpMemorystoreRedisVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if strings.HasPrefix(v, "REDIS_") {
		return v
	}
	major := v
	minor := ""
	if i := strings.IndexByte(v, '.'); i >= 0 {
		major = v[:i]
		minor = v[i+1:]
	}
	switch major {
	case "7":
		// GCP has REDIS_7_2 and REDIS_7_0 (no 7_1) — 7.2+ -> 7_2, everything else in the 7 line -> 7_0.
		if len(minor) > 0 && minor[0] >= '2' {
			return "REDIS_7_2"
		}
		return "REDIS_7_0"
	case "6":
		return "REDIS_6_X"
	case "5":
		return "REDIS_5_0"
	case "4":
		return "REDIS_4_0"
	case "3":
		return "REDIS_3_2"
	default:
		return ""
	}
}

func buildFirestoreDatabases(tables []types.ProjectNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		entry := map[string]interface{}{
			"name":         t.Name,
			"billing_mode": ddbCapacityMode(string(t.CapacityMode)),
		}
		if t.PointInTimeRecovery {
			entry["point_in_time_recovery"] = true
		}
		result = append(result, entry)
	}
	return result
}

func buildGCPSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(secrets))
	for _, s := range secrets {
		result = append(result, map[string]interface{}{
			"name":          s.Name,
			"generate":      s.Generate,
			"length":        s.Length,
			"special_chars": s.SpecialChars,
		})
	}
	return result
}

func buildGCSBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		entry := map[string]interface{}{
			"name_suffix":    b.Name,
			"versioning":     b.Versioning,
			"uniform_access": !b.PublicAccess,
			"cors_origins":   b.CorsOrigins,
			"cors_methods":   []string{"GET", "PUT", "POST"},
		}
		result = append(result, entry)
	}
	return result
}

var _ CloudProvider = (*gcpProvider)(nil)
