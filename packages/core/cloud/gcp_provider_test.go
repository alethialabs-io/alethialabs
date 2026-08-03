// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"regexp"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func boolPtr(b bool) *bool { return &b }

// TestGCPProvider_RequiredCLIs verifies the GCP provider advertises the exact
// set of CLIs the runner must have on PATH.
func TestGCPProvider_RequiredCLIs(t *testing.T) {
	p := &gcpProvider{}
	got := p.RequiredCLIs()
	// CLI-free: GKE auth is minted in-process by `runner kube-token` — no gcloud.
	want := []string{"kubectl", "helm"}
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
		"gke_cluster_version":           "1.35",        // catalog SSOT default (resolveK8sVersion)
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
	for _, k := range []string{"gke_instance_types", "gke_node_min_size", "cloud_sql_engine", "memorystore_tier", "network_id", "subnet_ids"} {
		if _, ok := tfvars[k]; ok {
			t.Errorf("tfvars[%q] should be absent, got %v", k, tfvars[k])
		}
	}
}

// TestGCPProvider_ProviderTfvars_Network exercises the provision_network /
// network_id decision matrix.
func TestGCPProvider_ProviderTfvars_Network(t *testing.T) {
	tests := []struct {
		name             string
		net              types.ProjectNetworkConfig
		wantProvision    bool
		wantNetworkID    string
		wantNetIDExists  bool
		wantSubnetIDs    []string
		wantSubnetExists bool
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
			name:            "byo network without subnet selection",
			net:             types.ProjectNetworkConfig{ProvisionNetwork: false, NetworkID: "projects/x/global/networks/vpc"},
			wantProvision:   false,
			wantNetworkID:   "projects/x/global/networks/vpc",
			wantNetIDExists: true,
		},
		{
			name: "byo network with subnet selection",
			net: types.ProjectNetworkConfig{
				ProvisionNetwork: false,
				NetworkID:        "projects/x/global/networks/vpc",
				SubnetIDs:        []string{"projects/x/regions/eu/subnetworks/s1"},
			},
			wantProvision:    false,
			wantNetworkID:    "projects/x/global/networks/vpc",
			wantNetIDExists:  true,
			wantSubnetIDs:    []string{"projects/x/regions/eu/subnetworks/s1"},
			wantSubnetExists: true,
		},
		{
			name: "subnet selection ignored when auto-provisioning",
			net: types.ProjectNetworkConfig{
				ProvisionNetwork: true,
				SubnetIDs:        []string{"projects/x/regions/eu/subnetworks/s1"},
			},
			wantProvision: true,
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
			gotSubnets, subOK := tfvars["subnet_ids"]
			if subOK != tt.wantSubnetExists {
				t.Errorf("subnet_ids present = %v, want %v", subOK, tt.wantSubnetExists)
			}
			if tt.wantSubnetExists {
				if !reflect.DeepEqual(gotSubnets, tt.wantSubnetIDs) {
					t.Errorf("subnet_ids = %v, want %v", gotSubnets, tt.wantSubnetIDs)
				}
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

// TestGCPProvider_ProviderTfvars_CloudSQLEngineVersionIsBare pins the CONTRACT the cloud-sql module
// composes `database_version` from: this tfvar carries the BARE version, never one that already
// carries its engine prefix.
//
// The module composes "${POSTGRES|MYSQL}_${version}" and normalizes the separator, so it tolerates
// "8.0" and "8_0" alike — but it cannot recover from "POSTGRES_16", which composes
// "POSTGRES_POSTGRES_16". That exact shape reached production once and left Cloud SQL unprovisionable
// (see the comment in modules/cloud-sql/main.tf); the dotted-MySQL half of the same grain confusion
// is #1381. The catalog is what feeds this, so a bad edit there is what this catches.
func TestGCPProvider_ProviderTfvars_CloudSQLEngineVersionIsBare(t *testing.T) {
	bare := regexp.MustCompile(`^[0-9]+([._][0-9]+)*$`)
	p := &gcpProvider{}

	for _, family := range []string{"postgres", "mysql"} {
		t.Run(family, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster:   types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:       types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Databases: []types.ProjectDatabaseConfig{{Name: "main", EngineFamily: family}},
			}
			got, _ := p.ProviderTfvars(cfg)["cloud_sql_engine_version"].(string)
			if got == "" {
				t.Fatalf("cloud_sql_engine_version is empty for %q — the catalog default did not resolve", family)
			}
			if !bare.MatchString(got) {
				t.Errorf("cloud_sql_engine_version = %q for %q; want a bare version like 16 or 8.0 (never engine-prefixed)", got, family)
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

// TestGCPProvider_ProviderTfvars_Memorystore verifies the cache mapping onto the tfvars the GCP
// template actually declares (#1085): memorystore_tier (STANDARD_HA for >1 node OR multi-AZ, else
// the BASIC default = absent), memorystore_memory_size_gb (whole GB from MemoryGB), and
// memorystore_redis_version (the REDIS_x_y enum). The old undeclared engine / instance-type /
// multi-az tfvars are NO LONGER emitted (they were silently dropped by the template).
func TestGCPProvider_ProviderTfvars_Memorystore(t *testing.T) {
	tests := []struct {
		name        string
		cache       types.ProjectCacheConfig
		wantTier    interface{} // nil => key absent
		wantMemGB   interface{}
		wantVersion interface{}
	}{
		{
			name:  "single node, basic (tier default, no size/version)",
			cache: types.ProjectCacheConfig{Name: "r", NumCacheNodes: intPtr(1)},
		},
		{
			name:        "ha via multi-node with size + version enum-mapped",
			cache:       types.ProjectCacheConfig{Name: "r", NumCacheNodes: intPtr(3), Engine: "redis", MemoryGB: 10, EngineVersion: "7.1"},
			wantTier:    "STANDARD_HA",
			wantMemGB:   10,
			wantVersion: "REDIS_7_0",
		},
		{
			name:     "ha via multi-az flag",
			cache:    types.ProjectCacheConfig{Name: "r", MultiAz: boolPtr(true)},
			wantTier: "STANDARD_HA",
		},
		{
			name:        "version 7.2 maps to REDIS_7_2, fractional GB rounds",
			cache:       types.ProjectCacheConfig{Name: "r", MemoryGB: 3.6, EngineVersion: "7.2"},
			wantMemGB:   4,
			wantVersion: "REDIS_7_2",
		},
		{
			name:        "version 6.x maps to REDIS_6_X",
			cache:       types.ProjectCacheConfig{Name: "r", EngineVersion: "6.2"},
			wantVersion: "REDIS_6_X",
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
			assertOptional(t, tfvars, "memorystore_memory_size_gb", tt.wantMemGB)
			assertOptional(t, tfvars, "memorystore_redis_version", tt.wantVersion)
			// The undeclared tfvars must no longer be emitted.
			for _, k := range []string{"memorystore_engine", "memorystore_instance_type", "memorystore_multi_az"} {
				if _, ok := tfvars[k]; ok {
					t.Errorf("tfvars[%q] should no longer be emitted (undeclared in variables.tf)", k)
				}
			}
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

// TestBuildGCSBuckets verifies PublicAccess pass-through, versioning pass-through, and the fixed
// CORS method set.
//
// `uniform_access` is asserted ABSENT on purpose. It used to carry the inverted PublicAccess, which
// is the wrong argument for the job — uniform bucket-level access disables per-object ACLs and says
// nothing about public readability — and Cloud Storage refuses to turn it back off 90 days after it
// was enabled, so a bucket older than that could never be made public again.
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
	if pub["public_access"] != true {
		t.Errorf("public public_access = %v, want true", pub["public_access"])
	}
	if !reflect.DeepEqual(pub["cors_origins"], []string{"https://a"}) {
		t.Errorf("public cors_origins = %v", pub["cors_origins"])
	}
	if !reflect.DeepEqual(pub["cors_methods"], []string{"GET", "PUT", "POST"}) {
		t.Errorf("public cors_methods = %v", pub["cors_methods"])
	}

	priv := got[1]
	if priv["public_access"] != false {
		t.Errorf("private public_access = %v, want false", priv["public_access"])
	}

	for i, b := range got {
		if _, ok := b["uniform_access"]; ok {
			t.Errorf("bucket %d still emits uniform_access; UBLA is not a user switch", i)
		}
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

// TestGCPProvider_CacheEngineSelectsTheProduct pins the GCP half of #1420. The canvas has offered
// redis|valkey on GCP the whole time and the provider read neither, so picking Valkey silently
// provisioned Redis and the apply succeeded.
//
// On GCP this is a real fork, not a flag: Valkey is `google_memorystore_instance` (cluster-shaped,
// sized by shards) and Redis is `google_redis_instance` (sized by a memory figure). Both toggles on
// would create two caches for one node; both off would create none while reporting converged.
func TestGCPProvider_CacheEngineSelectsTheProduct(t *testing.T) {
	tests := []struct {
		name       string
		engine     types.CacheEngine
		wantRedis  bool
		wantValkey bool
	}{
		{"valkey selects the Memorystore instance", types.CacheEngineValkey, false, true},
		{"redis selects the Redis instance", types.CacheEngineRedis, true, false},
		{"an engine-less config stays on redis", "", true, false},
	}

	p := &gcpProvider{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				Caches:  []types.ProjectCacheConfig{{Name: "main", Engine: tt.engine, MemoryGB: 4}},
			}
			tfvars := p.ProviderTfvars(cfg)

			if got := tfvars["create_memorystore"]; got != tt.wantRedis {
				t.Errorf("create_memorystore = %v, want %v", got, tt.wantRedis)
			}
			if got := tfvars["create_memorystore_valkey"]; got != tt.wantValkey {
				t.Errorf("create_memorystore_valkey = %v, want %v", got, tt.wantValkey)
			}
		})
	}
}

// The two products are sized by different models, so the cloud-indifferent MemoryGB has to land on
// the right tfvar. Sending a memory figure to the shard-shaped product (or vice versa) is silently
// wrong: the plan succeeds against the template default and the user's sizing is dropped.
func TestGCPProvider_CacheSizingFollowsTheProduct(t *testing.T) {
	p := &gcpProvider{}
	cfg := func(engine types.CacheEngine, gb float64) *types.ProjectConfig {
		return &types.ProjectConfig{
			Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
			DNS:     types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			Caches:  []types.ProjectCacheConfig{{Name: "main", Engine: engine, MemoryGB: gb}},
		}
	}

	valkey := p.ProviderTfvars(cfg(types.CacheEngineValkey, 4))
	if _, ok := valkey["memorystore_memory_size_gb"]; ok {
		t.Error("a valkey cache emitted the redis memory-size tfvar")
	}
	// 4 GB over ~1.4 GB per shard rounds UP to 3 — never below what was asked for.
	if got := valkey["memorystore_valkey_shard_count"]; got != 3 {
		t.Errorf("memorystore_valkey_shard_count = %v, want 3 for a 4 GB request", got)
	}

	redis := p.ProviderTfvars(cfg(types.CacheEngineRedis, 4))
	if got := redis["memorystore_memory_size_gb"]; got != 4 {
		t.Errorf("memorystore_memory_size_gb = %v, want 4", got)
	}
	if _, ok := redis["memorystore_valkey_shard_count"]; ok {
		t.Error("a redis cache emitted a valkey shard count")
	}
}

// The resource takes an ENUM; a raw semver fails the apply, which is the same trap the Redis side
// already documents.
func TestGCPValkeyVersionEnum(t *testing.T) {
	cases := map[string]string{
		"7.2":        "VALKEY_7_2",
		"8.0":        "VALKEY_8_0",
		"VALKEY_7_2": "VALKEY_7_2",
		"":           "",
		"7":          "", // no minor — the template default stands rather than a guess
	}
	for in, want := range cases {
		if got := gcpMemorystoreValkeyVersion(in); got != want {
			t.Errorf("gcpMemorystoreValkeyVersion(%q) = %q, want %q", in, got, want)
		}
	}
}
