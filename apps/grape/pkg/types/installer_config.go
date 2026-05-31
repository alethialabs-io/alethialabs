package types

type InstallerConfig struct {
	Raw map[string]interface{} `yaml:"-"`

	// Core (mandatory)
	ProjectName  string `yaml:"project_name"   validate:"required,max=25"`
	Region       string `yaml:"region"         validate:"required"`
	Environment  string `yaml:"environment"    validate:"required,max=15"`
	AwsAccountID string `yaml:"aws_account_id" validate:"required"`
	TerraformVer string `yaml:"terraform_ver"  validate:"required"`

	// Git repositories
	EnvTemplateRepo                string `yaml:"env_template_repo"                validate:"required"`
	EnvTemplateRepoBranch          string `yaml:"env_template_repo_branch"         validate:"required"`
	EnvGitRepo                     string `yaml:"env_git_repo"                     validate:"required"`
	GitopsTemplateRepo             string `yaml:"gitops_template_repo"             validate:"required"`
	GitopsTemplateRepoBranch       string `yaml:"gitops_template_repo_branch"`
	GitopsDestinationRepo          string `yaml:"gitops_destination_repo"          validate:"required"`
	GitopsArgoAccessToken          string `yaml:"gitops_argo_access_token"`
	ApplicationsTemplateRepo       string `yaml:"applications_template_repo"`
	ApplicationsTemplateRepoBranch string `yaml:"applications_template_repo_branch"`
	ApplicationsDestinationRepo    string `yaml:"applications_destination_repo"`
	ApplicationsArgoAccessToken    string `yaml:"applications_argo_access_token"`

	// VPC
	ProvisionVPC        *bool  `yaml:"provision_vpc"`
	VPCCIDR             string `yaml:"vpc_cidr"               validate:"omitempty,cidrv4"`
	VPCSingleNATGateway *bool  `yaml:"vpc_single_nat_gateway"`

	// DNS
	DNSHostedZone        string `yaml:"dns_hosted_zone"`
	DNSMainDomain        string `yaml:"dns_main_domain"`
	ACMCertificateEnable *bool  `yaml:"acm_certificate_enable"`

	// Database
	CreateRDS        *bool                  `yaml:"create_rds"`
	RDSScalingConfig map[string]interface{} `yaml:"rds_scaling_config"`

	// Redis
	CreateElasticacheRedis *bool    `yaml:"create_elasticache_redis"`
	RedisAllowedCidrBlocks []string `yaml:"redis_allowed_cidr_blocks" validate:"omitempty,dive,cidrv4"`

	// EKS
	EKSClusterVersion string                 `yaml:"eks_cluster_version"`
	EKSClusterAdmins  []EKSClusterAdmin      `yaml:"eks_cluster_admins"`
	EKSAccessEntries  map[string]interface{} `yaml:"eks_access_entries"`
	EKSNgMinSize      *int                   `yaml:"eks_ng_min_size"      validate:"omitempty,gte=1"`
	EKSNgDesiredSize  *int                   `yaml:"eks_ng_desired_size"  validate:"omitempty,gte=1"`
	EKSNgMaxSize      *int                   `yaml:"eks_ng_max_size"      validate:"omitempty,gte=1"`

	// Feature flags
	EnableKarpenter       *bool `yaml:"enable_karpenter"`
	ProvisionECR          *bool `yaml:"provision_ecr"`
	EnableFluentBit       *bool `yaml:"enable_fluent_bit"`
	BackstageEnabled      *bool `yaml:"backstage_enabled"`
	EnableDevlake         *bool `yaml:"enable_devlake"`
	EnablePrometheusStack *bool `yaml:"enable_prometheus_stack"`
	EnableTempo           *bool `yaml:"enable_tempo"`
	EnableLoki            *bool `yaml:"enable_loki"`
	EnableKyverno         *bool `yaml:"enable_kyverno"`
	EnableKyvernoPolicies *bool `yaml:"enable_kyverno_policies"`
	EnablePolicyReporter  *bool `yaml:"enable_policy_reporter"`
	ExternalDNSEnabled    *bool `yaml:"external_dns_enabled"`
	EnableMetricsServer   *bool `yaml:"enabled_metrics_server"`
	EnableVPA             *bool `yaml:"enable_vpa"`

	// WAF
	ApplicationWAFEnabled *bool `yaml:"application_waf_enabled"`
	CloudfrontWAFEnabled  *bool `yaml:"cloudfront_waf_enabled"`

	// SQS
	ProvisionSQS *bool `yaml:"provision_sqs"`

	// Naming
	AllowLongNames *bool `yaml:"allow_long_names"`

	// Secrets
	CustomSecrets []CustomSecret `yaml:"custom_secrets"`

	// Messaging
	SESQueuesTopics map[string]interface{} `yaml:"ses_queues_topics"`

	// Backstage
	BackstageImageRegistry   string `yaml:"backstage_image_registry"`
	BackstageImageRepository string `yaml:"backstage_image_repository"`
	BackstageImageTag        string `yaml:"backstage_image_tag"`

	// DynamoDB
	DDBCreate                  *bool                    `yaml:"ddb_create"`
	DDBTableConfiguration     []map[string]interface{} `yaml:"ddb_table_configuration"`
	DDBGlobalCreate            *bool                    `yaml:"ddb_global_create"`
	DDBGlobalTableConfig       []map[string]interface{} `yaml:"ddb_global_table_configuration"`

	// Allowed CIDR blocks
	AllowedCidrBlocks []string `yaml:"allowed_cidr_blocks" validate:"omitempty,dive,cidrv4"`
}
