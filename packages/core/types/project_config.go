// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
	SourceRepos   []ProjectSourceRepoConfig  `json:"source_repos,omitempty"`

	Databases           []ProjectDatabaseConfig          `json:"databases"`
	Caches              []ProjectCacheConfig             `json:"caches"`
	Queues              []ProjectQueueConfig             `json:"queues"`
	Topics              []ProjectTopicConfig             `json:"topics"`
	NosqlTables         []ProjectNosqlConfig             `json:"nosql_tables"`
	Secrets             []ProjectSecretConfig            `json:"secrets"`
	ContainerRegistries []ProjectContainerRegistryConfig `json:"container_registries"`
	StorageBuckets      []ProjectStorageBucketConfig     `json:"storage_buckets"`

	// Marketplace add-ons — free OSS Helm charts (Grafana, Loki, …) resolved by the console
	// into install specs. The runner renders one ArgoCD Application per entry after the
	// cluster + ArgoCD are up. Empty for projects that enabled no add-ons.
	AddOns []AddOnInstall `json:"addons,omitempty"`

	// IacSource, when set, marks this project as BRING-YOUR-OWN IaC: the runner
	// provisions the customer's own OpenTofu root module (cloned at a pinned commit
	// from git) instead of a bundled Alethia template. It is the fail-closed
	// execution path for UNTRUSTED customer OpenTofu — the provisioner re-runs the
	// static iacsafety gate inline before any plan/apply. Nil for template-based
	// (canvas / catalog-composed) projects.
	IacSource *ProjectIacSourceConfig `json:"iac_source,omitempty"`

	GitAccessToken string `json:"git_access_token"`

	// Populated at runtime from CloudIdentity, not from snapshot
	CloudAccountID string `json:"-"`

	// Populated at runtime from the claim response (decrypted), not from snapshot.
	// Keyed lookups happen via ConnectorCredentialFor.
	ConnectorCredentials []ConnectorCredential `json:"-"`
}

// ProjectIacSourceConfig pins the customer's own OpenTofu root module for a
// bring-your-own IaC deploy. The console emits it on the config snapshot (C1); the
// runner clones RepoURL at the EXACT CommitSHA (not just Ref — a ref can move after
// the safety scan, TOCTOU), resolves Path inside the clone (traversal-guarded), and
// provisions that directory. VarValues are the customer's own tfvars, constrained to
// scalar string/number/bool at the write step (no nested objects/injection).
type ProjectIacSourceConfig struct {
	// RepoURL is the git repository holding the module (https or ssh form).
	RepoURL string `json:"repo_url"`
	// Ref is the branch or tag the customer selected (used for the clone; the
	// CommitSHA below is what is actually checked out).
	Ref string `json:"ref"`
	// Path is the module directory relative to the repo root ("" / "." = root).
	Path string `json:"path"`
	// CommitSHA is the pinned full commit that was scanned and approved. The deploy
	// MUST check this out (never the moving Ref) so plan/apply run the exact bytes
	// the safety gate vetted.
	CommitSHA string `json:"commit_sha"`
	// VarValues are the customer-supplied tofu variable values. Genuinely arbitrary
	// customer JSON, so map[string]any is acceptable here — but each value is coerced
	// to string/number/bool at the tfvar-write step; anything else is rejected.
	VarValues map[string]any `json:"var_values"`
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

// NodeSize is a cloud-indifferent node capability; the catalog resolver maps it to the
// nearest concrete per-provider instance type at provision time.
type NodeSize struct {
	VCPU     float64 `json:"vcpu"`
	MemoryGB float64 `json:"memory_gb"`
}

type ProjectClusterConfig struct {
	Placement
	ClusterVersion string `json:"cluster_version"`
	// Provisioned cluster name (populated on the snapshot after the first deploy). Lets a
	// day-2 job (drift inspection) acquire kubeconfig standalone via ConfigureKubeconfig.
	ClusterName string `json:"cluster_name"`
	// Concrete provider SKUs (legacy / explicit override). When empty, NodeSize resolves.
	InstanceTypes []string `json:"instance_types"`
	// Cloud-indifferent node capability (preferred); resolved to InstanceTypes per provider.
	NodeSize        *NodeSize      `json:"node_size"`
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

// ProjectSourceRepoConfig is a scanned source repo (1:N) + its detected services,
// carried in the config snapshot so the runner can generate app manifests at deploy
// time (the "generate" apps path).
type ProjectSourceRepoConfig struct {
	RepoURL  string            `json:"repo_url"`
	Ref      string            `json:"ref,omitempty"`
	ScanPath string            `json:"scan_path,omitempty"`
	Services []DetectedService `json:"services,omitempty"`
}

type ProjectDatabaseConfig struct {
	Placement
	Name string `json:"name"`
	// Concrete provider engine (legacy / explicit). When empty, EngineFamily resolves it.
	Engine string `json:"engine"`
	// Cloud-indifferent engine family ("postgres" | "mysql"); resolved per provider.
	EngineFamily        string   `json:"engine_family"`
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
	// Concrete provider SKU (legacy / explicit). When empty, MemoryGB resolves it.
	NodeType string `json:"node_type"`
	// Cloud-indifferent size (preferred); resolved to the nearest provider SKU.
	MemoryGB      float64 `json:"memory_gb"`
	NumCacheNodes *int    `json:"num_cache_nodes"`
	MultiAz       *bool   `json:"multi_az"`
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
