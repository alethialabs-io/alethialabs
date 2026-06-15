// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

type VineConfig struct {
	ID               string `json:"id"`
	VineyardID       string `json:"vineyard_id"`
	UserID           string `json:"user_id"`
	ProjectName      string `json:"project_name"`
	EnvironmentStage string `json:"environment_stage"`
	Region           string `json:"region"`
	TerraformVersion string `json:"terraform_version"`
	CloudIdentityID  string `json:"cloud_identity_id"`
	Provider         string `json:"provider"`

	Network      VineNetworkConfig      `json:"network"`
	Cluster      VineClusterConfig      `json:"cluster"`
	DNS          VineDNSConfig          `json:"dns"`
	Repositories VineRepositoriesConfig `json:"repositories"`

	Databases           []VineDatabaseConfig          `json:"databases"`
	Caches              []VineCacheConfig              `json:"caches"`
	Queues              []VineQueueConfig              `json:"queues"`
	Topics              []VineTopicConfig              `json:"topics"`
	NosqlTables         []VineNosqlConfig              `json:"nosql_tables"`
	Secrets             []VineSecretConfig             `json:"secrets"`
	ContainerRegistries []VineContainerRegistryConfig  `json:"container_registries"`
	StorageBuckets      []VineStorageBucketConfig      `json:"storage_buckets"`

	GitAccessToken string `json:"git_access_token"`

	// Populated at runtime from CloudIdentity, not from snapshot
	CloudAccountID string `json:"-"`
}

type VineNetworkConfig struct {
	ProvisionNetwork bool   `json:"provision_network"`
	CIDRBlock        string `json:"cidr_block"`
	NetworkID        string `json:"network_id"`
	SingleNatGateway bool   `json:"single_nat_gateway"`
}

type VineClusterConfig struct {
	ClusterVersion string         `json:"cluster_version"`
	InstanceTypes  []string       `json:"instance_types"`
	NodeMinSize    int            `json:"node_min_size"`
	NodeMaxSize    int            `json:"node_max_size"`
	NodeDesiredSize int           `json:"node_desired_size"`
	ClusterAdmins  []interface{}  `json:"cluster_admins"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type VineDNSConfig struct {
	Enabled        bool           `json:"enabled"`
	ZoneID         string         `json:"zone_id"`
	DomainName     string         `json:"domain_name"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type VineRepositoriesConfig struct {
	AppsDestinationRepo string `json:"apps_destination_repo"`
}

type VineDatabaseConfig struct {
	Name                string   `json:"name"`
	Engine              string   `json:"engine"`
	EngineVersion       string   `json:"engine_version"`
	MinCapacity         *float64 `json:"min_capacity"`
	MaxCapacity         *float64 `json:"max_capacity"`
	Port                *int     `json:"port"`
	BackupRetentionDays *int     `json:"backup_retention_days"`
	IamAuth             *bool    `json:"iam_auth"`
}

type VineCacheConfig struct {
	Name          string `json:"name"`
	Engine        string `json:"engine"`
	NodeType      string `json:"node_type"`
	NumCacheNodes *int   `json:"num_cache_nodes"`
	MultiAz       *bool  `json:"multi_az"`
}

type VineQueueConfig struct {
	Name              string `json:"name"`
	Fifo              *bool  `json:"fifo"`
	VisibilityTimeout *int   `json:"visibility_timeout"`
	MessageRetention  *int   `json:"message_retention"`
	DelaySeconds      *int   `json:"delay_seconds"`
}

type VineTopicConfig struct {
	Name          string              `json:"name"`
	Subscriptions []TopicSubscription `json:"subscriptions"`
}

type TopicSubscription struct {
	Protocol string `json:"protocol"`
	Endpoint string `json:"endpoint"`
}

type VineNosqlConfig struct {
	Name                string `json:"name"`
	HashKey             string `json:"hash_key"`
	HashKeyType         string `json:"hash_key_type"`
	RangeKey            string `json:"range_key"`
	RangeKeyType        string `json:"range_key_type"`
	TableType           string `json:"table_type"`
	BillingMode         string `json:"billing_mode"`
	PointInTimeRecovery bool   `json:"point_in_time_recovery"`
}

type VineSecretConfig struct {
	Name         string `json:"name"`
	Generate     bool   `json:"generate"`
	Length       int    `json:"length"`
	SpecialChars bool   `json:"special_chars"`
}

type VineContainerRegistryConfig struct {
	Name               string `json:"name"`
	ImageTagMutability string `json:"image_tag_mutability"`
	ScanOnPush         *bool  `json:"scan_on_push"`
}

type VineStorageBucketConfig struct {
	Name         string   `json:"name"`
	Versioning   bool     `json:"versioning"`
	Encryption   string   `json:"encryption"`
	PublicAccess bool     `json:"public_access"`
	CorsOrigins  []string `json:"cors_origins"`
}
