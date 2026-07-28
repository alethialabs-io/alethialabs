// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"strings"
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

// The #1382-class trap this closes: AWS offers `aurora-mysql` in the catalog and resolveDBEngine
// returns it, but every template default is Aurora-PostgreSQL-shaped. A MySQL engine that composes
// only engine/version inherits cluster_family=aurora-postgresql16, db_port=5432 and the "postgresql"
// log export — a plan that succeeds against a cluster that can never come up.
//
// The engines name their families differently, which is why this can't be one sprintf: Aurora MySQL
// is MAJOR.MINOR, Aurora PostgreSQL is MAJOR only (AWS Aurora User Guide).
func TestAWSAuroraFamily(t *testing.T) {
	tests := []struct {
		name    string
		engine  string
		version string
		want    string
	}{
		{"aurora mysql keeps major.minor", "aurora-mysql", "8.0", "aurora-mysql8.0"},
		{"aurora mysql 8.4 is its own family", "aurora-mysql", "8.4", "aurora-mysql8.4"},
		{"aurora mysql ignores a patch component", "aurora-mysql", "8.0.39", "aurora-mysql8.0"},
		{"aurora postgres keeps the major only", "aurora-postgresql", "16", "aurora-postgresql16"},
		{"aurora postgres drops the minor", "aurora-postgresql", "16.6", "aurora-postgresql16"},
		{"a legacy bare mysql engine still resolves", "mysql", "8.0", "aurora-mysql8.0"},
		// Underivable -> "", so the template default stands and the family-matches-engine check
		// fails the plan. Never guess a family.
		{"a mysql version with no minor is underivable", "aurora-mysql", "8", ""},
		{"an empty version is underivable", "aurora-postgresql", "", ""},
		{"an unknown engine is underivable", "aurora-oracle", "19", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := awsAuroraFamily(tt.engine, tt.version); got != tt.want {
				t.Errorf("awsAuroraFamily(%q, %q) = %q, want %q", tt.engine, tt.version, got, tt.want)
			}
		})
	}
}

// Selecting Aurora MySQL must compose a MySQL-VALID cluster end to end, not just a MySQL engine
// string: family, port and log exports all have to follow the engine or the apply fails (or, worse,
// succeeds onto a mis-parameterized cluster).
func TestAWSProvider_AuroraMySQLComposesAValidCluster(t *testing.T) {
	p := &awsProvider{}
	base := func(db types.ProjectDatabaseConfig) map[string]interface{} {
		return p.ProviderTfvars(&types.ProjectConfig{
			Cluster:   types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
			DNS:       types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			Databases: []types.ProjectDatabaseConfig{db},
		})
	}

	t.Run("mysql", func(t *testing.T) {
		tf := base(types.ProjectDatabaseConfig{Name: "app", EngineFamily: "mysql"})
		rds, ok := tf["rds_config"].(map[string]interface{})
		if !ok {
			t.Fatalf("rds_config missing or wrong type: %T", tf["rds_config"])
		}
		if rds["engine"] != "aurora-mysql" {
			t.Errorf("engine = %v, want aurora-mysql", rds["engine"])
		}
		if rds["cluster_family"] != "aurora-mysql8.0" {
			t.Errorf("cluster_family = %v, want aurora-mysql8.0 (a Postgres family mis-provisions the cluster)", rds["cluster_family"])
		}
		if rds["db_port"] != 3306 {
			t.Errorf("db_port = %v, want 3306", rds["db_port"])
		}
		logs, _ := tf["rds_logs_exports"].([]string)
		for _, l := range logs {
			if l == "postgresql" {
				t.Errorf("rds_logs_exports = %v — Aurora MySQL rejects the postgresql log type", logs)
			}
		}
		if len(logs) == 0 {
			t.Error("rds_logs_exports was not emitted for a MySQL engine")
		}
	})

	t.Run("postgres is unchanged", func(t *testing.T) {
		tf := base(types.ProjectDatabaseConfig{Name: "app", EngineFamily: "postgres"})
		rds, _ := tf["rds_config"].(map[string]interface{})
		if rds["engine"] != "aurora-postgresql" {
			t.Errorf("engine = %v, want aurora-postgresql", rds["engine"])
		}
		if rds["db_port"] != 5432 {
			t.Errorf("db_port = %v, want 5432", rds["db_port"])
		}
		if fam, ok := rds["cluster_family"]; ok && !strings.HasPrefix(fam.(string), "aurora-postgresql") {
			t.Errorf("cluster_family = %v, want an aurora-postgresql family", fam)
		}
		if logs, _ := tf["rds_logs_exports"].([]string); len(logs) != 1 || logs[0] != "postgresql" {
			t.Errorf("rds_logs_exports = %v, want [postgresql]", logs)
		}
	})

	t.Run("an explicit port still wins", func(t *testing.T) {
		port := 3307
		tf := base(types.ProjectDatabaseConfig{Name: "app", EngineFamily: "mysql", Port: &port})
		rds, _ := tf["rds_config"].(map[string]interface{})
		if rds["db_port"] != 3307 {
			t.Errorf("db_port = %v, want the explicit 3307", rds["db_port"])
		}
	})
}
