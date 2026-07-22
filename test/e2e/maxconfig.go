// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The MAX-CONFIG surface — one legible table that IS the answer to "what are the 11 kinds,
// and what does each one become?"
//
// The maintainer's FULLY-TESTED bar requires a real apply that provisions EVERY resource kind a
// managed cloud supports (apps/console/lib/cloud-providers/unsupported-kinds.ts: cluster · network ·
// database · cache · queue · topic · nosql · dns · secrets · bucket · registry). The base T2 deploy
// snapshot (t2BaseSnapshot) populates only add-ons — every kind array is empty — so a real apply
// proves cluster+network and NOTHING else.
//
// Rather than hand-author another opaque config_snapshot JSON blob, the whole surface lives in ONE
// slice below: MaxConfigKinds. Read it and you know, per kind, (a) the ProjectConfig field that
// populates it, (b) the tfvars a provider MUST emit for it — proven FREE, every-PR, by
// maxconfig_pure_test.go against the real cloud.ProviderTfvars — and (c) the tofu resource a real
// apply MUST create, asserted in the maintainer-gated nightly (t2_provision_test.go). No generated
// blob, no drift from a second source of truth: the table is typed against the ProjectConfig struct
// the runner actually consumes, so a schema change is a compile error here.
//
// Opt-in via ALETHIA_E2E_MAX_CONFIG=1 (the nightly turns it on together with ALETHIA_E2E_ALL_ADDONS
// and a heavy node shape): all 11 kinds + all 19 add-ons need a node sized for them, so the lean
// default tier stays fast and cheap.

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// MaxConfigKind declares ONE resource kind end to end.
type MaxConfigKind struct {
	// Kind is the canonical kind slug (matches unsupported-kinds.ts / the canvas NodeKind).
	Kind string
	// Doc is one line: what this kind is, plus any gotcha worth stating in place.
	Doc string
	// Foundational marks the two kinds every cluster must have (network, cluster). They are
	// asserted POSITIVELY only — "dropping" them from a max-config is nonsensical, and their
	// signals are not kind-exclusive (a VPC is provisioned even when no network block is given).
	// The nine optional kinds each carry a LOUD negative test instead (see the pure test).
	Foundational bool
	// Apply populates this kind on the shared max-config ProjectConfig (the typed source of truth).
	// It takes the target provider so the three shape-bearing kinds (cluster/database/cache) can emit
	// provider-VALID literals — the cloud provider passes instance/tier/version values through
	// verbatim, so AWS shapes (m5.large, db.r6g.large, 16.6) would fail a real GKE/Cloud SQL apply.
	// The other eight kinds are provider-agnostic (names/booleans) and ignore the argument.
	Apply func(pc *types.ProjectConfig, provider string)
	// Populated reports whether Apply actually took — the fail-closed guard in MaxConfigSnapshot
	// (a max-config run that silently drops a kind is the exact vacuous proof the bar forbids).
	Populated func(pc *types.ProjectConfig) bool
	// AWSSignals are the AWS tfvar keys that must be present AND meaningful (truthy / non-empty)
	// when this kind is populated. Each is kind-EXCLUSIVE — driven only by this kind — so the same
	// keys double as the negative-test discriminators (drop the kind ⇒ the signal goes empty).
	AWSSignals []string
	// AWSResource is the tofu resource type a real AWS apply must create for this kind, counted
	// structurally in the deploy's state by the nightly. (Confirmed against
	// infra/templates/project/aws/**; several kinds route through cloudposse/terraform-aws-modules
	// registry modules, but the state carries the concrete type regardless of module nesting.)
	AWSResource string
	// GCPSignals are the GCP analogue of AWSSignals. NOTE: queue and topic share create_pubsub /
	// pubsub_topics (both fold into the pubsub_topics map), so they are NOT kind-exclusive — the
	// negative test discriminates those two via the pubsub_topics MAP KEY ("jobs"/"events"), not
	// these signals. The other seven optional kinds' GCP signals ARE kind-exclusive.
	GCPSignals []string
	// GCPResource is the tofu resource type a real GCP apply must create for this kind (confirmed
	// against infra/templates/project/gcp/**). NOTE: queue and topic both map to google_pubsub_topic,
	// so the per-kind state count cannot distinguish them on GCP (both are always present ⇒ count 2).
	GCPResource string
	// AzureSignals are the Azure analogue of AWSSignals — kind-EXCLUSIVE (meaningful only when this
	// kind is populated), so they double as the negative-test discriminators. UNLIKE GCP (where queue
	// and topic fold into one pubsub_topics map), Azure emits DISTINCT service_bus_queues and
	// service_bus_topics maps, so all nine optional kinds are cleanly isolable — the negative test is a
	// plain drop-and-check with no map-key special case.
	AzureSignals []string
	// AzureResource is the tofu resource type a real Azure apply must create for this kind (confirmed
	// against infra/templates/project/azure/**). nosql/bucket name the per-table / per-bucket child
	// (azurerm_cosmosdb_sql_container / azurerm_storage_container); the account/db parents are shared.
	AzureResource string
}

// MaxConfigKinds is the full 11-kind surface. Adding a cloud later is a per-cloud Signals/Resource
// column + row value — never a new opaque artifact.
var MaxConfigKinds = []MaxConfigKind{
	{
		Kind:         "network",
		Doc:          "the VPC/network the cluster lives in — provisioned in-template.",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Network = types.ProjectNetworkConfig{ProvisionNetwork: true, CIDRBlock: "10.0.0.0/16", SingleNatGateway: true}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return pc.Network.ProvisionNetwork },
		AWSSignals:  []string{"provision_vpc", "vpc_cidr"},
		AWSResource: "aws_vpc",
		GCPSignals:  []string{"provision_network", "network_cidr"},
		GCPResource: "google_compute_network",
		// Azure: provision_vnet is forced true when no NetworkID is brought; vnet_cidr always carries
		// a value. Foundational ⇒ positive-only, so non-kind-exclusivity is fine.
		AzureSignals:  []string{"provision_vnet", "vnet_cidr"},
		AzureResource: "azurerm_virtual_network",
	},
	{
		Kind:         "cluster",
		Doc:          "the managed Kubernetes cluster (EKS/GKE/AKS/ACK).",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig, provider string) {
			disk := 50
			version, instanceTypes := "1.32", []string{"m5.large"}
			switch provider {
			case "gcp":
				// m5.large is an EC2 type GKE rejects; 1.32 is delisted on GKE (1.33+ served).
				version, instanceTypes = "1.33", []string{"e2-standard-2"}
			case "azure":
				// m5.large is an EC2 type AKS rejects; keep the k8s version in Azure's STANDARD
				// support window (resolveK8sVersion tolerates a bare minor, but an aged version fails
				// an AKS create with K8sVersionNotSupported — 1.35 is the catalog default).
				version, instanceTypes = "1.35", []string{"Standard_D2s_v3"}
			}
			pc.Cluster = types.ProjectClusterConfig{
				ClusterVersion:  version,
				InstanceTypes:   instanceTypes,
				NodeMinSize:     2,
				NodeMaxSize:     5,
				NodeDesiredSize: 2,
				NodeDiskSizeGB:  &disk,
				ClusterAdmins:   []any{},
				ProviderConfig:  map[string]any{},
			}
		},
		Populated: func(pc *types.ProjectConfig) bool {
			return len(pc.Cluster.InstanceTypes) > 0 || pc.Cluster.NodeSize != nil
		},
		AWSSignals:  []string{"eks_instance_types", "eks_ng_desired_size"},
		AWSResource: "aws_eks_cluster",
		GCPSignals:  []string{"provision_gke", "gke_instance_types"},
		GCPResource: "google_container_cluster",
		// Azure: aks_instance_types / aks_node_desired_size are added only when the cluster block is
		// populated (kind-exclusive), unlike the always-true provision_aks bool.
		AzureSignals:  []string{"aks_instance_types", "aks_node_desired_size"},
		AzureResource: "azurerm_kubernetes_cluster",
	},
	{
		Kind: "database",
		Doc:  "a managed SQL database. NOTE: AWS reads only databases[0] — one entry exercises the kind.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			min, max := 0.5, 4.0
			port, backup := 5432, 7
			iam := true
			engineVersion, instanceClass := "16.6", "db.r6g.large"
			switch provider {
			case "gcp":
				// Cloud SQL composes POSTGRES_<version> — bare "16" is valid, "16.6" is not; and
				// db.r6g.large is an RDS class (Cloud SQL wants a db-* tier).
				engineVersion, instanceClass = "16", "db-f1-micro"
			case "azure":
				// PostgreSQL Flexible Server takes a bare major version ("16") and a B_/GP_/MO_ SKU
				// name — "16.6" and the RDS class db.r6g.large are both rejected.
				engineVersion, instanceClass = "16", "B_Standard_B1ms"
			}
			pc.Databases = []types.ProjectDatabaseConfig{{
				Name: "appdb", EngineFamily: "postgres", EngineVersion: engineVersion,
				InstanceClass: instanceClass, MinCapacity: &min, MaxCapacity: &max,
				Port: &port, BackupRetentionDays: &backup, IamAuth: &iam,
			}}
		},
		Populated:     func(pc *types.ProjectConfig) bool { return len(pc.Databases) > 0 },
		AWSSignals:    []string{"create_rds", "rds_config"},
		AWSResource:   "aws_rds_cluster",
		GCPSignals:    []string{"create_cloud_sql"},
		GCPResource:   "google_sql_database_instance",
		AzureSignals:  []string{"create_azure_db"},
		AzureResource: "azurerm_postgresql_flexible_server",
	},
	{
		Kind: "cache",
		Doc:  "a managed Redis/Valkey cache. NOTE: AWS reads only caches[0].",
		Apply: func(pc *types.ProjectConfig, provider string) {
			nodes := 2
			multiAz := true
			cache := types.ProjectCacheConfig{
				Name: "sessions", EngineVersion: "7.1", NodeType: "cache.t3.medium",
				NumCacheNodes: &nodes, MultiAz: &multiAz,
			}
			switch provider {
			case "gcp":
				// ElastiCache values break Memorystore (redis version "7.1" wants the enum
				// REDIS_7_0; cache.t3.medium is not a Memorystore type). Leave both empty so the
				// template's valid defaults apply; NumCacheNodes>1 ⇒ the STANDARD_HA tier. The
				// ProjectConfig↔Memorystore shape wiring (memory-size/tier vs the emitted
				// memorystore_instance_type) is a tracked gap — see #1085.
				cache = types.ProjectCacheConfig{Name: "sessions", NumCacheNodes: &nodes, MultiAz: &multiAz}
			case "azure":
				// azurerm_managed_redis has no version/family/capacity args (default_database block),
				// so redis "7.1" and cache.t3.medium have no mapping. Leave both empty: NumCacheNodes>1
				// ⇒ azure_cache_sku="Standard" ⇒ the template resolves Balanced_B1 (a valid Managed-
				// Redis SKU; floor Balanced_B0). The ProjectConfig NodeType↔Managed-Redis SKU wiring is
				// a tracked gap — see #1091.
				cache = types.ProjectCacheConfig{Name: "sessions", NumCacheNodes: &nodes, MultiAz: &multiAz}
			}
			pc.Caches = []types.ProjectCacheConfig{cache}
		},
		Populated:     func(pc *types.ProjectConfig) bool { return len(pc.Caches) > 0 },
		AWSSignals:    []string{"create_elasticache_redis"},
		AWSResource:   "aws_elasticache_replication_group",
		GCPSignals:    []string{"create_memorystore"},
		GCPResource:   "google_redis_instance",
		AzureSignals:  []string{"create_azure_cache"},
		AzureResource: "azurerm_managed_redis",
	},
	{
		Kind: "queue",
		Doc:  "a message queue (SQS). Signal is sqs_queues (NOT provision_sqs — topics set that too).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			ordered := true
			vis, ret := 30, 345600
			pc.Queues = []types.ProjectQueueConfig{{
				Name: "jobs", Ordered: &ordered, VisibilityTimeout: &vis, MessageRetention: &ret,
				ProviderConfig: map[string]any{"delay_seconds": 5},
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.Queues) > 0 },
		AWSSignals:  []string{"sqs_queues"},
		AWSResource: "aws_sqs_queue",
		// GCP: the queue folds into pubsub_topics["jobs"]. create_pubsub/pubsub_topics are NOT
		// kind-exclusive (topic sets them too), so the negative test keys off the "jobs" map entry.
		GCPSignals:  []string{"create_pubsub", "pubsub_topics"},
		GCPResource: "google_pubsub_topic",
		// Azure: distinct service_bus_queues map (NOT the shared create_service_bus bool, which topics
		// also set) — cleanly kind-exclusive, so the negative test needs no GCP-style discriminator.
		AzureSignals:  []string{"service_bus_queues"},
		AzureResource: "azurerm_servicebus_queue",
	},
	{
		Kind: "topic",
		Doc:  "a pub/sub topic (SNS) with a subscription.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Topics = []types.ProjectTopicConfig{{
				Name: "events",
				Subscriptions: []types.TopicSubscription{
					{Protocol: "sqs", Endpoint: "arn:aws:sqs:us-east-1:000000000000:jobs"},
				},
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.Topics) > 0 },
		AWSSignals:  []string{"sns_topics"},
		AWSResource: "aws_sns_topic",
		// GCP: the topic folds into pubsub_topics["events"] (same google_pubsub_topic type as queue).
		GCPSignals:  []string{"create_pubsub", "pubsub_topics"},
		GCPResource: "google_pubsub_topic",
		// Azure: distinct service_bus_topics map (separate from the queue's service_bus_queues).
		AzureSignals:  []string{"service_bus_topics"},
		AzureResource: "azurerm_servicebus_topic",
	},
	{
		Kind: "nosql",
		Doc:  "a NoSQL table (DynamoDB).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.NosqlTables = []types.ProjectNosqlConfig{{
				Name: "items", PartitionKey: "pk", PartitionKeyType: "S",
				SortKey: "sk", SortKeyType: "S", TableType: "standard",
				CapacityMode: "on_demand", PointInTimeRecovery: true,
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.NosqlTables) > 0 },
		AWSSignals:  []string{"ddb_create", "ddb_table_configuration"},
		AWSResource: "aws_dynamodb_table",
		GCPSignals:  []string{"create_firestore"},
		GCPResource: "google_firestore_database",
		// Azure: the per-table container (account/db parents are shared, one each).
		AzureSignals:  []string{"create_cosmos_db"},
		AzureResource: "azurerm_cosmosdb_sql_container",
	},
	{
		Kind: "secrets",
		Doc:  "a generated secret in the cloud secret store (Secrets Manager).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Secrets = []types.ProjectSecretConfig{{
				Name: "api-key", Generate: true, Length: 32, SpecialChars: true,
			}}
		},
		Populated:     func(pc *types.ProjectConfig) bool { return len(pc.Secrets) > 0 },
		AWSSignals:    []string{"custom_secrets"},
		AWSResource:   "aws_secretsmanager_secret",
		GCPSignals:    []string{"custom_secrets"},
		GCPResource:   "google_secret_manager_secret",
		AzureSignals:  []string{"custom_secrets"},
		AzureResource: "azurerm_key_vault_secret",
	},
	{
		Kind: "bucket",
		Doc:  "an object-storage bucket (S3).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.StorageBuckets = []types.ProjectStorageBucketConfig{{
				Name: "assets", Versioning: true, EncryptionEnabled: true, PublicAccess: false,
				CorsOrigins: []string{"https://example.com"},
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.StorageBuckets) > 0 },
		AWSSignals:  []string{"s3_create", "bucket_configuration"},
		AWSResource: "aws_s3_bucket",
		GCPSignals:  []string{"create_cloud_storage", "cloud_storage_buckets"},
		GCPResource: "google_storage_bucket",
		// Azure: the per-bucket container (the storage account parent is shared).
		AzureSignals:  []string{"create_storage_account"},
		AzureResource: "azurerm_storage_container",
	},
	{
		Kind: "registry",
		Doc:  "a container image registry (ECR). AWS emits provision_ecr as a boolean (name unused).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.ContainerRegistries = []types.ProjectContainerRegistryConfig{{Name: "app-images"}}
		},
		Populated:     func(pc *types.ProjectConfig) bool { return len(pc.ContainerRegistries) > 0 },
		AWSSignals:    []string{"provision_ecr"},
		AWSResource:   "aws_ecr_repository",
		GCPSignals:    []string{"provision_artifact_registry"},
		GCPResource:   "google_artifact_registry_repository",
		AzureSignals:  []string{"provision_acr"},
		AzureResource: "azurerm_container_registry",
	},
	{
		Kind: "dns",
		Doc:  "cloud-native DNS (Route 53). cloud_dns_enabled fires only when enabled AND no zone_id is brought.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.DNS = types.ProjectDNSConfig{
				Enabled: true, DomainName: "example.com", ZoneID: "",
				ProviderConfig: map[string]any{"acm_certificate": true},
			}
		},
		Populated:     func(pc *types.ProjectConfig) bool { return pc.DNS.Enabled },
		AWSSignals:    []string{"cloud_dns_enabled"},
		AWSResource:   "aws_route53_zone",
		GCPSignals:    []string{"cloud_dns_enabled"},
		GCPResource:   "google_dns_managed_zone",
		AzureSignals:  []string{"azure_dns_enabled"},
		AzureResource: "azurerm_dns_zone",
	},
}

// maxConfigSnapshotKeys are the config_snapshot top-level keys the max-config table owns. Only these
// are merged onto the deploy snapshot — never the runtime identity fields (id/project/region/…),
// which the base snapshot already carries.
var maxConfigSnapshotKeys = []string{
	"network", "cluster", "dns",
	"databases", "caches", "queues", "topics", "nosql_tables",
	"secrets", "container_registries", "storage_buckets",
}

// MaxConfigEnabled reports whether this run should provision the FULL 11-kind surface.
func MaxConfigEnabled() bool {
	return os.Getenv("ALETHIA_E2E_MAX_CONFIG") == "1"
}

// MaxConfigProjectConfig builds the typed max-config ProjectConfig by folding every kind's Apply.
// It is the single source both the free tfvar proof and the real-apply snapshot derive from.
func MaxConfigProjectConfig(provider string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProvider(provider)}
	for _, k := range MaxConfigKinds {
		k.Apply(pc, provider)
	}
	return pc
}

// MaxConfigSnapshot merges the 11-kind surface onto a base deploy snapshot (the map the runner
// consumes). Fail-closed: if ANY kind did not populate, it errors rather than provision a partial
// surface that would report green — the vacuous proof #515's discipline exists to prevent.
func MaxConfigSnapshot(base map[string]any, provider string) error {
	pc := MaxConfigProjectConfig(provider)
	var missing []string
	for _, k := range MaxConfigKinds {
		if !k.Populated(pc) {
			missing = append(missing, k.Kind)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("max-config surface is incomplete — kinds not populated: %v (a partial max-config run would be vacuous)", missing)
	}

	raw, err := json.Marshal(pc)
	if err != nil {
		return fmt.Errorf("marshal max-config ProjectConfig: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return fmt.Errorf("unmarshal max-config ProjectConfig: %w", err)
	}
	for _, key := range maxConfigSnapshotKeys {
		v, ok := all[key]
		if !ok {
			return fmt.Errorf("max-config ProjectConfig did not serialize expected key %q", key)
		}
		var decoded any
		if err := json.Unmarshal(v, &decoded); err != nil {
			return fmt.Errorf("decode max-config key %q: %w", key, err)
		}
		base[key] = decoded
	}
	return nil
}

// ResourceFor returns the tofu resource type a real apply must create for this kind on the given
// provider. AWS, GCP and Azure are wired; other clouds return "" until their column lands, so the
// real-apply assertion reports them as unmapped rather than asserting a guessed type.
func (k MaxConfigKind) ResourceFor(provider string) string {
	switch provider {
	case "aws":
		return k.AWSResource
	case "gcp":
		return k.GCPResource
	case "azure":
		return k.AzureResource
	}
	return ""
}

// countManagedResources counts managed resource INSTANCES of a given type in a tofu state JSON
// (state format v4). Child-module resources live in the same flat "resources" array, each tagged
// with its own "type", so a type match works regardless of module nesting. Counting instances (not
// resource blocks) means a for_each'd module producing N of a type still counts as N.
func countManagedResources(stateBytes []byte, resType string) (int, error) {
	var st struct {
		Resources []struct {
			Mode      string `json:"mode"`
			Type      string `json:"type"`
			Instances []struct {
				// present per instance; we only need the count
			} `json:"instances"`
		} `json:"resources"`
	}
	if err := json.Unmarshal(stateBytes, &st); err != nil {
		return 0, fmt.Errorf("parse tofu state: %w", err)
	}
	n := 0
	for _, r := range st.Resources {
		if r.Mode == "managed" && r.Type == resType {
			if len(r.Instances) == 0 {
				n++ // a managed resource with no recorded instances still counts as present
				continue
			}
			n += len(r.Instances)
		}
	}
	return n, nil
}

// AssertMaxConfigKindsInState proves every max-config kind's resource genuinely landed in the
// deploy's tofu state — the real-apply half of the surface. Fail-closed and per-kind: it names each
// kind whose resource is absent. Returns the list of missing kinds (empty = all present). Kinds with
// no ResourceFor(provider) mapping yet are reported separately so a run can't silently under-assert.
func AssertMaxConfigKindsInState(stateBytes []byte, provider string) (missing, unmapped []string, err error) {
	if len(stateBytes) == 0 {
		return nil, nil, fmt.Errorf("empty tofu state — the deploy wrote nothing")
	}
	for _, k := range MaxConfigKinds {
		resType := k.ResourceFor(provider)
		if resType == "" {
			unmapped = append(unmapped, k.Kind)
			continue
		}
		n, cerr := countManagedResources(stateBytes, resType)
		if cerr != nil {
			return nil, nil, cerr
		}
		if n < 1 {
			missing = append(missing, fmt.Sprintf("%s (%s)", k.Kind, resType))
		}
	}
	return missing, unmapped, nil
}

// meaningful reports whether a tfvar value is present AND carries signal — a true bool, a non-empty
// string/map/slice, a non-zero number. The kinds' create_* booleans are ALWAYS in the tfvar map (set
// to len(...)>0), so a mere presence check would pass even when a kind is absent; this is what gives
// both the positive proof and the negative test their teeth.
func meaningful(v any) bool {
	if v == nil {
		return false
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Bool:
		return rv.Bool()
	case reflect.String:
		return rv.String() != ""
	case reflect.Slice, reflect.Map, reflect.Array:
		return rv.Len() > 0
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int() != 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint() != 0
	case reflect.Float32, reflect.Float64:
		return rv.Float() != 0
	case reflect.Ptr, reflect.Interface:
		return !rv.IsNil() && meaningful(rv.Elem().Interface())
	default:
		return true
	}
}
