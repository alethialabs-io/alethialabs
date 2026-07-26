// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestAWSProviderHelperBuilders(t *testing.T) {
	ordered := true
	visibility := 45
	retention := 86400

	queues := buildSQSQueues(
		[]types.ProjectQueueConfig{{
			Name:              "events",
			Ordered:           &ordered,
			VisibilityTimeout: &visibility,
			MessageRetention:  &retention,
			ProviderConfig:    map[string]any{"delay_seconds": float64(7)},
		}},
		nil,
	)
	gotQueue := queues["events"].(map[string]interface{})
	if gotQueue["fifo_queue"] != true {
		t.Fatalf("fifo_queue = %v, want true", gotQueue["fifo_queue"])
	}
	if gotQueue["visibility_timeout_seconds"] != 45 {
		t.Fatalf("visibility_timeout_seconds = %v, want 45", gotQueue["visibility_timeout_seconds"])
	}
	if gotQueue["message_retention_seconds"] != 86400 {
		t.Fatalf("message_retention_seconds = %v, want 86400", gotQueue["message_retention_seconds"])
	}
	if gotQueue["delay_seconds"] != 7 {
		t.Fatalf("delay_seconds = %v, want 7", gotQueue["delay_seconds"])
	}

	topics := buildSNSTopics([]types.ProjectTopicConfig{{
		Name: "alerts",
		Subscriptions: []types.TopicSubscription{{
			Protocol: types.TopicSubscriptionProtocol("https"),
			Endpoint: "https://hooks.example.test/sns",
		}},
	}})
	gotSubs := topics["alerts"].(map[string]interface{})["subscriptions"].([]map[string]string)
	wantSubs := []map[string]string{{"protocol": "https", "endpoint": "https://hooks.example.test/sns"}}
	if !reflect.DeepEqual(gotSubs, wantSubs) {
		t.Fatalf("subscriptions = %#v, want %#v", gotSubs, wantSubs)
	}
}

func TestAWSProviderStorageAndDynamoHelpers(t *testing.T) {
	tables := []types.ProjectNosqlConfig{
		{
			Name:                "sessions",
			PartitionKey:        "pk",
			SortKey:             "sk",
			TableType:           types.NosqlTableType("standard"),
			CapacityMode:        types.NosqlCapacityMode("provisioned"),
			PointInTimeRecovery: true,
		},
		{
			Name:         "ledger",
			PartitionKey: "id",
			TableType:    types.NosqlTableType("global"),
		},
	}

	if !hasGlobalTables(tables) {
		t.Fatal("hasGlobalTables returned false for a global table")
	}
	standard := buildDDBTables(tables, "standard")
	if len(standard) != 1 {
		t.Fatalf("standard tables = %d, want 1", len(standard))
	}
	if standard[0]["billing_mode"] != "PROVISIONED" {
		t.Fatalf("billing_mode = %v, want PROVISIONED", standard[0]["billing_mode"])
	}
	if standard[0]["hash_key_type"] != "S" || standard[0]["range_key_type"] != "S" {
		t.Fatalf("default key types not applied: %#v", standard[0])
	}

	buckets := buildS3Buckets([]types.ProjectStorageBucketConfig{{
		Name:         "assets",
		Versioning:   true,
		PublicAccess: true,
		CorsOrigins:  []string{"https://app.example.test"},
		ProviderConfig: map[string]any{
			"encryption_algorithm": "aws:kms",
		},
	}})
	if len(buckets) != 1 {
		t.Fatalf("buckets = %d, want 1", len(buckets))
	}
	got := buckets[0]
	if got["sse_algorithm"] != "aws:kms" {
		t.Fatalf("sse_algorithm = %v, want aws:kms", got["sse_algorithm"])
	}
	if got["block_public_acls"] != false || got["restrict_public_buckets"] != false {
		t.Fatalf("public bucket flags should not block public access: %#v", got)
	}
	cors := got["cors_configuration"].([]map[string]interface{})
	if len(cors) != 1 {
		t.Fatalf("cors entries = %d, want 1", len(cors))
	}
}

func TestAWSProviderECRNamesMap(t *testing.T) {
	cfg := &types.ProjectConfig{
		ProjectName: "demo",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{
			{Name: "API Images", Provider: "native"},
			{Name: "External Registry", Provider: "dockerhub"},
			{Name: "Worker.Images"},
		},
		Services: []types.ProjectServiceConfig{
			{Name: "Checkout Service", Source: types.ProjectServiceSource{Kind: "repo"}},
			{Name: "Static Image", Source: types.ProjectServiceSource{Kind: "image"}},
		},
	}

	got := buildECRNamesMap(cfg)
	want := map[string]string{
		"API Images":       "api-images",
		"Worker.Images":    "worker-images",
		"Checkout Service": "checkout-service",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildECRNamesMap() = %#v, want %#v", got, want)
	}
}

// TestAWSProvider_CacheEngineSelectsTheModule pins the fix for the defect this lane exists for: the
// canvas offers a cache ENGINE, and until now no provider read it. Picking Valkey provisioned Redis,
// silently, and the apply succeeded.
//
// The two toggles must be mutually exclusive — both on would run two ElastiCache modules for one
// cache node, and both off would provision nothing while the environment reported converged.
func TestAWSProvider_CacheEngineSelectsTheModule(t *testing.T) {
	tests := []struct {
		name       string
		engine     types.CacheEngine
		wantRedis  bool
		wantValkey bool
	}{
		{"valkey selects the serverless module", types.CacheEngineValkey, false, true},
		{"redis selects the replication group", types.CacheEngineRedis, true, false},
		{"an engine-less config stays on redis", "", true, false},
	}

	p := &awsProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Caches:  []types.ProjectCacheConfig{{Name: "main", Engine: tt.engine, MemoryGB: 4}},
			}
			tfvars := p.ProviderTfvars(cfg)

			if got := tfvars["create_elasticache_redis"]; got != tt.wantRedis {
				t.Errorf("create_elasticache_redis = %v, want %v", got, tt.wantRedis)
			}
			if got := tfvars["create_elasticache_valkey"]; got != tt.wantValkey {
				t.Errorf("create_elasticache_valkey = %v, want %v", got, tt.wantValkey)
			}
			if tfvars["create_elasticache_redis"] == true && tfvars["create_elasticache_valkey"] == true {
				t.Error("both cache modules enabled for one cache node")
			}
		})
	}
}

// The two engines are sized by different models — a node type for the replication group, usage limits
// for the serverless cache — so the cloud-indifferent MemoryGB has to land on the right tfvar. Sending
// a serverless size to `redis_instance_type` (or vice versa) is silently wrong: the plan succeeds
// against the template default and the user's sizing is dropped.
func TestAWSProvider_CacheSizingFollowsTheEngine(t *testing.T) {
	p := &awsProvider{}
	base := func(engine types.CacheEngine) *types.ProjectConfig {
		return &types.ProjectConfig{
			Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
			DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			Caches:  []types.ProjectCacheConfig{{Name: "main", Engine: engine, MemoryGB: 8}},
		}
	}

	valkey := p.ProviderTfvars(base(types.CacheEngineValkey))
	if valkey["valkey_data_storage_max"] != float64(8) && valkey["valkey_data_storage_max"] != 8.0 {
		t.Errorf("valkey_data_storage_max = %v, want the 8 GB the user asked for", valkey["valkey_data_storage_max"])
	}

	redis := p.ProviderTfvars(base(types.CacheEngineRedis))
	if _, ok := redis["valkey_data_storage_max"]; ok {
		t.Error("a redis cache emitted a valkey sizing tfvar")
	}
	if redis["redis_instance_type"] == nil || redis["redis_instance_type"] == "" {
		t.Error("redis_instance_type was not resolved for a redis cache")
	}
}
