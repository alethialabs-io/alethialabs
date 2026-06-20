// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

type SpecConfig struct {
	ID               string `json:"id"`
	ZoneID           string `json:"zone_id"`
	UserID           string `json:"user_id"`
	ProjectName      string `json:"project_name"`
	EnvironmentStage string `json:"environment_stage"`
	Region           string `json:"region"`
	IacVersion       string `json:"iac_version"`
	CloudIdentityID  string `json:"cloud_identity_id"`
	Provider         string `json:"provider"`

	Network       SpecNetworkConfig       `json:"network"`
	Cluster       SpecClusterConfig       `json:"cluster"`
	DNS           SpecDNSConfig           `json:"dns"`
	Observability SpecObservabilityConfig `json:"observability"`
	Repositories  SpecRepositoriesConfig  `json:"repositories"`

	Databases           []SpecDatabaseConfig          `json:"databases"`
	Caches              []SpecCacheConfig             `json:"caches"`
	Queues              []SpecQueueConfig             `json:"queues"`
	Topics              []SpecTopicConfig             `json:"topics"`
	NosqlTables         []SpecNosqlConfig             `json:"nosql_tables"`
	Secrets             []SpecSecretConfig            `json:"secrets"`
	ContainerRegistries []SpecContainerRegistryConfig `json:"container_registries"`
	StorageBuckets      []SpecStorageBucketConfig     `json:"storage_buckets"`

	GitAccessToken string `json:"git_access_token"`

	// Populated at runtime from CloudIdentity, not from snapshot
	CloudAccountID string `json:"-"`

	// Populated at runtime from the claim response (decrypted), not from snapshot.
	// Keyed lookups happen via IntegrationCredentialFor.
	IntegrationCredentials []IntegrationCredential `json:"-"`
}

// IntegrationCredential carries a decrypted api_key credential for a pluggable
// provider, attached to the job at claim time (never stored in config_snapshot).
type IntegrationCredential struct {
	Category    string            `json:"category"`
	Slug        string            `json:"slug"`
	Credentials map[string]string `json:"credentials"`
}

// IntegrationCredentialFor returns the decrypted credential fields for a given
// (category, slug), or nil if none was attached.
func (c *SpecConfig) IntegrationCredentialFor(category, slug string) map[string]string {
	for _, ic := range c.IntegrationCredentials {
		if ic.Category == category && ic.Slug == slug {
			return ic.Credentials
		}
	}
	return nil
}

type SpecNetworkConfig struct {
	ProvisionNetwork bool   `json:"provision_network"`
	CIDRBlock        string `json:"cidr_block"`
	NetworkID        string `json:"network_id"`
	SingleNatGateway bool   `json:"single_nat_gateway"`
}

type SpecClusterConfig struct {
	ClusterVersion  string         `json:"cluster_version"`
	InstanceTypes   []string       `json:"instance_types"`
	NodeMinSize     int            `json:"node_min_size"`
	NodeMaxSize     int            `json:"node_max_size"`
	NodeDesiredSize int            `json:"node_desired_size"`
	ClusterAdmins   []interface{}  `json:"cluster_admins"`
	ProviderConfig  map[string]any `json:"provider_config"`
}

type SpecDNSConfig struct {
	Enabled bool `json:"enabled"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native DNS.
	Provider       string         `json:"provider"`
	ZoneID         string         `json:"zone_id"`
	DomainName     string         `json:"domain_name"`
	ProviderConfig map[string]any `json:"provider_config"`
}

// SpecObservabilityConfig — pluggable-only component (no cloud-native default).
type SpecObservabilityConfig struct {
	Enabled        bool           `json:"enabled"`
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type SpecRepositoriesConfig struct {
	AppsDestinationRepo string `json:"apps_destination_repo"`
}

type SpecDatabaseConfig struct {
	Name                string   `json:"name"`
	Engine              string   `json:"engine"`
	EngineVersion       string   `json:"engine_version"`
	MinCapacity         *float64 `json:"min_capacity"`
	MaxCapacity         *float64 `json:"max_capacity"`
	Port                *int     `json:"port"`
	BackupRetentionDays *int     `json:"backup_retention_days"`
	IamAuth             *bool    `json:"iam_auth"`
}

type SpecCacheConfig struct {
	Name          string `json:"name"`
	Engine        string `json:"engine"`
	NodeType      string `json:"node_type"`
	NumCacheNodes *int   `json:"num_cache_nodes"`
	MultiAz       *bool  `json:"multi_az"`
}

type SpecQueueConfig struct {
	Name              string         `json:"name"`
	Ordered           *bool          `json:"ordered"`
	VisibilityTimeout *int           `json:"visibility_timeout"`
	MessageRetention  *int           `json:"message_retention"`
	ProviderConfig    map[string]any `json:"provider_config"`
}

type SpecTopicConfig struct {
	Name          string              `json:"name"`
	Subscriptions []TopicSubscription `json:"subscriptions"`
}

type TopicSubscription struct {
	Protocol string `json:"protocol"`
	Endpoint string `json:"endpoint"`
}

type SpecNosqlConfig struct {
	Name                string `json:"name"`
	PartitionKey        string `json:"partition_key"`
	PartitionKeyType    string `json:"partition_key_type"`
	SortKey             string `json:"sort_key"`
	SortKeyType         string `json:"sort_key_type"`
	TableType           string `json:"table_type"`
	CapacityMode        string `json:"capacity_mode"`
	PointInTimeRecovery bool   `json:"point_in_time_recovery"`
}

type SpecSecretConfig struct {
	Name         string `json:"name"`
	Generate     bool   `json:"generate"`
	Length       int    `json:"length"`
	SpecialChars bool   `json:"special_chars"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native store.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type SpecContainerRegistryConfig struct {
	Name string `json:"name"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native registry.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type SpecStorageBucketConfig struct {
	Name              string         `json:"name"`
	Versioning        bool           `json:"versioning"`
	EncryptionEnabled bool           `json:"encryption_enabled"`
	PublicAccess      bool           `json:"public_access"`
	CorsOrigins       []string       `json:"cors_origins"`
	ProviderConfig    map[string]any `json:"provider_config"`
}
