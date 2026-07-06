// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func boolPtr(b bool) *bool { return &b }

// TestGCPProvider_RequiredCLIs verifies the GCP provider advertises the exact
// set of CLIs the runner must have on PATH.
func TestGCPProvider_RequiredCLIs(t *testing.T) {
	p := &gcpProvider{}
	got := p.RequiredCLIs()
	want := []string{"gcloud", "kubectl", "helm"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("RequiredCLIs() = %v, want %v", got, want)
	}
}

// TestGCPProvider_ProviderTfvars_Defaults checks the fallback values produced
// from a minimal/empty ProjectConfig: defaulted CIDR + cluster version and all
// optional components disabled.
func TestGCPProvider_ProviderTfvars_Defaults(t *testing.T) {
	p := &gcpProvider{}
	cfg := &types.ProjectConfig{
		ProjectName:    "min",
		CloudAccountID: "proj-1",
		Region:         "us-central1",
		Cluster:        types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:            types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}

	tfvars := p.ProviderTfvars(cfg)

	checks := map[string]interface{}{
		"project_name":                  "min",
		"project_id":                    "proj-1",
		"region":                        "us-central1",
		"network_cidr":                  "10.0.0.0/16", // orDefault fallback
		"gke_cluster_version":           "1.31",        // orDefault fallback
		"provision_gke":                 true,
		"gke_enable_autopilot":          false,
		"cloud_armor_enabled":           false,
		"cloud_dns_managed_certificate": false,
		"create_pubsub":                 false,
		"create_memorystore":            false,
		"create_firestore":              false,
		"create_cloud_storage":          false,
		"create_cloud_sql":              false,
		"provision_artifact_registry":   false,
		"provision_network":             true, // no NetworkID + not provisioned => auto true
	}
	for k, want := range checks {
		if got := tfvars[k]; got != want {
			t.Errorf("tfvars[%q] = %v, want %v", k, got, want)
		}
	}

	// Optional node-pool / db / cache keys must be absent for an empty config.
	for _, k := range []string{"gke_instance_types", "gke_node_min_size", "cloud_sql_engine", "memorystore_tier", "network_id"} {
		if _, ok := tfvars[k]; ok {
			t.Errorf("tfvars[%q] should be absent, got %v", k, tfvars[k])
		}
	}
}

// TestGCPProvider_ProviderTfvars_Network exercises the provision_network /
// network_id decision matrix.
func TestGCPProvider_ProviderTfvars_Network(t *testing.T) {
	tests := []struct {
		name            string
		net             types.ProjectNetworkConfig
		wantProvision   bool
		wantNetworkID   string
		wantNetIDExists bool
	}{
		{
			name:          "explicit provision",
			net:           types.ProjectNetworkConfig{ProvisionNetwork: true},
			wantProvision: true,
		},
		{
			name:          "no network id auto-provisions",
			net:           types.ProjectNetworkConfig{ProvisionNetwork: false, NetworkID: ""},
			wantProvision: true,
		},
		{
			name:            "byo network",
			net:             types.ProjectNetworkConfig{ProvisionNetwork: false, NetworkID: "projects/x/global/networks/vpc"},
			wantProvision:   false,
			wantNetworkID:   "projects/x/global/networks/vpc",
			wantNetIDExists: true,
		},
		{
			name:          "provision true ignores network id",
			net:           types.ProjectNetworkConfig{ProvisionNetwork: true, NetworkID: "vpc"},
			wantProvision: true,
		},
	}

	p := &gcpProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Network: tt.net,
			}
			tfvars := p.ProviderTfvars(cfg)
			if got := tfvars["provision_network"]; got != tt.wantProvision {
				t.Errorf("provision_network = %v, want %v", got, tt.wantProvision)
			}
			gotID, ok := tfvars["network_id"]
			if ok != tt.wantNetIDExists {
				t.Errorf("network_id present = %v, want %v", ok, tt.wantNetIDExists)
			}
			if tt.wantNetIDExists && gotID != tt.wantNetworkID {
				t.Errorf("network_id = %v, want %v", gotID, tt.wantNetworkID)
			}
		})
	}
}

// TestGCPProvider_ProviderTfvars_CloudSQLEngine verifies the cloud-neutral
// engine names map to the Cloud SQL engine the templates expect, plus that
// optional db knobs only appear when set.
func TestGCPProvider_ProviderTfvars_CloudSQLEngine(t *testing.T) {
	tests := []struct {
		name       string
		engine     string
		wantEngine string
	}{
		{"postgres", "postgres", "POSTGRES"},
		{"aurora-postgresql", "aurora-postgresql", "POSTGRES"},
		{"mysql", "mysql", "MYSQL"},
		{"aurora-mysql", "aurora-mysql", "MYSQL"},
		{"empty defaults postgres", "", "POSTGRES"},
		{"unknown defaults postgres", "mariadb", "POSTGRES"},
	}

	p := &gcpProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Databases: []types.ProjectDatabaseConfig{
					{Name: "main", Engine: tt.engine},
				},
			}
			tfvars := p.ProviderTfvars(cfg)
			if tfvars["create_cloud_sql"] != true {
				t.Errorf("create_cloud_sql = %v, want true", tfvars["create_cloud_sql"])
			}
			if got := tfvars["cloud_sql_engine"]; got != tt.wantEngine {
				t.Errorf("cloud_sql_engine = %v, want %v", got, tt.wantEngine)
			}
		})
	}
}

// TestGCPProvider_ProviderTfvars_CloudSQLOptional checks that engine_version,
// port, backup retention and IAM auth pass through only when present.
func TestGCPProvider_ProviderTfvars_CloudSQLOptional(t *testing.T) {
	p := &gcpProvider{}

	// All optional knobs present.
	cfg := &types.ProjectConfig{
		Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Databases: []types.ProjectDatabaseConfig{
			{Name: "main", Engine: "postgres", EngineVersion: "16", Port: intPtr(5432), BackupRetentionDays: intPtr(7), IamAuth: boolPtr(true)},
		},
	}
	tfvars := p.ProviderTfvars(cfg)
	if tfvars["cloud_sql_engine_version"] != "16" {
		t.Errorf("cloud_sql_engine_version = %v, want 16", tfvars["cloud_sql_engine_version"])
	}
	if tfvars["cloud_sql_port"] != 5432 {
		t.Errorf("cloud_sql_port = %v, want 5432", tfvars["cloud_sql_port"])
	}
	if tfvars["cloud_sql_backup_retention_days"] != 7 {
		t.Errorf("cloud_sql_backup_retention_days = %v, want 7", tfvars["cloud_sql_backup_retention_days"])
	}
	if tfvars["cloud_sql_iam_auth"] != true {
		t.Errorf("cloud_sql_iam_auth = %v, want true", tfvars["cloud_sql_iam_auth"])
	}

	// None present -> keys absent.
	cfgBare := &types.ProjectConfig{
		Cluster:   types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:       types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Databases: []types.ProjectDatabaseConfig{{Name: "main", Engine: "postgres"}},
	}
	bare := p.ProviderTfvars(cfgBare)
	for _, k := range []string{"cloud_sql_engine_version", "cloud_sql_port", "cloud_sql_backup_retention_days", "cloud_sql_iam_auth"} {
		if _, ok := bare[k]; ok {
			t.Errorf("tfvars[%q] should be absent, got %v", k, bare[k])
		}
	}
}

// TestGCPProvider_ProviderTfvars_Memorystore verifies the cache mapping:
// STANDARD_HA tier only for >1 node, plus engine / instance-type / multi-az
// pass-through.
func TestGCPProvider_ProviderTfvars_Memorystore(t *testing.T) {
	tests := []struct {
		name         string
		cache        types.ProjectCacheConfig
		wantTier     interface{} // nil => key absent
		wantEngine   interface{}
		wantInstance interface{}
		wantMultiAz  interface{}
	}{
		{
			name:     "single node, basic",
			cache:    types.ProjectCacheConfig{Name: "r", NumCacheNodes: intPtr(1)},
			wantTier: nil,
		},
		{
			name:         "ha cluster with all knobs",
			cache:        types.ProjectCacheConfig{Name: "r", NumCacheNodes: intPtr(3), Engine: "redis", NodeType: "M1", MultiAz: boolPtr(true)},
			wantTier:     "STANDARD_HA",
			wantEngine:   "redis",
			wantInstance: "M1",
			wantMultiAz:  true,
		},
		{
			name:        "multi-az false still emitted",
			cache:       types.ProjectCacheConfig{Name: "r", MultiAz: boolPtr(false)},
			wantTier:    nil,
			wantMultiAz: false,
		},
	}

	p := &gcpProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Caches:  []types.ProjectCacheConfig{tt.cache},
			}
			tfvars := p.ProviderTfvars(cfg)
			if tfvars["create_memorystore"] != true {
				t.Errorf("create_memorystore = %v, want true", tfvars["create_memorystore"])
			}
			assertOptional(t, tfvars, "memorystore_tier", tt.wantTier)
			assertOptional(t, tfvars, "memorystore_engine", tt.wantEngine)
			assertOptional(t, tfvars, "memorystore_instance_type", tt.wantInstance)
			assertOptional(t, tfvars, "memorystore_multi_az", tt.wantMultiAz)
		})
	}
}

// TestGCPProvider_ProviderTfvars_NodePool verifies node-pool sizing keys appear
// only for positive values and that instance types pass through verbatim.
func TestGCPProvider_ProviderTfvars_NodePool(t *testing.T) {
	p := &gcpProvider{}

	cfg := &types.ProjectConfig{
		Cluster: types.ProjectClusterConfig{
			ProviderConfig:  map[string]any{},
			InstanceTypes:   []string{"e2-standard-4", "e2-standard-8"},
			NodeMinSize:     1,
			NodeMaxSize:     6,
			NodeDesiredSize: 3,
		},
		DNS: types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
	tfvars := p.ProviderTfvars(cfg)
	if got := tfvars["gke_instance_types"]; !reflect.DeepEqual(got, []string{"e2-standard-4", "e2-standard-8"}) {
		t.Errorf("gke_instance_types = %v", got)
	}
	if tfvars["gke_node_min_size"] != 1 {
		t.Errorf("gke_node_min_size = %v, want 1", tfvars["gke_node_min_size"])
	}
	if tfvars["gke_node_max_size"] != 6 {
		t.Errorf("gke_node_max_size = %v, want 6", tfvars["gke_node_max_size"])
	}
	if tfvars["gke_node_desired_size"] != 3 {
		t.Errorf("gke_node_desired_size = %v, want 3", tfvars["gke_node_desired_size"])
	}

	// Zero sizes => keys absent.
	zero := &types.ProjectConfig{
		Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
	zt := p.ProviderTfvars(zero)
	for _, k := range []string{"gke_instance_types", "gke_node_min_size", "gke_node_max_size", "gke_node_desired_size"} {
		if _, ok := zt[k]; ok {
			t.Errorf("tfvars[%q] should be absent for zero config, got %v", k, zt[k])
		}
	}
}

// TestGCPProvider_ProviderTfvars_ProviderConfigFlags checks the autopilot /
// cloud-armor / managed-certificate flags are read from ProviderConfig and are
// resilient to wrong-typed values.
func TestGCPProvider_ProviderTfvars_ProviderConfigFlags(t *testing.T) {
	tests := []struct {
		name            string
		cluster         map[string]any
		dns             map[string]any
		wantAutopilot   bool
		wantCloudArmor  bool
		wantManagedCert bool
	}{
		{
			name:            "all true",
			cluster:         map[string]any{"enable_autopilot": true},
			dns:             map[string]any{"cloud_armor": true, "managed_certificate": true},
			wantAutopilot:   true,
			wantCloudArmor:  true,
			wantManagedCert: true,
		},
		{
			name:    "wrong types ignored",
			cluster: map[string]any{"enable_autopilot": "yes"},
			dns:     map[string]any{"cloud_armor": 1, "managed_certificate": "true"},
		},
		{
			name:    "missing keys",
			cluster: map[string]any{},
			dns:     map[string]any{},
		},
	}

	p := &gcpProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: tt.cluster},
				DNS:     types.ProjectDNSConfig{ProviderConfig: tt.dns},
			}
			tfvars := p.ProviderTfvars(cfg)
			if tfvars["gke_enable_autopilot"] != tt.wantAutopilot {
				t.Errorf("gke_enable_autopilot = %v, want %v", tfvars["gke_enable_autopilot"], tt.wantAutopilot)
			}
			if tfvars["cloud_armor_enabled"] != tt.wantCloudArmor {
				t.Errorf("cloud_armor_enabled = %v, want %v", tfvars["cloud_armor_enabled"], tt.wantCloudArmor)
			}
			if tfvars["cloud_dns_managed_certificate"] != tt.wantManagedCert {
				t.Errorf("cloud_dns_managed_certificate = %v, want %v", tfvars["cloud_dns_managed_certificate"], tt.wantManagedCert)
			}
		})
	}
}

// TestBuildPubSubTopics covers topic subscriptions and queue-derived topics
// with default + overridden retention/ack deadlines.
func TestBuildPubSubTopics(t *testing.T) {
	topics := []types.ProjectTopicConfig{
		{Name: "events", Subscriptions: []types.TopicSubscription{{Endpoint: "https://x/hook"}}},
	}
	queues := []types.ProjectQueueConfig{
		{Name: "jobs"}, // defaults
		{Name: "slow", VisibilityTimeout: intPtr(60), MessageRetention: intPtr(3600)},
	}

	got := buildPubSubTopics(topics, queues)

	if len(got) != 3 {
		t.Fatalf("expected 3 topics, got %d (%v)", len(got), got)
	}

	// Topic with explicit subscription endpoint.
	ev, ok := got["events"].(map[string]interface{})
	if !ok {
		t.Fatalf("events topic missing/wrong type: %v", got["events"])
	}
	if ev["message_retention_duration"] != "86400s" {
		t.Errorf("events retention = %v, want 86400s", ev["message_retention_duration"])
	}
	evSubs, ok := ev["subscriptions"].([]map[string]interface{})
	if !ok || len(evSubs) != 1 {
		t.Fatalf("events subscriptions = %v", ev["subscriptions"])
	}
	if evSubs[0]["name"] != "https://x/hook" || evSubs[0]["ack_deadline_seconds"] != 10 {
		t.Errorf("events sub = %v", evSubs[0])
	}

	// Default queue.
	jobs := got["jobs"].(map[string]interface{})
	if jobs["message_retention_duration"] != "86400s" {
		t.Errorf("jobs retention = %v, want 86400s", jobs["message_retention_duration"])
	}
	jobsSubs := jobs["subscriptions"].([]map[string]interface{})
	if jobsSubs[0]["name"] != "jobs-sub" || jobsSubs[0]["ack_deadline_seconds"] != 10 {
		t.Errorf("jobs sub = %v", jobsSubs[0])
	}

	// Overridden queue.
	slow := got["slow"].(map[string]interface{})
	if slow["message_retention_duration"] != "3600s" {
		t.Errorf("slow retention = %v, want 3600s", slow["message_retention_duration"])
	}
	slowSubs := slow["subscriptions"].([]map[string]interface{})
	if slowSubs[0]["name"] != "slow-sub" || slowSubs[0]["ack_deadline_seconds"] != 60 {
		t.Errorf("slow sub = %v", slowSubs[0])
	}

	// Empty inputs -> empty (non-nil) map.
	empty := buildPubSubTopics(nil, nil)
	if empty == nil || len(empty) != 0 {
		t.Errorf("expected empty map, got %v", empty)
	}
}

// TestBuildFirestoreDatabases covers billing-mode translation and the
// conditional point-in-time-recovery flag.
func TestBuildFirestoreDatabases(t *testing.T) {
	tables := []types.ProjectNosqlConfig{
		{Name: "a", CapacityMode: "provisioned", PointInTimeRecovery: true},
		{Name: "b", CapacityMode: "on_demand"},
		{Name: "c"}, // empty mode -> PAY_PER_REQUEST
	}

	got := buildFirestoreDatabases(tables)
	if len(got) != 3 {
		t.Fatalf("expected 3 dbs, got %d", len(got))
	}

	if got[0]["name"] != "a" || got[0]["billing_mode"] != "PROVISIONED" {
		t.Errorf("db a = %v", got[0])
	}
	if got[0]["point_in_time_recovery"] != true {
		t.Errorf("db a PITR = %v, want true", got[0]["point_in_time_recovery"])
	}
	if got[1]["billing_mode"] != "PAY_PER_REQUEST" {
		t.Errorf("db b billing_mode = %v", got[1]["billing_mode"])
	}
	if _, ok := got[1]["point_in_time_recovery"]; ok {
		t.Errorf("db b should not set PITR, got %v", got[1]["point_in_time_recovery"])
	}
	if got[2]["billing_mode"] != "PAY_PER_REQUEST" {
		t.Errorf("db c billing_mode = %v", got[2]["billing_mode"])
	}

	if len(buildFirestoreDatabases(nil)) != 0 {
		t.Errorf("expected empty slice for nil input")
	}
}

// TestBuildGCSBuckets verifies the uniform-access inversion of PublicAccess,
// versioning pass-through, and the fixed CORS method set.
func TestBuildGCSBuckets(t *testing.T) {
	buckets := []types.ProjectStorageBucketConfig{
		{Name: "public", Versioning: true, PublicAccess: true, CorsOrigins: []string{"https://a"}},
		{Name: "private", Versioning: false, PublicAccess: false},
	}

	got := buildGCSBuckets(buckets)
	if len(got) != 2 {
		t.Fatalf("expected 2 buckets, got %d", len(got))
	}

	pub := got[0]
	if pub["name_suffix"] != "public" || pub["versioning"] != true {
		t.Errorf("public bucket = %v", pub)
	}
	if pub["uniform_access"] != false { // !PublicAccess
		t.Errorf("public uniform_access = %v, want false", pub["uniform_access"])
	}
	if !reflect.DeepEqual(pub["cors_origins"], []string{"https://a"}) {
		t.Errorf("public cors_origins = %v", pub["cors_origins"])
	}
	if !reflect.DeepEqual(pub["cors_methods"], []string{"GET", "PUT", "POST"}) {
		t.Errorf("public cors_methods = %v", pub["cors_methods"])
	}

	priv := got[1]
	if priv["uniform_access"] != true { // !false
		t.Errorf("private uniform_access = %v, want true", priv["uniform_access"])
	}

	if len(buildGCSBuckets(nil)) != 0 {
		t.Errorf("expected empty slice for nil input")
	}
}

// TestBuildGCPSecrets verifies secret config pass-through into the tfvars shape.
func TestBuildGCPSecrets(t *testing.T) {
	secrets := []types.ProjectSecretConfig{
		{Name: "api-key", Generate: true, Length: 32, SpecialChars: true},
		{Name: "static", Generate: false, Length: 0, SpecialChars: false},
	}

	got := buildGCPSecrets(secrets)
	if len(got) != 2 {
		t.Fatalf("expected 2 secrets, got %d", len(got))
	}
	want0 := map[string]interface{}{"name": "api-key", "generate": true, "length": 32, "special_chars": true}
	if !reflect.DeepEqual(got[0], want0) {
		t.Errorf("secret 0 = %v, want %v", got[0], want0)
	}
	want1 := map[string]interface{}{"name": "static", "generate": false, "length": 0, "special_chars": false}
	if !reflect.DeepEqual(got[1], want1) {
		t.Errorf("secret 1 = %v, want %v", got[1], want1)
	}

	if len(buildGCPSecrets(nil)) != 0 {
		t.Errorf("expected empty slice for nil input")
	}
}

// TestGCPProvider_ProviderTfvars_PubSubFirestoreToggles checks the create_*
// toggles flip based on the presence of topics/queues and nosql tables.
func TestGCPProvider_ProviderTfvars_PubSubFirestoreToggles(t *testing.T) {
	p := &gcpProvider{}
	cfg := &types.ProjectConfig{
		Cluster:     types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Queues:      []types.ProjectQueueConfig{{Name: "q"}},
		NosqlTables: []types.ProjectNosqlConfig{{Name: "t"}},
		StorageBuckets: []types.ProjectStorageBucketConfig{
			{Name: "b"},
		},
	}
	tfvars := p.ProviderTfvars(cfg)
	if tfvars["create_pubsub"] != true {
		t.Errorf("create_pubsub = %v, want true", tfvars["create_pubsub"])
	}
	if tfvars["create_firestore"] != true {
		t.Errorf("create_firestore = %v, want true", tfvars["create_firestore"])
	}
	if tfvars["create_cloud_storage"] != true {
		t.Errorf("create_cloud_storage = %v, want true", tfvars["create_cloud_storage"])
	}
}

// assertOptional asserts tfvars[key] equals want, treating want==nil as "key
// must be absent".
func assertOptional(t *testing.T, tfvars map[string]interface{}, key string, want interface{}) {
	t.Helper()
	got, ok := tfvars[key]
	if want == nil {
		if ok {
			t.Errorf("tfvars[%q] should be absent, got %v", key, got)
		}
		return
	}
	if !ok {
		t.Errorf("tfvars[%q] missing, want %v", key, want)
		return
	}
	if got != want {
		t.Errorf("tfvars[%q] = %v, want %v", key, got, want)
	}
}
