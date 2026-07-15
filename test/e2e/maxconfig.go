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
	Apply func(pc *types.ProjectConfig)
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
}

// MaxConfigKinds is the full 11-kind surface. Adding a cloud later is a per-cloud Signals/Resource
// column + row value — never a new opaque artifact.
var MaxConfigKinds = []MaxConfigKind{
	{
		Kind:         "network",
		Doc:          "the VPC/network the cluster lives in — provisioned in-template.",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig) {
			pc.Network = types.ProjectNetworkConfig{ProvisionNetwork: true, CIDRBlock: "10.0.0.0/16", SingleNatGateway: true}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return pc.Network.ProvisionNetwork },
		AWSSignals:  []string{"provision_vpc", "vpc_cidr"},
		AWSResource: "aws_vpc",
	},
	{
		Kind:         "cluster",
		Doc:          "the managed Kubernetes cluster (EKS/GKE/AKS/ACK).",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig) {
			disk := 50
			pc.Cluster = types.ProjectClusterConfig{
				ClusterVersion:  "1.32",
				InstanceTypes:   []string{"m5.large"},
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
	},
	{
		Kind: "database",
		Doc:  "a managed SQL database. NOTE: AWS reads only databases[0] — one entry exercises the kind.",
		Apply: func(pc *types.ProjectConfig) {
			min, max := 0.5, 4.0
			port, backup := 5432, 7
			iam := true
			pc.Databases = []types.ProjectDatabaseConfig{{
				Name: "appdb", EngineFamily: "postgres", EngineVersion: "16.6",
				InstanceClass: "db.r6g.large", MinCapacity: &min, MaxCapacity: &max,
				Port: &port, BackupRetentionDays: &backup, IamAuth: &iam,
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.Databases) > 0 },
		AWSSignals:  []string{"create_rds", "rds_config"},
		AWSResource: "aws_rds_cluster",
	},
	{
		Kind: "cache",
		Doc:  "a managed Redis/Valkey cache. NOTE: AWS reads only caches[0].",
		Apply: func(pc *types.ProjectConfig) {
			nodes := 2
			multiAz := true
			pc.Caches = []types.ProjectCacheConfig{{
				Name: "sessions", EngineVersion: "7.1", NodeType: "cache.t3.medium",
				NumCacheNodes: &nodes, MultiAz: &multiAz,
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.Caches) > 0 },
		AWSSignals:  []string{"create_elasticache_redis"},
		AWSResource: "aws_elasticache_replication_group",
	},
	{
		Kind: "queue",
		Doc:  "a message queue (SQS). Signal is sqs_queues (NOT provision_sqs — topics set that too).",
		Apply: func(pc *types.ProjectConfig) {
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
	},
	{
		Kind: "topic",
		Doc:  "a pub/sub topic (SNS) with a subscription.",
		Apply: func(pc *types.ProjectConfig) {
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
	},
	{
		Kind: "nosql",
		Doc:  "a NoSQL table (DynamoDB).",
		Apply: func(pc *types.ProjectConfig) {
			pc.NosqlTables = []types.ProjectNosqlConfig{{
				Name: "items", PartitionKey: "pk", PartitionKeyType: "S",
				SortKey: "sk", SortKeyType: "S", TableType: "standard",
				CapacityMode: "on_demand", PointInTimeRecovery: true,
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.NosqlTables) > 0 },
		AWSSignals:  []string{"ddb_create", "ddb_table_configuration"},
		AWSResource: "aws_dynamodb_table",
	},
	{
		Kind: "secrets",
		Doc:  "a generated secret in the cloud secret store (Secrets Manager).",
		Apply: func(pc *types.ProjectConfig) {
			pc.Secrets = []types.ProjectSecretConfig{{
				Name: "api-key", Generate: true, Length: 32, SpecialChars: true,
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.Secrets) > 0 },
		AWSSignals:  []string{"custom_secrets"},
		AWSResource: "aws_secretsmanager_secret",
	},
	{
		Kind: "bucket",
		Doc:  "an object-storage bucket (S3).",
		Apply: func(pc *types.ProjectConfig) {
			pc.StorageBuckets = []types.ProjectStorageBucketConfig{{
				Name: "assets", Versioning: true, EncryptionEnabled: true, PublicAccess: false,
				CorsOrigins: []string{"https://example.com"},
			}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.StorageBuckets) > 0 },
		AWSSignals:  []string{"s3_create", "bucket_configuration"},
		AWSResource: "aws_s3_bucket",
	},
	{
		Kind: "registry",
		Doc:  "a container image registry (ECR). AWS emits provision_ecr as a boolean (name unused).",
		Apply: func(pc *types.ProjectConfig) {
			pc.ContainerRegistries = []types.ProjectContainerRegistryConfig{{Name: "app-images"}}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return len(pc.ContainerRegistries) > 0 },
		AWSSignals:  []string{"provision_ecr"},
		AWSResource: "aws_ecr_repository",
	},
	{
		Kind: "dns",
		Doc:  "cloud-native DNS (Route 53). cloud_dns_enabled fires only when enabled AND no zone_id is brought.",
		Apply: func(pc *types.ProjectConfig) {
			pc.DNS = types.ProjectDNSConfig{
				Enabled: true, DomainName: "example.com", ZoneID: "",
				ProviderConfig: map[string]any{"acm_certificate": true},
			}
		},
		Populated:   func(pc *types.ProjectConfig) bool { return pc.DNS.Enabled },
		AWSSignals:  []string{"cloud_dns_enabled"},
		AWSResource: "aws_route53_zone",
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
	pc := &types.ProjectConfig{Provider: provider}
	for _, k := range MaxConfigKinds {
		k.Apply(pc)
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
// provider. Only AWS is wired today (AWS-first); other clouds return "" until their column lands, so
// the real-apply assertion skips them rather than asserting a guessed type.
func (k MaxConfigKind) ResourceFor(provider string) string {
	if provider == "aws" {
		return k.AWSResource
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
