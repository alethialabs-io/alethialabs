// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// ---------------------------------------------------------------------------
// Alibaba provider — the file had no dedicated test; ProviderTfvars + every
// build* helper were below 50% coverage. These lock in the tfvar mapping.
// ---------------------------------------------------------------------------

// A rich Alibaba config exercising every branch of ProviderTfvars.
func alibabaRichConfig() *types.ProjectConfig {
	vis := 30
	ret := 3600
	port := 5432
	backup := 7
	disk := 100
	multiAz := true
	return &types.ProjectConfig{
		ID:               "proj-abc",
		EnvironmentID:    "env-xyz",
		ProjectName:      "acme",
		Region:           "eu-central-1",
		EnvironmentStage: "prod",
		CloudAccountID:   "123456",
		Classification:   map[string][]string{"tier": {"prod"}},
		Network: types.ProjectNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.1.0.0/16",
			SingleNatGateway: true,
		},
		Cluster: types.ProjectClusterConfig{
			ClusterVersion:  "1.30",
			InstanceTypes:   []string{"ecs.g6.large"},
			NodeMinSize:     2,
			NodeMaxSize:     5,
			NodeDesiredSize: 3,
			NodeDiskSizeGB:  &disk,
		},
		DNS: types.ProjectDNSConfig{
			Enabled:    true,
			DomainName: "example.com",
			ZoneID:     "zone-1",
			ProviderConfig: map[string]any{
				"managed_certificate": true,
				"application_waf":     true,
			},
		},
		Queues: []types.ProjectQueueConfig{{Name: "jobs", VisibilityTimeout: &vis, MessageRetention: &ret}},
		Topics: []types.ProjectTopicConfig{{
			Name:          "events",
			Subscriptions: []types.TopicSubscription{{Protocol: types.TopicSubscriptionProtocol("https"), Endpoint: "https://hook.test/x"}},
		}},
		Caches:      []types.ProjectCacheConfig{{Name: "cache", EngineVersion: "7.0", MultiAz: &multiAz}},
		NosqlTables: []types.ProjectNosqlConfig{{Name: "sessions", PartitionKey: "pk", PartitionKeyType: types.NosqlKeyType("N")}},
		StorageBuckets: []types.ProjectStorageBucketConfig{{
			Name:         "assets",
			Versioning:   true,
			PublicAccess: true,
			CorsOrigins:  []string{"https://app.test"},
		}},
		Secrets:   []types.ProjectSecretConfig{{Name: "api-key", Generate: true, Length: 32, SpecialChars: true}},
		Databases: []types.ProjectDatabaseConfig{{Name: "db", EngineFamily: "postgres", InstanceClass: "rds.pg.s1.small", Port: &port, BackupRetentionDays: &backup}},
	}
}

func TestAlibabaProviderTfvars_FullConfig(t *testing.T) {
	tf := (&alibabaProvider{}).ProviderTfvars(alibabaRichConfig())

	// Core toggles derived from presence of each resource kind.
	for k, want := range map[string]interface{}{
		"provision_ack":              true,
		"create_mns":                 true,
		"create_kvstore":             true,
		"create_ots":                 true,
		"create_oss":                 true,
		"create_rds":                 true,
		"provision_network":          true,
		"single_cloud_nat":           true,
		"alidns_enabled":             true,
		"alidns_managed_certificate": true,
		"application_waf_enabled":    true,
		"rds_engine":                 "PostgreSQL",
		"project_name":               "acme",
		"alibaba_account":            "123456",
	} {
		if tf[k] != want {
			t.Errorf("tfvars[%q] = %v (%T), want %v", k, tf[k], tf[k], want)
		}
	}
	// environment carries the typed EnvironmentStage; compare as string.
	if got, _ := tf["environment"].(types.EnvironmentStage); string(got) != "prod" {
		t.Errorf("environment = %v (%T), want prod", tf["environment"], tf["environment"])
	}

	// Cluster sizing knobs.
	if tf["ack_node_min_size"] != 2 || tf["ack_node_max_size"] != 5 || tf["ack_node_desired_size"] != 3 {
		t.Errorf("node sizing wrong: %v/%v/%v", tf["ack_node_min_size"], tf["ack_node_max_size"], tf["ack_node_desired_size"])
	}
	if tf["ack_disk_size_gb"] != 100 {
		t.Errorf("ack_disk_size_gb = %v, want 100", tf["ack_disk_size_gb"])
	}
	inst, ok := tf["ack_instance_types"].([]string)
	if !ok || len(inst) != 1 || inst[0] != "ecs.g6.large" {
		t.Errorf("ack_instance_types = %v, want [ecs.g6.large]", tf["ack_instance_types"])
	}

	// RDS detail.
	if tf["rds_instance_type"] != "rds.pg.s1.small" {
		t.Errorf("rds_instance_type = %v", tf["rds_instance_type"])
	}
	if tf["rds_port"] != 5432 {
		t.Errorf("rds_port = %v, want 5432", tf["rds_port"])
	}
	if tf["rds_backup_retention_days"] != 7 {
		t.Errorf("rds_backup_retention_days = %v, want 7", tf["rds_backup_retention_days"])
	}

	// Cache detail.
	if tf["kvstore_engine_version"] != "7.0" {
		t.Errorf("kvstore_engine_version = %v", tf["kvstore_engine_version"])
	}
	if tf["kvstore_multi_az"] != true {
		t.Errorf("kvstore_multi_az = %v, want true", tf["kvstore_multi_az"])
	}

	// classification_tags carries the sweep handle and is Alibaba (colon) styled.
	tags, ok := tf["classification_tags"].(map[string]string)
	if !ok || tags["alethia:project-id"] != "proj-abc" {
		t.Errorf("classification_tags = %v, want alethia:project-id=proj-abc", tf["classification_tags"])
	}

	// Reserved DNS keys must NOT be injected verbatim by the generic passthrough.
	if _, present := tf["managed_certificate"]; present {
		t.Error("reserved key managed_certificate leaked into tfvars verbatim")
	}
	if _, present := tf["application_waf"]; present {
		t.Error("reserved key application_waf leaked into tfvars verbatim")
	}
}

func TestAlibabaProviderTfvars_MySQLEngine(t *testing.T) {
	cfg := &types.ProjectConfig{
		ProjectName: "p",
		Databases:   []types.ProjectDatabaseConfig{{Name: "db", Engine: "mysql"}},
	}
	tf := (&alibabaProvider{}).ProviderTfvars(cfg)
	if tf["rds_engine"] != "MySQL" {
		t.Errorf("rds_engine = %v, want MySQL", tf["rds_engine"])
	}
}

func TestAlibabaProviderTfvars_NetworkModes(t *testing.T) {
	// No explicit provisioning + no existing network id => provision defaults to true.
	def := (&alibabaProvider{}).ProviderTfvars(&types.ProjectConfig{ProjectName: "p"})
	if def["provision_network"] != true {
		t.Errorf("provision_network default = %v, want true", def["provision_network"])
	}
	if _, ok := def["network_id"]; ok {
		t.Error("network_id must be absent when provisioning a new network")
	}

	// BYO network: provision false + a network id => passthrough the id, don't provision.
	byo := (&alibabaProvider{}).ProviderTfvars(&types.ProjectConfig{
		ProjectName: "p",
		Network:     types.ProjectNetworkConfig{ProvisionNetwork: false, NetworkID: "vpc-123"},
	})
	if byo["provision_network"] != false {
		t.Errorf("provision_network = %v, want false for BYO network", byo["provision_network"])
	}
	if byo["network_id"] != "vpc-123" {
		t.Errorf("network_id = %v, want vpc-123", byo["network_id"])
	}
}

func TestAlibabaBuilders_MNSQueues(t *testing.T) {
	vis := 15
	ret := 600
	// Queue with both timers set.
	got := buildMNSQueues([]types.ProjectQueueConfig{{Name: "q1", VisibilityTimeout: &vis, MessageRetention: &ret}})
	q1, ok := got["q1"].(map[string]interface{})
	if !ok {
		t.Fatalf("q1 missing/wrong type: %#v", got["q1"])
	}
	if q1["visibility_timeout"] != 15 {
		t.Errorf("visibility_timeout = %v, want 15", q1["visibility_timeout"])
	}
	if q1["message_retention_period"] != 600 {
		t.Errorf("message_retention_period = %v, want 600", q1["message_retention_period"])
	}
	// Queue with no timers => empty config (no keys).
	bare := buildMNSQueues([]types.ProjectQueueConfig{{Name: "q2"}})
	if len(bare["q2"].(map[string]interface{})) != 0 {
		t.Errorf("bare queue should have no timer keys: %#v", bare["q2"])
	}
}

func TestAlibabaBuilders_MNSTopics(t *testing.T) {
	got := buildMNSTopics([]types.ProjectTopicConfig{{
		Name: "t1",
		Subscriptions: []types.TopicSubscription{
			{Protocol: types.TopicSubscriptionProtocol("http"), Endpoint: "http://a.test"},
			{Protocol: types.TopicSubscriptionProtocol("queue"), Endpoint: "b"},
		},
	}})
	entry := got["t1"].(map[string]interface{})
	subs := entry["subscriptions"].([]map[string]string)
	if len(subs) != 2 {
		t.Fatalf("subscriptions = %d, want 2", len(subs))
	}
	if subs[0]["protocol"] != "http" || subs[0]["endpoint"] != "http://a.test" {
		t.Errorf("sub[0] = %#v", subs[0])
	}
	if subs[1]["protocol"] != "queue" || subs[1]["endpoint"] != "b" {
		t.Errorf("sub[1] = %#v", subs[1])
	}
}

func TestAlibabaBuilders_OTSTablesAndKeyType(t *testing.T) {
	tables := buildOTSTables([]types.ProjectNosqlConfig{
		{Name: "n", PartitionKey: "pk", PartitionKeyType: types.NosqlKeyType("N")},
		{Name: "b", PartitionKey: "pk", PartitionKeyType: types.NosqlKeyType("B")},
		{Name: "s", PartitionKey: "pk", PartitionKeyType: types.NosqlKeyType("S")},
		{Name: "u", PartitionKey: "pk", PartitionKeyType: types.NosqlKeyType("")},
	})
	wantTypes := []string{"Integer", "Binary", "String", "String"}
	if len(tables) != 4 {
		t.Fatalf("tables = %d, want 4", len(tables))
	}
	for i, want := range wantTypes {
		if tables[i]["primary_key_type"] != want {
			t.Errorf("table[%d] primary_key_type = %v, want %v", i, tables[i]["primary_key_type"], want)
		}
		if tables[i]["primary_key"] != "pk" {
			t.Errorf("table[%d] primary_key = %v, want pk", i, tables[i]["primary_key"])
		}
	}
	// Direct otsKeyType mapping.
	for in, want := range map[string]string{"N": "Integer", "B": "Binary", "S": "String", "": "String", "junk": "String"} {
		if got := otsKeyType(in); got != want {
			t.Errorf("otsKeyType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAlibabaBuilders_OSSBuckets(t *testing.T) {
	got := buildOSSBuckets([]types.ProjectStorageBucketConfig{
		{Name: "pub", PublicAccess: true, Versioning: true, CorsOrigins: []string{"https://x.test"}},
		{Name: "priv", PublicAccess: false},
	})
	if got[0]["acl"] != "public-read" {
		t.Errorf("public bucket acl = %v, want public-read", got[0]["acl"])
	}
	if got[0]["versioning"] != true {
		t.Errorf("versioning = %v, want true", got[0]["versioning"])
	}
	if got[0]["name_suffix"] != "pub" {
		t.Errorf("name_suffix = %v, want pub", got[0]["name_suffix"])
	}
	if got[1]["acl"] != "private" {
		t.Errorf("private bucket acl = %v, want private", got[1]["acl"])
	}
}

func TestAlibabaBuilders_Secrets(t *testing.T) {
	got := buildAlibabaSecrets([]types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 24, SpecialChars: true}})
	if len(got) != 1 {
		t.Fatalf("secrets = %d, want 1", len(got))
	}
	s := got[0]
	if s["name"] != "s" || s["generate"] != true || s["length"] != 24 || s["special_chars"] != true {
		t.Errorf("secret = %#v", s)
	}
}

func TestAlibabaOutputString(t *testing.T) {
	cases := []struct {
		name    string
		outputs map[string]interface{}
		key     string
		want    string
	}{
		{"wrapped", map[string]interface{}{"kubeconfig": map[string]interface{}{"value": "yaml"}}, "kubeconfig", "yaml"},
		{"bare", map[string]interface{}{"kubeconfig": "yaml"}, "kubeconfig", "yaml"},
		{"missing", map[string]interface{}{}, "kubeconfig", ""},
		{"wrapped-non-string", map[string]interface{}{"k": map[string]interface{}{"value": 7}}, "k", ""},
		{"wrong-type", map[string]interface{}{"k": 7}, "k", ""},
	}
	for _, c := range cases {
		if got := alibabaOutputString(c.outputs, c.key); got != c.want {
			t.Errorf("%s: alibabaOutputString = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAlibabaConfigureKubeconfig(t *testing.T) {
	// Missing kubeconfig output => error.
	err := (&alibabaProvider{}).ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, map[string]interface{}{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "no kubeconfig") {
		t.Fatalf("missing kubeconfig err = %v, want 'no kubeconfig'", err)
	}

	// Present kubeconfig => file written under HOME, KUBECONFIG pointed at it.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")
	var out bytes.Buffer
	outputs := map[string]interface{}{
		"kubeconfig":       map[string]interface{}{"value": "apiVersion: v1\nkind: Config\n"},
		"ack_cluster_name": map[string]interface{}{"value": "my-ack"},
	}
	if err := (&alibabaProvider{}).ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, outputs, &out); err != nil {
		t.Fatalf("ConfigureKubeconfig err = %v", err)
	}
	path := filepath.Join(home, ".alethia", "kubeconfig")
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("kubeconfig not written: %v", readErr)
	}
	if !strings.Contains(string(data), "kind: Config") {
		t.Errorf("kubeconfig content = %q", string(data))
	}
	if os.Getenv("KUBECONFIG") != path {
		t.Errorf("KUBECONFIG = %q, want %q", os.Getenv("KUBECONFIG"), path)
	}
	if !strings.Contains(out.String(), "my-ack") {
		t.Errorf("stdout should mention cluster name: %q", out.String())
	}
	// File mode must be 0600 (secret material).
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("kubeconfig perm = %o, want 600", fi.Mode().Perm())
	}
}

// ---------------------------------------------------------------------------
// Security: a customer's provider_config must NOT be able to shadow the
// reserved alethia:* attribution tags. classification_tags is set BEFORE the
// merge-if-absent passthrough, so a hostile "classification_tags" key is
// dropped and the platform's own sweep handles survive.
// ---------------------------------------------------------------------------

func TestProviderConfig_CannotShadowClassificationTags(t *testing.T) {
	attacker := map[string]any{
		"classification_tags": map[string]string{"alethia:project-id": "attacker", "alethia:environment-id": "attacker"},
	}
	cases := []struct {
		name    string
		build   func(*types.ProjectConfig) map[string]interface{}
		wantKey string
	}{
		{"alibaba", (&alibabaProvider{}).ProviderTfvars, "alethia:project-id"},
		{"aws", (&awsProvider{}).ProviderTfvars, "alethia:project-id"},
		{"azure", (&azureProvider{}).ProviderTfvars, "alethia:project-id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				ID:            "proj-real",
				EnvironmentID: "env-real",
				ProjectName:   "p",
				Cluster:       types.ProjectClusterConfig{ProviderConfig: attacker},
			}
			tf := c.build(cfg)
			tags, ok := tf["classification_tags"].(map[string]string)
			if !ok {
				t.Fatalf("classification_tags type = %T, want map[string]string (attacker shadowed it!)", tf["classification_tags"])
			}
			if tags[c.wantKey] != "proj-real" {
				t.Errorf("%s: attacker shadowed the sweep handle: %s = %q, want proj-real", c.name, c.wantKey, tags[c.wantKey])
			}
		})
	}
}

// ---------------------------------------------------------------------------
// kubeconfig.go — writeRawKubeconfig / writeExecKubeconfig were 0% covered.
// ---------------------------------------------------------------------------

func TestWriteRawKubeconfig(t *testing.T) {
	// Empty / whitespace-only input rejected.
	for _, in := range []string{"", "   \n\t"} {
		if err := writeRawKubeconfig(in, &bytes.Buffer{}); err == nil {
			t.Errorf("writeRawKubeconfig(%q) err = nil, want empty-kubeconfig error", in)
		}
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")
	var out bytes.Buffer
	const kc = "apiVersion: v1\nkind: Config\nclusters: []\n"
	if err := writeRawKubeconfig(kc, &out); err != nil {
		t.Fatalf("writeRawKubeconfig err = %v", err)
	}
	path := filepath.Join(home, ".alethia", "kubeconfig")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("kubeconfig not written: %v", err)
	}
	if string(data) != kc {
		t.Errorf("kubeconfig written verbatim? got %q, want %q", string(data), kc)
	}
	if os.Getenv("KUBECONFIG") != path {
		t.Errorf("KUBECONFIG = %q, want %q", os.Getenv("KUBECONFIG"), path)
	}
}

func TestWriteExecKubeconfig(t *testing.T) {
	// Missing endpoint / CA are hard errors (a broken kubeconfig must not be written).
	if err := writeExecKubeconfig("n", "", "ca", []string{"kube-token"}, &bytes.Buffer{}); err == nil {
		t.Error("missing endpoint should error")
	}
	if err := writeExecKubeconfig("n", "https://api.test", "", []string{"kube-token"}, &bytes.Buffer{}); err == nil {
		t.Error("missing CA should error")
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")
	var out bytes.Buffer
	args := []string{"kube-token", "--provider", "aws", "--cluster", "c1"}
	if err := writeExecKubeconfig("arn:cluster", "https://api.test:443", "Y2FkYXRh", args, &out); err != nil {
		t.Fatalf("writeExecKubeconfig err = %v", err)
	}
	path := filepath.Join(home, ".alethia", "kubeconfig")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("kubeconfig not written: %v", err)
	}

	// Parse the YAML and assert the exec-plugin wiring.
	var parsed struct {
		Clusters []struct {
			Cluster struct {
				Server string `yaml:"server"`
				CAData string `yaml:"certificate-authority-data"`
			} `yaml:"cluster"`
		} `yaml:"clusters"`
		Users []struct {
			User struct {
				Exec struct {
					Command string   `yaml:"command"`
					Args    []string `yaml:"args"`
				} `yaml:"exec"`
			} `yaml:"user"`
		} `yaml:"users"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("kubeconfig is not valid YAML: %v", err)
	}
	if len(parsed.Clusters) != 1 || parsed.Clusters[0].Cluster.Server != "https://api.test:443" {
		t.Errorf("cluster server wrong: %#v", parsed.Clusters)
	}
	if parsed.Clusters[0].Cluster.CAData != "Y2FkYXRh" {
		t.Errorf("CA data wrong: %q", parsed.Clusters[0].Cluster.CAData)
	}
	if len(parsed.Users) != 1 {
		t.Fatalf("users = %d, want 1", len(parsed.Users))
	}
	// command must be an absolute path (the runner binary), never a bare "runner"
	// that a writable job workdir could hijack; os.Executable() gives an absolute path.
	if !filepath.IsAbs(parsed.Users[0].User.Exec.Command) {
		t.Errorf("exec command not absolute: %q", parsed.Users[0].User.Exec.Command)
	}
	if strings.Join(parsed.Users[0].User.Exec.Args, " ") != strings.Join(args, " ") {
		t.Errorf("exec args = %v, want %v", parsed.Users[0].User.Exec.Args, args)
	}
}

// ---------------------------------------------------------------------------
// Azure build* helpers — partial coverage on the timer / recovery branches.
// ---------------------------------------------------------------------------

func TestAzureBuilders_ServiceBusQueues(t *testing.T) {
	ordered := true
	vis := 20
	ret := 120
	got := buildServiceBusQueues([]types.ProjectQueueConfig{{
		Name:              "q",
		Ordered:           &ordered,
		VisibilityTimeout: &vis,
		MessageRetention:  &ret,
		ProviderConfig:    map[string]any{"delay_seconds": float64(9)},
	}})
	q := got["q"].(map[string]interface{})
	if q["requires_session"] != true {
		t.Errorf("requires_session = %v, want true", q["requires_session"])
	}
	if q["lock_duration"] != "PT20S" {
		t.Errorf("lock_duration = %v, want PT20S", q["lock_duration"])
	}
	if q["default_message_ttl"] != "PT120S" {
		t.Errorf("default_message_ttl = %v, want PT120S", q["default_message_ttl"])
	}
	if q["delay_seconds"] != 9 {
		t.Errorf("delay_seconds = %v, want 9", q["delay_seconds"])
	}

	// Defaults when nothing set: ISO-8601 PT1M lock, max_delivery_count 10, no session key.
	def := buildServiceBusQueues([]types.ProjectQueueConfig{{Name: "d"}})["d"].(map[string]interface{})
	if def["lock_duration"] != "PT1M" || def["max_delivery_count"] != 10 {
		t.Errorf("defaults wrong: %#v", def)
	}
	if _, ok := def["requires_session"]; ok {
		t.Error("requires_session must be absent when Ordered is nil")
	}
}

func TestAzureBuilders_CosmosDBCollections(t *testing.T) {
	got := buildCosmosDBCollections([]types.ProjectNosqlConfig{
		{Name: "explicit", PartitionKey: "/tenant", PointInTimeRecovery: true},
		{Name: "defaulted"},
	})
	if got[0]["partition_key"] != "/tenant" {
		t.Errorf("partition_key = %v, want /tenant", got[0]["partition_key"])
	}
	if got[0]["analytical_storage_enabled"] != true {
		t.Errorf("PITR table should set analytical_storage_enabled: %#v", got[0])
	}
	if got[1]["partition_key"] != "/id" {
		t.Errorf("default partition_key = %v, want /id", got[1]["partition_key"])
	}
	if _, ok := got[1]["analytical_storage_enabled"]; ok {
		t.Error("no-PITR table must not set analytical_storage_enabled")
	}
}

func TestAzureBuilders_Containers(t *testing.T) {
	got := buildAzureContainers([]types.ProjectStorageBucketConfig{
		{Name: "pub", PublicAccess: true},
		{Name: "priv"},
	})
	if got[0]["container_access_type"] != "blob" {
		t.Errorf("public container access = %v, want blob", got[0]["container_access_type"])
	}
	if got[1]["container_access_type"] != "private" {
		t.Errorf("private container access = %v, want private", got[1]["container_access_type"])
	}
}

// TestResolveCacheNodeType_PrefersAbstractMemoryGB asserts the DOCUMENTED precedence (abstract
// MemoryGB first, legacy NodeType fallback) now enforced (#1002) — matching resolveDBEngine and
// the file-level invariant.
func TestResolveCacheNodeType_PrefersAbstractMemoryGB(t *testing.T) {
	// gcp 4GB resolves to catalog tier "M2"; a stale legacy NodeType must NOT win.
	if got := resolveCacheNodeType("gcp", types.ProjectCacheConfig{MemoryGB: 4, NodeType: "cache.legacy.stale"}); got != "M2" {
		t.Errorf("abstract MemoryGB must win: got %q, want M2", got)
	}
	// With no MemoryGB, the legacy NodeType is the fallback.
	if got := resolveCacheNodeType("gcp", types.ProjectCacheConfig{NodeType: "cache.legacy.explicit"}); got != "cache.legacy.explicit" {
		t.Errorf("legacy NodeType fallback: got %q, want cache.legacy.explicit", got)
	}
}
