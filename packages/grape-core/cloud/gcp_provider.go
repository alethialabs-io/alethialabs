package cloud

import (
	"context"
	"fmt"
	"io"
	"os/exec"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
)

type gcpProvider struct{}

func (p *gcpProvider) Name() string { return "gcp" }

func (p *gcpProvider) RequiredCLIs() []string {
	return []string{"gcloud", "kubectl", "helm"}
}

func (p *gcpProvider) ProviderTfvars(config *types.VineConfig) map[string]interface{} {
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
		"region":       config.Region,
		"environment":  config.EnvironmentStage,

		// Network
		"provision_network": provisionNetwork,
		"network_cidr":      orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_cloud_nat":  config.Network.SingleNatGateway,

		// GKE
		"provision_gke":       true,
		"gke_cluster_version": orDefault(config.Cluster.ClusterVersion, "1.31"),
		"gke_enable_autopilot": enableAutopilot,

		// DNS
		"cloud_dns_enabled":             config.DNS.Enabled,
		"cloud_dns_domain":              config.DNS.DomainName,
		"cloud_dns_zone_name":           config.DNS.ZoneID,
		"cloud_dns_managed_certificate": managedCert,

		// Cloud Armor
		"cloud_armor_enabled": cloudArmorEnabled,

		// Pub/Sub
		"create_pubsub":  len(config.Queues) > 0 || len(config.Topics) > 0,
		"pubsub_topics":  buildPubSubTopics(config.Topics, config.Queues),

		// Memorystore
		"create_memorystore": len(config.Caches) > 0,

		// Firestore
		"create_firestore": len(config.NosqlTables) > 0,

		// Artifact Registry
		"provision_artifact_registry": false,

		// Cloud Storage
		"create_cloud_storage": false,

		// Secrets
		"custom_secrets": buildGCPSecrets(config.Secrets),

		// Cloud SQL
		"create_cloud_sql": len(config.Databases) > 0,
	}

	if len(config.Databases) > 0 {
		db := config.Databases[0]
		engine := "POSTGRES"
		if db.Engine == "mysql" || db.Engine == "aurora-mysql" {
			engine = "MYSQL"
		}
		tfvars["cloud_sql_engine"] = engine
		if db.EngineVersion != "" {
			tfvars["cloud_sql_engine_version"] = db.EngineVersion
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
	}

	if len(config.Cluster.InstanceTypes) > 0 {
		tfvars["gke_instance_types"] = config.Cluster.InstanceTypes
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

	if !provisionNetwork && config.Network.NetworkID != "" {
		tfvars["network_id"] = config.Network.NetworkID
	}

	return tfvars
}

func (p *gcpProvider) ConfigureKubeconfig(ctx context.Context, config *types.VineConfig, outputs map[string]interface{}, stdout io.Writer) error {
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

func buildPubSubTopics(topics []types.VineTopicConfig, queues []types.VineQueueConfig) map[string]interface{} {
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
			"subscriptions":             subs,
		}
	}
	for _, q := range queues {
		subs := []map[string]interface{}{
			{"name": q.Name + "-sub", "ack_deadline_seconds": 10},
		}
		result[q.Name] = map[string]interface{}{
			"message_retention_duration": "86400s",
			"subscriptions":             subs,
		}
	}
	return result
}

func buildGCPSecrets(secrets []types.VineSecretConfig) []map[string]interface{} {
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

var _ CloudProvider = (*gcpProvider)(nil)
