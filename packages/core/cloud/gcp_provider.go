// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"os/exec"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type gcpProvider struct{}

func (p *gcpProvider) Name() string { return "gcp" }

func (p *gcpProvider) RequiredCLIs() []string {
	return []string{"gcloud", "kubectl", "helm"}
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
		"gke_cluster_version":  orDefault(config.Cluster.ClusterVersion, "1.31"),
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

		// Firestore
		"create_firestore":    len(config.NosqlTables) > 0,
		"firestore_databases": buildFirestoreDatabases(config.NosqlTables),

		// Artifact Registry
		// TODO: enable when ProjectConfig gains a ContainerRegistries field
		// "provision_artifact_registry": len(config.ContainerRegistries) > 0,
		"provision_artifact_registry": false,

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
		if cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1 {
			tfvars["memorystore_tier"] = "STANDARD_HA"
		}
		if cache.Engine != "" {
			tfvars["memorystore_engine"] = cache.Engine
		}
		if cache.EngineVersion != "" {
			tfvars["memorystore_redis_version"] = cache.EngineVersion
		}
		if nt := resolveCacheNodeType("gcp", cache); nt != "" {
			tfvars["memorystore_instance_type"] = nt
		}
		if cache.MultiAz != nil {
			tfvars["memorystore_multi_az"] = *cache.MultiAz
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

	projectID := config.CloudAccountID

	args := []string{"container", "clusters", "get-credentials", clusterName, "--region", config.Region}
	if projectID != "" {
		args = append(args, "--project", projectID)
	}

	cmd := exec.CommandContext(ctx, "gcloud", args...)
	cmd.Stdout = stdout
	cmd.Stderr = stdout
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("gcloud get-credentials failed: %w", err)
	}

	fmt.Fprintf(stdout, "Kubeconfig configured for GKE cluster %s\n", clusterName)
	return nil
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

func buildFirestoreDatabases(tables []types.ProjectNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		entry := map[string]interface{}{
			"name":         t.Name,
			"billing_mode": ddbCapacityMode(t.CapacityMode),
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
