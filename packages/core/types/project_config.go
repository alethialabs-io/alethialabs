// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

type ProjectConfig struct {
	ID               string `json:"id"`
	UserID           string `json:"user_id"`
	ProjectName      string `json:"project_name"`
	EnvironmentStage string `json:"environment_stage"`
	Region           string `json:"region"`
	IacVersion       string `json:"iac_version"`
	CloudIdentityID  string `json:"cloud_identity_id"`
	Provider         string `json:"provider"`

	Network       ProjectNetworkConfig       `json:"network"`
	Cluster       ProjectClusterConfig       `json:"cluster"`
	DNS           ProjectDNSConfig           `json:"dns"`
	Observability ProjectObservabilityConfig `json:"observability"`
	Repositories  ProjectRepositoriesConfig  `json:"repositories"`

	Databases           []ProjectDatabaseConfig          `json:"databases"`
	Caches              []ProjectCacheConfig             `json:"caches"`
	Queues              []ProjectQueueConfig             `json:"queues"`
	Topics              []ProjectTopicConfig             `json:"topics"`
	NosqlTables         []ProjectNosqlConfig             `json:"nosql_tables"`
	Secrets             []ProjectSecretConfig            `json:"secrets"`
	ContainerRegistries []ProjectContainerRegistryConfig `json:"container_registries"`
	StorageBuckets      []ProjectStorageBucketConfig     `json:"storage_buckets"`

	GitAccessToken string `json:"git_access_token"`

	// Populated at runtime from CloudIdentity, not from snapshot
	CloudAccountID string `json:"-"`

	// Populated at runtime from the claim response (decrypted), not from snapshot.
	// Keyed lookups happen via ConnectorCredentialFor.
	ConnectorCredentials []ConnectorCredential `json:"-"`
}

// ConnectorCredential carries a decrypted api_key credential for a pluggable
// connector, attached to the job at claim time (never stored in config_snapshot).
type ConnectorCredential struct {
	Category    string            `json:"category"`
	Slug        string            `json:"slug"`
	Credentials map[string]string `json:"credentials"`
}

// ConnectorCredentialFor returns the decrypted credential fields for a given
// (category, slug), or nil if none was attached.
func (c *ProjectConfig) ConnectorCredentialFor(category, slug string) map[string]string {
	for _, cc := range c.ConnectorCredentials {
		if cc.Category == category && cc.Slug == slug {
			return cc.Credentials
		}
	}
	return nil
}

// Placement is the resolved cloud placement of a single resource ("versatile
// model"). It is embedded in every component config so each resource can name its
// own cloud independently of the project's primary one. Empty fields mean "inherit the
// project's primary placement" — buildConfigSnapshot resolves them to concrete values
// before they reach the runner. CloudProvider is intentionally NOT named "provider":
// several components already carry a pluggable connector slug under json:"provider"
// (cloudflare/vault/…), which is an orthogonal concern from the cloud account.
type Placement struct {
	CloudProvider   string `json:"cloud_provider"`
	CloudIdentityID string `json:"cloud_identity_id"`
	Region          string `json:"region"`
}

type ProjectNetworkConfig struct {
	Placement
	ProvisionNetwork bool   `json:"provision_network"`
	CIDRBlock        string `json:"cidr_block"`
	NetworkID        string `json:"network_id"`
	SingleNatGateway bool   `json:"single_nat_gateway"`
}

type ProjectClusterConfig struct {
	Placement
	ClusterVersion  string         `json:"cluster_version"`
	InstanceTypes   []string       `json:"instance_types"`
	NodeMinSize     int            `json:"node_min_size"`
	NodeMaxSize     int            `json:"node_max_size"`
	NodeDesiredSize int            `json:"node_desired_size"`
	NodeDiskSizeGB  *int           `json:"node_disk_size_gb"`
	ClusterAdmins   []any          `json:"cluster_admins"`
	ProviderConfig  map[string]any `json:"provider_config"`
}

type ProjectDNSConfig struct {
	Placement
	Enabled bool `json:"enabled"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native DNS.
	Provider       string         `json:"provider"`
	ZoneID         string         `json:"zone_id"`
	DomainName     string         `json:"domain_name"`
	ProviderConfig map[string]any `json:"provider_config"`
}

// ProjectObservabilityConfig — pluggable-only component (no cloud-native default).
type ProjectObservabilityConfig struct {
	Placement
	Enabled        bool           `json:"enabled"`
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectRepositoriesConfig struct {
	AppsDestinationRepo string `json:"apps_destination_repo"`
}

type ProjectDatabaseConfig struct {
	Placement
	Name                string   `json:"name"`
	Engine              string   `json:"engine"`
	EngineVersion       string   `json:"engine_version"`
	InstanceClass       string   `json:"instance_class"`
	MinCapacity         *float64 `json:"min_capacity"`
	MaxCapacity         *float64 `json:"max_capacity"`
	Port                *int     `json:"port"`
	BackupRetentionDays *int     `json:"backup_retention_days"`
	IamAuth             *bool    `json:"iam_auth"`
}

type ProjectCacheConfig struct {
	Placement
	Name          string `json:"name"`
	Engine        string `json:"engine"`
	EngineVersion string `json:"engine_version"`
	NodeType      string `json:"node_type"`
	NumCacheNodes *int   `json:"num_cache_nodes"`
	MultiAz       *bool  `json:"multi_az"`
}

type ProjectQueueConfig struct {
	Placement
	Name              string         `json:"name"`
	Ordered           *bool          `json:"ordered"`
	VisibilityTimeout *int           `json:"visibility_timeout"`
	MessageRetention  *int           `json:"message_retention"`
	ProviderConfig    map[string]any `json:"provider_config"`
}

type ProjectTopicConfig struct {
	Placement
	Name          string              `json:"name"`
	Subscriptions []TopicSubscription `json:"subscriptions"`
}

type TopicSubscription struct {
	Protocol string `json:"protocol"`
	Endpoint string `json:"endpoint"`
}

type ProjectNosqlConfig struct {
	Placement
	Name                string `json:"name"`
	PartitionKey        string `json:"partition_key"`
	PartitionKeyType    string `json:"partition_key_type"`
	SortKey             string `json:"sort_key"`
	SortKeyType         string `json:"sort_key_type"`
	TableType           string `json:"table_type"`
	CapacityMode        string `json:"capacity_mode"`
	PointInTimeRecovery bool   `json:"point_in_time_recovery"`
}

type ProjectSecretConfig struct {
	Placement
	Name         string `json:"name"`
	Generate     bool   `json:"generate"`
	Length       int    `json:"length"`
	SpecialChars bool   `json:"special_chars"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native store.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectContainerRegistryConfig struct {
	Placement
	Name string `json:"name"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native registry.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectStorageBucketConfig struct {
	Placement
	Name              string         `json:"name"`
	Versioning        bool           `json:"versioning"`
	EncryptionEnabled bool           `json:"encryption_enabled"`
	PublicAccess      bool           `json:"public_access"`
	CorsOrigins       []string       `json:"cors_origins"`
	ProviderConfig    map[string]any `json:"provider_config"`
}
