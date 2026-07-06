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
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/eks"
)

type awsProvider struct{}

func (p *awsProvider) Name() string { return "aws" }

func (p *awsProvider) RequiredCLIs() []string {
	return []string{"aws-iam-authenticator", "kubectl", "helm"}
}

func (p *awsProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	enableKarpenter := false
	if v, ok := config.Cluster.ProviderConfig["enable_karpenter"]; ok {
		if b, ok := v.(bool); ok {
			enableKarpenter = b
		}
	}

	cloudfrontWaf := false
	acmCert := false
	appWaf := false
	if v, ok := config.DNS.ProviderConfig["cloudfront_waf"]; ok {
		if b, ok := v.(bool); ok {
			cloudfrontWaf = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["acm_certificate"]; ok {
		if b, ok := v.(bool); ok {
			acmCert = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["application_waf"]; ok {
		if b, ok := v.(bool); ok {
			appWaf = b
		}
	}

	provisionVPC := config.Network.ProvisionNetwork
	if !provisionVPC && config.Network.NetworkID == "" {
		provisionVPC = true
	}

	tfvars := map[string]interface{}{
		"project_name":   config.ProjectName,
		"region":         resolveRegion("aws", config.Region),
		"environment":    config.EnvironmentStage,
		"aws_account_id": config.CloudAccountID,

		// VPC
		"provision_vpc":          provisionVPC,
		"vpc_cidr":               orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"vpc_single_nat_gateway": config.Network.SingleNatGateway,

		// EKS
		"eks_cluster_version": orDefault(config.Cluster.ClusterVersion, "1.32"),
		"enable_karpenter":    enableKarpenter,
		"eks_cluster_admins":  ensureSlice(config.Cluster.ClusterAdmins),

		// DNS / WAF
		"dns_hosted_zone":               config.DNS.ZoneID,
		"dns_main_domain":               config.DNS.DomainName,
		"acm_certificate_enable":        acmCert,
		"cloudfront_waf_enabled":        cloudfrontWaf,
		"application_waf_enabled":       appWaf,
		"waf_webacl_cloudwatch_enabled": false,
		"waf_sampled_requests_enabled":  false,
		"waf_logging_enabled":           false,
		"waf_log_retention_days":        90,

		// SQS/SNS
		"provision_sqs": len(config.Queues) > 0 || len(config.Topics) > 0,
		"sqs_queues":    buildSQSQueues(config.Queues, config.Topics),
		"sns_topics":    buildSNSTopics(config.Topics),

		// Redis defaults
		"create_elasticache_redis":         len(config.Caches) > 0,
		"redis_cluster_size":               1,
		"redis_cluster_mode_enabled":       false,
		"redis_instance_type":              "cache.t3.micro",
		"redis_engine_version":             "7.1",
		"redis_family":                     "redis7",
		"redis_allowed_cidr_blocks":        []string{},
		"redis_allowed_security_group_ids": []string{},
		"redis_cloudwatch_logs_enabled":    false,

		// Secrets
		"custom_secrets": buildSecrets(config.Secrets),

		// DynamoDB
		"ddb_create":                     len(config.NosqlTables) > 0,
		"ddb_global_create":              hasGlobalTables(config.NosqlTables),
		"ddb_table_configuration":        buildDDBTables(config.NosqlTables, "standard"),
		"ddb_global_table_configuration": buildDDBTables(config.NosqlTables, "global"),

		// S3
		"s3_create":            len(config.StorageBuckets) > 0,
		"bucket_configuration": buildS3Buckets(config.StorageBuckets),

		// RDS
		"create_rds": len(config.Databases) > 0,
	}

	if len(config.Databases) > 0 {
		db := config.Databases[0]
		scalingConfig := map[string]interface{}{"min_capacity": 0.5, "max_capacity": 4.0}
		if db.MinCapacity != nil {
			scalingConfig["min_capacity"] = *db.MinCapacity
		}
		if db.MaxCapacity != nil {
			scalingConfig["max_capacity"] = *db.MaxCapacity
		}
		tfvars["rds_scaling_config"] = scalingConfig
		engine, version := resolveDBEngine("aws", db)
		tfvars["rds_config"] = map[string]interface{}{
			"engine":         orDefault(engine, "aurora-postgresql"),
			"engine_version": orDefault(version, "16.6"),
			"db_port":        derefIntOr(db.Port, 5432),
			"db_name":        db.Name,
		}
		if db.InstanceClass != "" {
			tfvars["rds_instance_type"] = db.InstanceClass
		}
		if db.BackupRetentionDays != nil {
			tfvars["rds_backup_retention_period"] = *db.BackupRetentionDays
		}
		if db.IamAuth != nil {
			tfvars["rds_iam_auth_enabled"] = *db.IamAuth
		}
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]
		tfvars["redis_instance_type"] = orDefault(
			resolveCacheNodeType("aws", cache),
			"cache.t3.medium",
		)
		if cache.EngineVersion != "" {
			tfvars["redis_engine_version"] = cache.EngineVersion
		}
		if cache.NumCacheNodes != nil {
			tfvars["redis_cluster_size"] = *cache.NumCacheNodes
		}
		if cache.MultiAz != nil {
			tfvars["redis_multi_az_enabled"] = *cache.MultiAz
		}
	}

	if inst := resolveInstanceTypes("aws", config.Cluster); len(inst) > 0 {
		tfvars["eks_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["eks_ng_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["eks_ng_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["eks_ng_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["eks_disk_size"] = *config.Cluster.NodeDiskSizeGB
	}

	// Generic passthrough: any provider_config key that names a template variable
	// flows through verbatim (e.g. eks_volume_iops, a CMEK key id, WAF rule list)
	// without a dedicated Go field. Reserved keys are consumed above under a
	// different tfvar name, so they aren't injected as undeclared duplicates.
	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig, "enable_karpenter")
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "cloudfront_waf", "acm_certificate", "application_waf")

	return tfvars
}

// mergeProviderConfig copies template-variable overrides from a component's
// provider_config JSONB into the flat tfvars map, WITHOUT clobbering keys already
// set by the typed mappings (merge-if-absent). This is the generic "passthrough"
// that lets the UI drive any template variable by name without a dedicated Go field
// per knob. `reserved` lists provider_config keys the typed code already consumed
// under a different tfvar name, so they are skipped (no undeclared-var duplicates).
func mergeProviderConfig(tfvars map[string]interface{}, pc map[string]any, reserved ...string) {
	if len(pc) == 0 {
		return
	}
	skip := make(map[string]bool, len(reserved))
	for _, r := range reserved {
		skip[r] = true
	}
	for k, v := range pc {
		if skip[k] {
			continue
		}
		if _, exists := tfvars[k]; !exists {
			tfvars[k] = v
		}
	}
}

func ensureSlice(s []interface{}) []interface{} {
	if s == nil {
		return []interface{}{}
	}
	return s
}

func orDefault(val, def string) string {
	if val != "" {
		return val
	}
	return def
}

// ddbCapacityMode translates the cloud-neutral capacity mode (on_demand /
// provisioned) to the DynamoDB-style value the IaC templates expect. Defaults to
// on-demand for empty/unknown input.
func ddbCapacityMode(mode string) string {
	if mode == "provisioned" {
		return "PROVISIONED"
	}
	return "PAY_PER_REQUEST"
}

// providerInt reads an int from a provider_config JSONB map (JSON numbers
// decode as float64). Returns false when absent or non-numeric.
func providerInt(cfg map[string]any, key string) (int, bool) {
	if cfg == nil {
		return 0, false
	}
	switch v := cfg[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

// s3SSEAlgorithm resolves the S3 server-side-encryption algorithm from the
// bucket's provider_config (encryption_algorithm), defaulting to AES256 when
// encryption is enabled.
func s3SSEAlgorithm(b types.ProjectStorageBucketConfig) string {
	if b.ProviderConfig != nil {
		if v, ok := b.ProviderConfig["encryption_algorithm"].(string); ok && v != "" {
			return v
		}
	}
	return "AES256"
}

func derefIntOr(p *int, def int) int {
	if p != nil {
		return *p
	}
	return def
}

func buildSQSQueues(queues []types.ProjectQueueConfig, topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		cfg := map[string]interface{}{
			"fifo_queue": false,
			"dlq_enable": false,
		}
		if q.Ordered != nil {
			cfg["fifo_queue"] = *q.Ordered
		}
		if q.VisibilityTimeout != nil {
			cfg["visibility_timeout_seconds"] = *q.VisibilityTimeout
		}
		if q.MessageRetention != nil {
			cfg["message_retention_seconds"] = *q.MessageRetention
		}
		if d, ok := providerInt(q.ProviderConfig, "delay_seconds"); ok {
			cfg["delay_seconds"] = d
		}
		result[q.Name] = cfg
	}
	return result
}

func buildSNSTopics(topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]string{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]string{
				"protocol": s.Protocol,
				"endpoint": s.Endpoint,
			})
		}
		result[t.Name] = map[string]interface{}{
			"subscriptions": subs,
		}
	}
	return result
}

func (p *awsProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no EKS cluster name in outputs")
	}
	fmt.Fprintf(stdout, "Configuring kubeconfig for EKS cluster %s...\n", clusterName)

	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.Region))
	if err != nil {
		return fmt.Errorf("failed to load AWS config: %w", err)
	}
	eksClient := eks.NewFromConfig(cfg)
	resp, err := eksClient.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: &clusterName})
	if err != nil {
		return fmt.Errorf("failed to describe cluster: %w", err)
	}

	cluster := resp.Cluster
	// Write under an absolute, HOME-based path (not the cwd-relative "temp/") so that
	// concurrent worker subprocesses — which share a cwd but each have a private HOME —
	// never read each other's kubeconfig. See dataroom/spec/mvp/21 §5 (concurrent slots).
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	kubeDir := filepath.Join(home, ".alethia")
	kubeconfigPath := filepath.Join(kubeDir, "kubeconfig")
	kubeconfig := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- cluster:
    server: %s
    certificate-authority-data: %s
  name: %s
contexts:
- context:
    cluster: %s
    user: %s
  name: %s
current-context: %s
users:
- name: %s
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws-iam-authenticator
      args: ["token", "-i", "%s", "--region", "%s"]
`, *cluster.Endpoint, *cluster.CertificateAuthority.Data,
		*cluster.Arn, *cluster.Arn, *cluster.Arn, *cluster.Arn, *cluster.Arn, *cluster.Arn,
		clusterName, config.Region)

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

func buildSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(secrets))
	for _, s := range secrets {
		entry := map[string]interface{}{
			"secret_name": s.Name,
		}
		if s.Generate {
			entry["length"] = s.Length
			entry["special"] = s.SpecialChars
		} else {
			entry["manual"] = true
		}
		result = append(result, entry)
	}
	return result
}

func hasGlobalTables(tables []types.ProjectNosqlConfig) bool {
	for _, t := range tables {
		if t.TableType == "global" {
			return true
		}
	}
	return false
}

func buildDDBTables(tables []types.ProjectNosqlConfig, tableType string) []map[string]interface{} {
	result := []map[string]interface{}{}
	for _, t := range tables {
		if t.TableType != tableType {
			continue
		}
		entry := map[string]interface{}{
			"table_name_suffix":             t.Name,
			"hash_key":                      t.PartitionKey,
			"hash_key_type":                 orDefault(t.PartitionKeyType, "S"),
			"range_key":                     t.SortKey,
			"range_key_type":                orDefault(t.SortKeyType, "S"),
			"billing_mode":                  ddbCapacityMode(t.CapacityMode),
			"enable_point_in_time_recovery": t.PointInTimeRecovery,
		}
		result = append(result, entry)
	}
	return result
}

func buildS3Buckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		blockPublic := !b.PublicAccess
		cors := []map[string]interface{}{}
		if len(b.CorsOrigins) > 0 {
			cors = append(cors, map[string]interface{}{
				"allowed_headers": []string{"*"},
				"allowed_methods": []string{"GET", "PUT", "POST"},
				"allowed_origins": b.CorsOrigins,
				"expose_headers":  []string{},
				"max_age_seconds": 3600,
			})
		}
		result = append(result, map[string]interface{}{
			"bucket_name_suffix":      b.Name,
			"acl_type":                "private",
			"create_s3_user":          false,
			"versioning_enabled":      b.Versioning,
			"sse_algorithm":           s3SSEAlgorithm(b),
			"store_access_key_in_ssm": false,
			"block_public_acls":       blockPublic,
			"block_public_policy":     blockPublic,
			"ignore_public_acls":      blockPublic,
			"restrict_public_buckets": blockPublic,
			"cors_configuration":      cors,
		})
	}
	return result
}

var _ CloudProvider = (*awsProvider)(nil)
