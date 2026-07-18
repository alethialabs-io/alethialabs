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

func (p *alibabaProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	managedCert := false
	if v, ok := config.DNS.ProviderConfig["managed_certificate"]; ok {
		if b, ok := v.(bool); ok {
			managedCert = b
		}
	}
	wafEnabled := false
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
		"ack_cluster_version": config.Cluster.ClusterVersion,

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

		// Container Registry (ACR)
		"provision_cr": len(config.ContainerRegistries) > 0,

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

// ConfigureKubeconfig writes the kubeconfig the ACK OpenTofu run emitted (a sensitive output) to a
// per-worker HOME path and points KUBECONFIG at it — no cloud API call needed.
func (p *alibabaProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	kubeconfig := alibabaOutputString(outputs, "kubeconfig")
	if kubeconfig == "" {
		return fmt.Errorf("no kubeconfig in ACK outputs")
	}
	fmt.Fprintf(stdout, "Writing ACK kubeconfig for cluster %s...\n", ExtractClusterName(outputs))

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
				"protocol": s.Protocol,
				"endpoint": s.Endpoint,
			})
		}
		result[t.Name] = map[string]interface{}{"subscriptions": subs}
	}
	return result
}

func buildOTSTables(tables []types.ProjectNosqlConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tables))
	for _, t := range tables {
		entry := map[string]interface{}{
			"name":             t.Name,
			"primary_key":      t.PartitionKey,
			"primary_key_type": otsKeyType(string(t.PartitionKeyType)),
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

func buildOSSBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		acl := "private"
		if b.PublicAccess {
			acl = "public-read"
		}
		entry := map[string]interface{}{
			"name_suffix":  b.Name,
			"acl":          acl,
			"versioning":   b.Versioning,
			"cors_origins": b.CorsOrigins,
		}
		result = append(result, entry)
	}
	return result
}

func buildAlibabaSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
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

var _ CloudProvider = (*alibabaProvider)(nil)
