package cloud

import (
	"context"
	"fmt"
	"io"
	"os/exec"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
)

type azureProvider struct{}

func (p *azureProvider) Name() string { return "azure" }

func (p *azureProvider) RequiredCLIs() []string {
	return []string{"az", "kubectl", "helm"}
}

func (p *azureProvider) ProviderTfvars(config *types.VineConfig) map[string]interface{} {
	wafEnabled := false
	managedCert := false
	if v, ok := config.DNS.ProviderConfig["azure_waf"]; ok {
		if b, ok := v.(bool); ok {
			wafEnabled = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["managed_certificate"]; ok {
		if b, ok := v.(bool); ok {
			managedCert = b
		}
	}

	provisionVnet := config.Network.ProvisionNetwork
	if !provisionVnet && config.Network.NetworkID == "" {
		provisionVnet = true
	}

	tfvars := map[string]interface{}{
		"project_name":    config.ProjectName,
		"subscription_id": config.CloudAccountID,
		"location":        config.Region,
		"environment":     config.EnvironmentStage,

		// Network
		"provision_vnet":    provisionVnet,
		"vnet_cidr":         orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_nat_gateway": config.Network.SingleNatGateway,

		// AKS
		"provision_aks":       true,
		"aks_cluster_version": orDefault(config.Cluster.ClusterVersion, "1.31"),

		// DNS
		"azure_dns_enabled": config.DNS.Enabled,
		"azure_dns_domain":  config.DNS.DomainName,
		"azure_dns_zone_name": config.DNS.ZoneID,

		// WAF
		"azure_waf_enabled": wafEnabled,

		// TLS
		"azure_managed_certificate": managedCert,

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
		engine := "postgres"
		if db.Engine == "mysql" || db.Engine == "aurora-mysql" {
			engine = "mysql"
		}
		tfvars["azure_db_engine"] = engine
		if db.EngineVersion != "" {
			tfvars["azure_db_engine_version"] = db.EngineVersion
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
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]
		if cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1 {
			tfvars["azure_cache_sku"] = "Standard"
		}
		if cache.MultiAz != nil {
			tfvars["azure_cache_multi_az"] = *cache.MultiAz
		}
	}

	if len(config.Cluster.InstanceTypes) > 0 {
		tfvars["aks_instance_types"] = config.Cluster.InstanceTypes
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

	if !provisionVnet && config.Network.NetworkID != "" {
		tfvars["vnet_id"] = config.Network.NetworkID
	}

	return tfvars
}

func (p *azureProvider) ConfigureKubeconfig(ctx context.Context, config *types.VineConfig, outputs map[string]interface{}, stdout io.Writer) error {
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no AKS cluster name in outputs")
	}

	rgName := extractOutputString(outputs, "resource_group_name")
	if rgName == "" {
		rgName = fmt.Sprintf("rg-%s-%s", config.ProjectName, config.EnvironmentStage)
	}

	fmt.Fprintf(stdout, "Configuring kubeconfig for AKS cluster %s (rg: %s)...\n", clusterName, rgName)

	cmd := exec.CommandContext(ctx, "az", "aks", "get-credentials",
		"--resource-group", rgName,
		"--name", clusterName,
		"--overwrite-existing",
	)
	cmd.Stdout = stdout
	cmd.Stderr = stdout
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("az aks get-credentials failed: %w", err)
	}

	fmt.Fprintf(stdout, "Kubeconfig configured for AKS cluster %s\n", clusterName)
	return nil
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

func buildServiceBusQueues(queues []types.VineQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		cfg := map[string]interface{}{
			"max_delivery_count": 10,
			"lock_duration":      "PT1M",
		}
		if q.Fifo != nil {
			cfg["requires_session"] = *q.Fifo
		}
		if q.VisibilityTimeout != nil {
			cfg["lock_duration"] = fmt.Sprintf("PT%dS", *q.VisibilityTimeout)
		}
		if q.MessageRetention != nil {
			cfg["default_message_ttl"] = fmt.Sprintf("PT%dS", *q.MessageRetention)
		}
		if q.DelaySeconds != nil {
			cfg["forward_dead_lettered_messages_to"] = ""
			cfg["max_delivery_count"] = 10
			// Azure Service Bus doesn't have a direct delay_seconds equivalent,
			// but we can pass it for scheduled enqueue support
			cfg["delay_seconds"] = *q.DelaySeconds
		}
		result[q.Name] = cfg
	}
	return result
}

func buildServiceBusTopics(topics []types.VineTopicConfig) map[string]interface{} {
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

func buildCosmosDBCollections(tables []types.VineNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		entry := map[string]interface{}{
			"name":          t.Name,
			"partition_key": orDefault(t.HashKey, "/id"),
			"billing_mode":  orDefault(t.BillingMode, "PAY_PER_REQUEST"),
		}
		if t.PointInTimeRecovery {
			entry["analytical_storage_enabled"] = true
		}
		result = append(result, entry)
	}
	return result
}

func buildAzureContainers(buckets []types.VineStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		accessType := "private"
		if b.PublicAccess {
			accessType = "blob"
		}
		result = append(result, map[string]interface{}{
			"name":                 b.Name,
			"container_access_type": accessType,
		})
	}
	return result
}

var _ CloudProvider = (*azureProvider)(nil)
