package types

import "time"

type ConfigurationSummary struct {
	ID string `json:"id"`
	// Name             string    `json:"name"`
	ProjectName       string    `json:"project_name"`
	VineyardID        *string   `json:"vineyard_id"`
	EnvironmentStage  string    `json:"environment_stage"`
	ContainerPlatform string    `json:"container_platform"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type Configuration struct {
	AwsAccountID            string    `json:"aws_account_id"`
	AwsRegion               string    `json:"aws_region"`
	ContainerPlatform       string    `json:"container_platform"`
	CreateVpc               *bool     `json:"create_vpc"`
	CreatedAt               time.Time `json:"created_at"`
	DbMaxCapacity           *float64  `json:"db_max_capacity"`
	DbMinCapacity           *float64  `json:"db_min_capacity"`
	Description             *string   `json:"description"`
	DnsDomainName           *string   `json:"dns_domain_name"`
	DnsHostedZone           *string   `json:"dns_hosted_zone"`
	DownloadCount           *int      `json:"download_count"`
	EksClusterAdmins        *string   `json:"eks_cluster_admins"`
	EnableCloudfrontWaf     *bool     `json:"enable_cloudfront_waf"`
	EnableDns               *bool     `json:"enable_dns"`
	EnableGitopsDestination *bool     `json:"enable_gitops_destination"`
	EnableKarpenter         *bool     `json:"enable_karpenter"`
	EnableRedis             *bool     `json:"enable_redis"`
	EnvironmentRepository   *string   `json:"environment_repository"`
	EnvironmentStage        string    `json:"environment_stage"`
	FullConfig              *string   `json:"full_config"`
	GitopsAppTemplate       *string   `json:"gitops_app_template"`
	GitopsAppToken          *string   `json:"gitops_app_token"`
	GitopsArgocdToken       *string   `json:"gitops_argocd_token"`
	GitopsDestinationsRepo  *string   `json:"gitops_destinations_repo"`
	GitopsRepository        *string   `json:"gitops_repository"`
	
	// Repository fields expected by deploy command
	EnvTemplateRepo                 string `json:"env_template_repo"`
	EnvTemplateRepoBranch           string `json:"env_template_repo_branch"`
	EnvGitRepo                      string `json:"env_git_repo"`
	GitopsTemplateRepo              string `json:"gitops_template_repo"`
	GitopsTemplateRepoBranch        string `json:"gitops_template_repo_branch"`
	GitopsDestinationRepo           string `json:"gitops_destination_repo"`
	ApplicationsTemplateRepo        string `json:"applications_template_repo"`
	ApplicationsTemplateRepoBranch  string `json:"applications_template_repo_branch"`
	ApplicationsDestinationRepo     string `json:"applications_destination_repo"`

	ID                      string    `json:"id"`
	LastDownloadedAt        *string   `json:"last_downloaded_at"`
	// Name                    string    `json:"name"`
	ProjectName            string    `json:"project_name"`
	VineyardID             *string   `json:"vineyard_id"`
	RedisAllowedCidrBlocks *string   `json:"redis_allowed_cidr_blocks"`
	SesQueuesTopics        *string   `json:"ses_queues_topics"`
	Status                 *string   `json:"status"`
	TerraformVersion       string    `json:"terraform_version"`
	UiPositionX            *float64  `json:"ui_position_x"`
	UiPositionY            *float64  `json:"ui_position_y"`
	UpdatedAt              time.Time `json:"updated_at"`
	UserID                 string    `json:"user_id"`
	VpcCidr                *string   `json:"vpc_cidr"`
}

type Harvest struct {
	ID                string     `json:"id"`
	ClusterID         string     `json:"cluster_id"`
	ConfigurationID   string     `json:"configuration_id"`
	Status            string     `json:"status"`
	CreatedAt         time.Time  `json:"created_at"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	CompletedAt       *time.Time `json:"completed_at,omitempty"`
	ErrorMessage      *string    `json:"error_message,omitempty"`
}
