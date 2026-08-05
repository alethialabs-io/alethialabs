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
		"provision_ack":     true,
		"create_mns":        true,
		"create_kvstore":    true,
		"create_ots":        true,
		"create_oss":        true,
		"create_rds":        true,
		"provision_network": true,
		"single_cloud_nat":  true,
		// FALSE, and that is the fix: this fixture supplies ZoneID "zone-1", so the caller already
		// owns a domain and the template must NOT register a second one (#1992). `alidns_enabled`
		// is the CREATE gate, not an "is DNS on" flag. See TestExistingZoneSuppressesZoneCreation.
		"alidns_enabled":             false,
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
	if _, ok := def["subnet_ids"]; ok {
		t.Error("subnet_ids must be absent when provisioning a new network")
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
	// No subnet selection => subnet_ids stays absent (auto-discover the VPC's vSwitches).
	if _, ok := byo["subnet_ids"]; ok {
		t.Error("subnet_ids must be absent when no subnets were selected")
	}

	// BYO network WITH an explicit vSwitch selection => passthrough the ordered ids.
	byoSubnets := (&alibabaProvider{}).ProviderTfvars(&types.ProjectConfig{
		ProjectName: "p",
		Network: types.ProjectNetworkConfig{
			ProvisionNetwork: false,
			NetworkID:        "vpc-123",
			SubnetIDs:        []string{"vsw-a", "vsw-b"},
		},
	})
	gotVsw, ok := byoSubnets["subnet_ids"].([]string)
	if !ok {
		t.Fatalf("subnet_ids = %v (%T), want []string", byoSubnets["subnet_ids"], byoSubnets["subnet_ids"])
	}
	if len(gotVsw) != 2 || gotVsw[0] != "vsw-a" || gotVsw[1] != "vsw-b" {
		t.Errorf("subnet_ids = %v, want [vsw-a vsw-b] in order", gotVsw)
	}
}

// TestAzureProviderTfvars_NetworkModes covers the brownfield vnet_id + subnet selection
// passthrough (#1352): both keys are absent when provisioning a new VNet, and only the
// subnet selection is written when the user picked one. (The provider derives its internal
// provisionVnet flag from Network.ProvisionNetwork.)
func TestAzureProviderTfvars_NetworkModes(t *testing.T) {
	newCfg := func(net types.ProjectNetworkConfig) *types.ProjectConfig {
		return &types.ProjectConfig{
			ProjectName: "p",
			Cluster:     types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
			DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			Network:     net,
		}
	}
	vnetID := "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet"

	// New VNet: neither vnet_id nor subnet_ids is written.
	def := (&azureProvider{}).ProviderTfvars(newCfg(types.ProjectNetworkConfig{ProvisionNetwork: true}))
	if _, ok := def["vnet_id"]; ok {
		t.Error("vnet_id must be absent when provisioning a new VNet")
	}
	if _, ok := def["subnet_ids"]; ok {
		t.Error("subnet_ids must be absent when provisioning a new VNet")
	}

	// BYO VNet, no subnet selection: vnet_id passes through, subnet_ids stays absent.
	byo := (&azureProvider{}).ProviderTfvars(newCfg(types.ProjectNetworkConfig{ProvisionNetwork: false, NetworkID: vnetID}))
	if byo["vnet_id"] != vnetID {
		t.Errorf("vnet_id = %v, want %v", byo["vnet_id"], vnetID)
	}
	if _, ok := byo["subnet_ids"]; ok {
		t.Error("subnet_ids must be absent when no subnets were selected")
	}

	// BYO VNet WITH an explicit subnet selection => passthrough the ordered names.
	byoSubnets := (&azureProvider{}).ProviderTfvars(newCfg(types.ProjectNetworkConfig{
		ProvisionNetwork: false,
		NetworkID:        vnetID,
		SubnetIDs:        []string{"aks-subnet"},
	}))
	got, ok := byoSubnets["subnet_ids"].([]string)
	if !ok {
		t.Fatalf("subnet_ids = %v (%T), want []string", byoSubnets["subnet_ids"], byoSubnets["subnet_ids"])
	}
	if len(got) != 1 || got[0] != "aks-subnet" {
		t.Errorf("subnet_ids = %v, want [aks-subnet]", got)
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
	// `primary_keys`, a LIST — not the scalar `primary_key` / `primary_key_type` this asserted until
	// #1836. Those two names were read by NOTHING: modules/ots/main.tf takes
	// `try(each.value.primary_keys, [{ name = "id", type = "String" }])`, so `try` caught the miss and
	// every table was built on `id`/`String`. This test passed throughout, which is the lesson — it
	// checked that the builder agreed with itself, never that it agreed with the template.
	for i, want := range wantTypes {
		keys, ok := tables[i]["primary_keys"].([]map[string]interface{})
		if !ok || len(keys) != 1 {
			t.Fatalf("table[%d] primary_keys = %#v, want one key", i, tables[i]["primary_keys"])
		}
		if keys[0]["type"] != want {
			t.Errorf("table[%d] key type = %v, want %v", i, keys[0]["type"], want)
		}
		if keys[0]["name"] != "pk" {
			t.Errorf("table[%d] key name = %v, want pk", i, keys[0]["name"])
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

// TestAlibabaBuilders_OSSEncryption pins the INVARIANT that both positions of
// `bucket:encryption_enabled` are carried into the tfvars as a VALUE, never as the presence or
// absence of a key.
//
// This matters more on Alibaba than anywhere else. S3, GCS and Blob encrypt at rest
// unconditionally, so an uncarried switch there is cosmetic and those three cells are documented
// exclusions. OSS applies NO default server-side encryption to a new bucket — GetBucketEncryption
// answers 400 NoSuchServerSideEncryptionRule — so an uncarried switch means the tenant's objects
// are stored unencrypted (#1814).
//
// The OFF assertion is the load-bearing one. A builder that emitted the key only inside
// `if b.EncryptionEnabled` would satisfy every ON assertion and still leave the OFF position falling
// through to whatever the template happens to default to — a gap that scores green (#1829).
// Asserting that OFF is PRESENT and equal to "None" is what distinguishes a carried switch from a
// half-carried one, so this must never be relaxed to a presence-only check.
func TestAlibabaBuilders_OSSEncryption(t *testing.T) {
	got := buildOSSBuckets([]types.ProjectStorageBucketConfig{
		{Name: "on", EncryptionEnabled: true},
		{Name: "off", EncryptionEnabled: false},
		{Name: "kms", EncryptionEnabled: true, ProviderConfig: map[string]any{"encryption_algorithm": "KMS"}},
		// An algorithm named while the switch is OFF must not resurrect the rule: the switch decides
		// WHETHER there is encryption, provider_config only decides which kind.
		{Name: "off-with-algo", EncryptionEnabled: false, ProviderConfig: map[string]any{"encryption_algorithm": "KMS"}},
	})
	if len(got) != 4 {
		t.Fatalf("buckets = %d, want 4", len(got))
	}

	// ON defaults to AES256 (SSE-OSS), which Alibaba bills as "None. Free of charge." SSE-KMS is a
	// per-call charge, so it must never become the default by accident.
	if got[0]["sse_algorithm"] != "AES256" {
		t.Errorf("encryption on: sse_algorithm = %v, want AES256", got[0]["sse_algorithm"])
	}

	// OFF must be PRESENT and explicit. Presence is asserted separately from the value so that a
	// future drift to a branch-guarded emit fails here with a message naming which half broke.
	off, ok := got[1]["sse_algorithm"]
	if !ok {
		t.Fatal("encryption off: sse_algorithm is absent — the OFF position must be emitted, not left to the template default")
	}
	if off != "None" {
		t.Errorf("encryption off: sse_algorithm = %v, want None", off)
	}

	if got[2]["sse_algorithm"] != "KMS" {
		t.Errorf("explicit algorithm: sse_algorithm = %v, want KMS", got[2]["sse_algorithm"])
	}
	if got[3]["sse_algorithm"] != "None" {
		t.Errorf("off with an algorithm named: sse_algorithm = %v, want None", got[3]["sse_algorithm"])
	}

	// The two positions must actually DIFFER. Every assertion above would also hold for a builder
	// that returned a constant, if that constant happened to match — this is the cheap guard against
	// a switch that is carried in name only.
	if got[0]["sse_algorithm"] == got[1]["sse_algorithm"] {
		t.Error("the ON and OFF positions emit the same value — the switch reaches the plan but decides nothing")
	}
}

// TestAlibabaBuilders_OSSNameSuffix pins the key name the template keys its for_each on.
//
// #1834: this builder emitted `name_suffix` while modules/oss read `b.name`, so every Alibaba
// project that carried a bucket died at plan with "This object does not have an attribute named
// name" — a template that had never once planned. The TEMPLATE was corrected to `name_suffix` (the
// spelling AWS's s3 and GCP's cloud-storage modules already use) rather than this builder to
// `name`, so this test is what stops the Go side drifting back and re-opening the hole from the
// other direction.
func TestAlibabaBuilders_OSSNameSuffix(t *testing.T) {
	got := buildOSSBuckets([]types.ProjectStorageBucketConfig{{Name: "assets"}})
	if got[0]["name_suffix"] != "assets" {
		t.Errorf("name_suffix = %v, want assets", got[0]["name_suffix"])
	}
	// The module composes the real bucket name as name_prefix-name_suffix, because OSS bucket names
	// are globally unique across all of Alibaba Cloud. A bare `name` would be both undeclared by the
	// module's object type (and therefore silently discarded) and unusable as a bucket name.
	if _, ok := got[0]["name"]; ok {
		t.Error("buildOSSBuckets emitted `name`; modules/oss declares `name_suffix` and would discard it")
	}
}

// TestAlibabaBuilders_OSSSSEAlgorithm covers the resolver directly, including the value the module's
// allow-list refuses. "SM4" is accepted by the alicloud provider's ValidateFunc but rejected by
// PutBucketEncryption with InvalidEncryptionAlgorithmError, so it is passed through here and stopped
// at plan time by the root `oss_buckets` validation — a plan-time error rather than an apply-time
// 400. This test records that the split is deliberate: the resolver does not silently rewrite what a
// tenant asked for.
func TestAlibabaBuilders_OSSSSEAlgorithm(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  map[string]any
		want string
	}{
		{"nil provider_config defaults to the free algorithm", nil, "AES256"},
		{"empty provider_config defaults to the free algorithm", map[string]any{}, "AES256"},
		{"an empty string is not a choice", map[string]any{"encryption_algorithm": ""}, "AES256"},
		{"a non-string is not a choice", map[string]any{"encryption_algorithm": 7}, "AES256"},
		{"an explicit choice wins", map[string]any{"encryption_algorithm": "KMS"}, "KMS"},
		{"an api-invalid choice is passed through for the template to refuse", map[string]any{"encryption_algorithm": "SM4"}, "SM4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ossSSEAlgorithm(types.ProjectStorageBucketConfig{ProviderConfig: tc.cfg})
			if got != tc.want {
				t.Errorf("ossSSEAlgorithm = %q, want %q", got, tc.want)
			}
		})
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

	// Defaults when nothing set: ISO-8601 PT1M lock, max_delivery_count 10, sessions explicitly OFF.
	def := buildServiceBusQueues([]types.ProjectQueueConfig{{Name: "d"}})["d"].(map[string]interface{})
	if def["lock_duration"] != "PT1M" || def["max_delivery_count"] != 10 {
		t.Errorf("defaults wrong: %#v", def)
	}
	// requires_session is emitted for EVERY queue since #1812, the untouched switch included. It
	// used to be OMITTED when Ordered was nil, which made the tfvars shape depend on whether a user
	// had ever opened the field; the module types it `optional(bool, false)`, so the explicit OFF
	// position plans identically. The cross-cloud assertions live in queue_ordered_parity_test.go.
	if def["requires_session"] != false {
		t.Errorf("requires_session = %v, want false when Ordered is nil", def["requires_session"])
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
	if got[1]["partition_key"] != "/id" {
		t.Errorf("default partition_key = %v, want /id", got[1]["partition_key"])
	}
	// The PITR switch itself is pinned by TestAzureCosmos_PITRIsContinuousBackupNotAnalyticalStorage
	// (azure_cosmos_pitr_test.go), which also holds the line against the #1838 wiring.
	if got[0]["point_in_time_recovery"] != true || got[1]["point_in_time_recovery"] != false {
		t.Errorf("point_in_time_recovery must mirror the switch on every table: %#v", got)
	}
}

// TestAzureBuilders_Containers pins the tfvar KEY as well as the value. The key is the whole of the
// bug this replaced: `container_access_type` is the azurerm RESOURCE's spelling, while the module
// declares and reads `access_type`, so the value landed on a name nothing read.
func TestAzureBuilders_Containers(t *testing.T) {
	got := buildAzureContainers([]types.ProjectStorageBucketConfig{
		{Name: "pub", PublicAccess: true},
		{Name: "priv"},
	})
	if got[0]["access_type"] != "blob" {
		t.Errorf("public container access = %v, want blob", got[0]["access_type"])
	}
	if got[1]["access_type"] != "private" {
		t.Errorf("private container access = %v, want private", got[1]["access_type"])
	}
	for i, c := range got {
		if _, ok := c["container_access_type"]; ok {
			t.Errorf("container %d emits container_access_type; the module declares access_type", i)
		}
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
