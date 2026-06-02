package cloud

import (
	"context"
	"fmt"
	"io"
	"os"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
)

type awsProvider struct{}

func (p *awsProvider) Name() string { return "aws" }

func (p *awsProvider) RequiredCLIs() []string {
	return []string{"aws-iam-authenticator", "kubectl", "helm"}
}

func (p *awsProvider) ProviderTfvars(config *types.VineConfig) map[string]interface{} {
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
		"region":         config.Region,
		"environment":    config.EnvironmentStage,
		"aws_account_id": config.CloudAccountID,

		// VPC
		"provision_vpc":           provisionVPC,
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
		"ddb_create":                      len(config.NosqlTables) > 0,
		"ddb_global_create":               hasGlobalTables(config.NosqlTables),
		"ddb_table_configuration":         buildDDBTables(config.NosqlTables, "standard"),
		"ddb_global_table_configuration":  buildDDBTables(config.NosqlTables, "global"),

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
		tfvars["rds_config"] = map[string]interface{}{
			"engine":         orDefault(db.Engine, "aurora-postgresql"),
			"engine_version": orDefault(db.EngineVersion, "16.6"),
			"db_port":        derefIntOr(db.Port, 5432),
			"db_name":        db.Name,
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
		if cache.NodeType != "" {
			tfvars["redis_instance_type"] = cache.NodeType
		}
		if cache.NumCacheNodes != nil {
			tfvars["redis_cluster_size"] = *cache.NumCacheNodes
		}
		if cache.MultiAz != nil {
			tfvars["redis_multi_az_enabled"] = *cache.MultiAz
		}
	}

	if len(config.Cluster.InstanceTypes) > 0 {
		tfvars["eks_instance_types"] = config.Cluster.InstanceTypes
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

	return tfvars
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

func derefIntOr(p *int, def int) int {
	if p != nil {
		return *p
	}
	return def
}

func buildSQSQueues(queues []types.VineQueueConfig, topics []types.VineTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		cfg := map[string]interface{}{
			"fifo_queue": false,
			"dlq_enable": false,
		}
		if q.Fifo != nil {
			cfg["fifo_queue"] = *q.Fifo
		}
		if q.VisibilityTimeout != nil {
			cfg["visibility_timeout_seconds"] = *q.VisibilityTimeout
		}
		if q.MessageRetention != nil {
			cfg["message_retention_seconds"] = *q.MessageRetention
		}
		if q.DelaySeconds != nil {
			cfg["delay_seconds"] = *q.DelaySeconds
		}
		result[q.Name] = cfg
	}
	return result
}

func buildSNSTopics(topics []types.VineTopicConfig) map[string]interface{} {
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

func (p *awsProvider) ConfigureKubeconfig(ctx context.Context, config *types.VineConfig, outputs map[string]interface{}, stdout io.Writer) error {
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
	kubeconfigPath := "temp/kubeconfig"
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

	if err := os.MkdirAll("temp", 0755); err != nil {
		return err
	}
	if err := os.WriteFile(kubeconfigPath, []byte(kubeconfig), 0600); err != nil {
		return err
	}
	os.Setenv("KUBECONFIG", kubeconfigPath)
	fmt.Fprintf(stdout, "Kubeconfig written to %s\n", kubeconfigPath)
	return nil
}

func buildSecrets(secrets []types.VineSecretConfig) []map[string]interface{} {
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

func hasGlobalTables(tables []types.VineNosqlConfig) bool {
	for _, t := range tables {
		if t.TableType == "global" {
			return true
		}
	}
	return false
}

func buildDDBTables(tables []types.VineNosqlConfig, tableType string) []map[string]interface{} {
	result := []map[string]interface{}{}
	for _, t := range tables {
		if t.TableType != tableType {
			continue
		}
		entry := map[string]interface{}{
			"table_name_suffix":             t.Name,
			"hash_key":                      t.HashKey,
			"hash_key_type":                 orDefault(t.HashKeyType, "S"),
			"range_key":                     t.RangeKey,
			"range_key_type":                orDefault(t.RangeKeyType, "S"),
			"billing_mode":                  orDefault(t.BillingMode, "PAY_PER_REQUEST"),
			"enable_point_in_time_recovery": t.PointInTimeRecovery,
		}
		result = append(result, entry)
	}
	return result
}

var _ CloudProvider = (*awsProvider)(nil)

