// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Generic provider_config passthrough (B1): an arbitrary key that names a template
// variable flows through to tfvars verbatim, for each cloud.
func TestProviderTfvars_GenericPassthrough(t *testing.T) {
	cases := []struct {
		name     string
		provider CloudProvider
		key      string // a template var only reachable via passthrough
	}{
		{"aws", &awsProvider{}, "eks_volume_iops"},
		{"gcp", &gcpProvider{}, "gke_logging_service"},
		{"azure", &azureProvider{}, "aks_sku_tier"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				ProjectName: "p",
				Cluster: types.ProjectClusterConfig{
					ProviderConfig: map[string]any{tc.key: "custom"},
				},
			}
			tfvars := tc.provider.ProviderTfvars(cfg)
			if tfvars[tc.key] != "custom" {
				t.Errorf("%s: expected passthrough key %q=custom, got %v", tc.name, tc.key, tfvars[tc.key])
			}
		})
	}
}

// AKS admin-group object ids (BYOC B4.1 + A2.2) are the UNION of cluster_admins' groups and an
// explicit provider_config["aks_admin_group_object_ids"] list — deduped, sorted, and set on the
// aks_admin_group_object_ids tfvar; the provider_config key is reserved so it is NOT re-injected
// verbatim. When neither source supplies an id, the tfvar is absent (AAD RBAC block stays off).
func TestAzureProviderTfvars_AKSAdminGroupUnion(t *testing.T) {
	t.Run("union of cluster_admins + provider_config, deduped+sorted", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			ProjectName: "p",
			Cluster: types.ProjectClusterConfig{
				ClusterAdmins: []any{
					map[string]any{"username": "ops", "groups": []any{"bbbb", "cccc"}},
				},
				ProviderConfig: map[string]any{
					"aks_admin_group_object_ids": []any{"aaaa", "cccc"}, // cccc dup, aaaa new
				},
			},
		}
		tf := (&azureProvider{}).ProviderTfvars(cfg)
		ids, ok := tf["aks_admin_group_object_ids"].([]string)
		if !ok {
			t.Fatalf("aks_admin_group_object_ids type = %T, want []string", tf["aks_admin_group_object_ids"])
		}
		want := []string{"aaaa", "bbbb", "cccc"}
		if len(ids) != len(want) {
			t.Fatalf("ids = %#v, want %#v", ids, want)
		}
		for i := range want {
			if ids[i] != want[i] {
				t.Fatalf("ids = %#v, want %#v (deduped+sorted)", ids, want)
			}
		}
	})
	t.Run("provider_config-only (the e2e self-admin path)", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			ProjectName: "p",
			Cluster: types.ProjectClusterConfig{
				ProviderConfig: map[string]any{"aks_admin_group_object_ids": []any{"dddd"}},
			},
		}
		tf := (&azureProvider{}).ProviderTfvars(cfg)
		ids, _ := tf["aks_admin_group_object_ids"].([]string)
		if len(ids) != 1 || ids[0] != "dddd" {
			t.Fatalf("ids = %#v, want [dddd]", tf["aks_admin_group_object_ids"])
		}
	})
	t.Run("absent when neither source supplies an id", func(t *testing.T) {
		cfg := &types.ProjectConfig{ProjectName: "p"}
		tf := (&azureProvider{}).ProviderTfvars(cfg)
		if _, ok := tf["aks_admin_group_object_ids"]; ok {
			t.Error("aks_admin_group_object_ids should be absent so the AAD RBAC block stays off")
		}
	})
}

// Typed mappings must win over a same-named provider_config key (merge-if-absent),
// so the UI can't accidentally clobber a validated value.
func TestProviderTfvars_TypedWinsOverPassthrough(t *testing.T) {
	p := &awsProvider{}
	cfg := &types.ProjectConfig{
		ProjectName: "p",
		Cluster: types.ProjectClusterConfig{
			ClusterVersion: "1.30",
			// try to override the typed eks_cluster_version via passthrough
			ProviderConfig: map[string]any{"eks_cluster_version": "9.99"},
		},
	}
	tfvars := p.ProviderTfvars(cfg)
	if tfvars["eks_cluster_version"] != "1.30" {
		t.Errorf("typed value should win: eks_cluster_version = %v, want 1.30", tfvars["eks_cluster_version"])
	}
}

// Reserved keys (consumed under a different tfvar name) are not injected verbatim.
func TestProviderTfvars_ReservedKeysNotInjected(t *testing.T) {
	p := &awsProvider{}
	cfg := &types.ProjectConfig{
		ProjectName: "p",
		Cluster:     types.ProjectClusterConfig{ProviderConfig: map[string]any{"enable_karpenter": true}},
		DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{"cloudfront_waf": true}},
	}
	tfvars := p.ProviderTfvars(cfg)
	if _, ok := tfvars["cloudfront_waf"]; ok {
		t.Error("reserved key cloudfront_waf should not be injected verbatim (consumed as cloudfront_waf_enabled)")
	}
	if tfvars["cloudfront_waf_enabled"] != true {
		t.Errorf("cloudfront_waf_enabled should be true, got %v", tfvars["cloudfront_waf_enabled"])
	}
	// enable_karpenter IS a real template var, so the typed mapping sets it.
	if tfvars["enable_karpenter"] != true {
		t.Errorf("enable_karpenter = %v, want true", tfvars["enable_karpenter"])
	}
}

// High-value parity knobs (B3) map to the right per-cloud template variable.
func TestProviderTfvars_ParityKnobs(t *testing.T) {
	disk := intPtr(120)

	t.Run("aws", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Cluster:   types.ProjectClusterConfig{NodeDiskSizeGB: disk},
			Databases: []types.ProjectDatabaseConfig{{Name: "d", InstanceClass: "db.r6g.large"}},
			Caches:    []types.ProjectCacheConfig{{Name: "c", EngineVersion: "7.0"}},
		}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		assertEq(t, tf, "eks_disk_size", 120)
		assertEq(t, tf, "rds_instance_type", "db.r6g.large")
		assertEq(t, tf, "redis_engine_version", "7.0")
		// The parameter-group family tracks the picked version's major (#977).
		assertEq(t, tf, "redis_family", "redis7")
	})

	t.Run("gcp", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Cluster:   types.ProjectClusterConfig{NodeDiskSizeGB: disk},
			Databases: []types.ProjectDatabaseConfig{{Name: "d", InstanceClass: "db-custom-2-7680"}},
			Caches:    []types.ProjectCacheConfig{{Name: "c", EngineVersion: "REDIS_7_0"}},
		}
		tf := (&gcpProvider{}).ProviderTfvars(cfg)
		assertEq(t, tf, "gke_disk_size_gb", 120)
		assertEq(t, tf, "cloud_sql_tier", "db-custom-2-7680")
		assertEq(t, tf, "memorystore_redis_version", "REDIS_7_0")
	})

	t.Run("azure", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Cluster:   types.ProjectClusterConfig{NodeDiskSizeGB: disk},
			Databases: []types.ProjectDatabaseConfig{{Name: "d", InstanceClass: "GP_Standard_D2s_v3"}},
			Caches:    []types.ProjectCacheConfig{{Name: "c", EngineVersion: "6"}},
		}
		tf := (&azureProvider{}).ProviderTfvars(cfg)
		assertEq(t, tf, "aks_disk_size_gb", 120)
		assertEq(t, tf, "azure_db_sku_name", "GP_Standard_D2s_v3")
		// azure_cache_redis_version is NOT emitted any more (#1993), and asserting its absence is
		// the point: Azure Cache for Redis is retired, so the kind runs on azurerm_managed_redis,
		// which accepts no engine-version argument in any spelling. Emitting one would be dropped
		// at plan time while the parity guards scored the cell as carried.
		if _, present := tf["azure_cache_redis_version"]; present {
			t.Error("azure_cache_redis_version is emitted again — Azure Managed Redis has no version knob to carry it to")
		}
	})
}

// A picked cache engine version keeps redis_family in lock-step with the version's major, and a
// valkey pick routes to the valkey var instead of corrupting redis_engine_version (#977).
func TestProviderTfvars_CacheEngineVersionRouting(t *testing.T) {
	t.Run("redis version derives the family", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Caches: []types.ProjectCacheConfig{
				{Name: "c", Engine: types.CacheEngineRedis, EngineVersion: "6.2"},
			},
		}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		assertEq(t, tf, "redis_engine_version", "6.2")
		assertEq(t, tf, "redis_family", "redis6")
	})

	t.Run("valkey version routes to the valkey var, leaving redis at its base default", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Caches: []types.ProjectCacheConfig{
				{Name: "c", Engine: types.CacheEngineValkey, EngineVersion: "8.0"},
			},
		}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		assertEq(t, tf, "valkey_engine_version", "8.0")
		// The valkey version must NOT land in redis_engine_version — it stays at the base default.
		assertEq(t, tf, "redis_engine_version", "7.1")
	})
}

// Defaults-preserve: with none of the new knobs set, the new fields must not leak
// keys into tfvars (so existing deploys are byte-for-byte unchanged).
func TestProviderTfvars_DefaultsUnchanged(t *testing.T) {
	for _, p := range []CloudProvider{&awsProvider{}, &gcpProvider{}, &azureProvider{}} {
		cfg := &types.ProjectConfig{
			ProjectName: "p",
			Databases:   []types.ProjectDatabaseConfig{{Name: "d"}},
			Caches:      []types.ProjectCacheConfig{{Name: "c"}},
		}
		tf := p.ProviderTfvars(cfg)
		for _, k := range []string{"eks_disk_size", "gke_disk_size_gb", "aks_disk_size_gb", "cloud_sql_tier", "azure_db_sku_name"} {
			if _, ok := tf[k]; ok {
				t.Errorf("%s: %q should be absent when no knob is set (let the template default apply)", p.Name(), k)
			}
		}
	}
}

func assertEq(t *testing.T, tf map[string]interface{}, key string, want interface{}) {
	t.Helper()
	if tf[key] != want {
		t.Errorf("%s = %v (%T), want %v (%T)", key, tf[key], tf[key], want, want)
	}
}

// TestProviderTfvars_NodeShapeAndSecretKeepersAreReachable pins the ONE fact that makes a newly
// declared template variable worth declaring: a customer can actually set it.
//
// Declaring a variable in variables.tf is necessary and not sufficient. The knob is reachable only
// if `mergeProviderConfig` carries the key from the component's provider_config onto a same-named
// tfvar, and it will NOT if the provider reserves the key (consumed above under a different tfvar
// name) or if the component's provider_config is never passed to mergeProviderConfig at all —
// which is the live state of ProjectContainerRegistryConfig, whose ProviderConfig field no
// provider reads. So "the template declares it" and "a user can set it" are two claims, and this
// test is the second one, per cloud, for every variable added by the template-parity pass.
//
// Every key here is checked against the tfvar name the template declares. A rename on either side
// breaks this test, which is the point: the two halves cannot drift apart silently.
func TestProviderTfvars_NodeShapeAndSecretKeepersAreReachable(t *testing.T) {
	cases := []struct {
		cloud    string
		provider CloudProvider
		// cluster knobs, set through the CLUSTER component's provider_config
		clusterKeys []string
		// secret-rotation keepers, also a cluster-scoped passthrough today
		secretKeys []string
	}{
		{
			cloud:    "gcp",
			provider: &gcpProvider{},
			clusterKeys: []string{
				"gke_volume_iops", "gke_volume_throughput", "gke_spot", "gke_preemptible", "gke_disk_type",
			},
			secretKeys: []string{"custom_secret_keepers"},
		},
		{
			cloud:    "azure",
			provider: &azureProvider{},
			clusterKeys: []string{
				"aks_os_disk_type", "aks_spot_enabled", "aks_spot_max_price",
				"aks_spot_eviction_policy", "aks_spot_node_min_size", "aks_spot_node_max_size",
			},
			secretKeys: []string{"custom_secret_keepers"},
		},
		{
			cloud:    "alibaba",
			provider: &alibabaProvider{},
			clusterKeys: []string{
				"ack_disk_category", "ack_disk_performance_level", "ack_disk_provisioned_iops",
				"ack_node_capacity_type", "ack_spot_price_limit",
			},
			secretKeys: []string{"custom_secret_keepers"},
		},
	}

	root := templateRepoRoot(t)

	for _, tc := range cases {
		t.Run(tc.cloud, func(t *testing.T) {
			keys := append(append([]string{}, tc.clusterKeys...), tc.secretKeys...)

			// HALF ONE — the template really declares the name. Re-scraped from the .tf on every
			// run rather than asserted from memory, the way validate_drift_test.go binds the disk
			// floors: without this the test below passes for ANY string, because the passthrough
			// is generic and will happily carry a key no template has ever heard of. A test that
			// green-lights an undeclared knob is the exact "green cell, dead feature" failure the
			// offer-parity guard exists to prevent, reproduced in Go.
			rel := "infra/templates/project/" + tc.cloud + "/variables.tf"
			src := readTemplateSource(t, root, rel)
			for _, k := range keys {
				declared := regexp.MustCompile(`(?m)^variable "` + regexp.QuoteMeta(k) + `"`)
				if !declared.MatchString(src) {
					t.Errorf("%s: %s declares no `variable %q` — the Go side would pass this key "+
						"through to a tfvar the template does not accept, and tofu would refuse the "+
						"apply with an undeclared-variable error", tc.cloud, rel, k)
				}
			}

			// HALF TWO — a customer's provider_config actually reaches that tfvar.
			pc := map[string]any{}
			for _, k := range keys {
				pc[k] = "set-by-the-customer"
			}
			cfg := &types.ProjectConfig{
				ProjectName: "p",
				Cluster:     types.ProjectClusterConfig{ProviderConfig: pc},
			}
			tf := tc.provider.ProviderTfvars(cfg)
			for k := range pc {
				if tf[k] != "set-by-the-customer" {
					t.Errorf("%s: %q is declared in the template but did NOT survive the provider_config "+
						"passthrough (got %v) — the knob is unreachable, which is the unwired-template "+
						"defect rather than a closed parity gap", tc.cloud, k, tf[k])
				}
			}
		})
	}
}

// The behavior-preserving half of the same change: a project that sets none of the new knobs must
// emit none of them, so the template's own (deliberately unchanged) defaults apply and an existing
// deploy plans byte-for-byte as before.
func TestProviderTfvars_NodeShapeKnobsAbsentByDefault(t *testing.T) {
	absent := map[string][]string{
		"gcp": {"gke_volume_iops", "gke_volume_throughput", "gke_spot", "gke_preemptible", "custom_secret_keepers"},
		"azure": {
			"aks_os_disk_type", "aks_spot_enabled", "aks_spot_max_price",
			"aks_spot_eviction_policy", "aks_spot_node_min_size", "aks_spot_node_max_size",
			"custom_secret_keepers",
		},
		"alibaba": {
			"ack_disk_category", "ack_disk_performance_level", "ack_disk_provisioned_iops",
			"ack_node_capacity_type", "ack_spot_price_limit", "custom_secret_keepers",
		},
	}
	providers := map[string]CloudProvider{
		"gcp":     &gcpProvider{},
		"azure":   &azureProvider{},
		"alibaba": &alibabaProvider{},
	}

	for cloudName, keys := range absent {
		t.Run(cloudName, func(t *testing.T) {
			tf := providers[cloudName].ProviderTfvars(&types.ProjectConfig{ProjectName: "p"})
			for _, k := range keys {
				if _, ok := tf[k]; ok {
					t.Errorf("%s: %q must be ABSENT when nothing asked for it (got %v) — emitting it "+
						"would pin the template default into every project's tfvars and turn a later "+
						"default change into a silent no-op", cloudName, k, tf[k])
				}
			}
		})
	}
}

// The cache allow-list the canvas collects reaches the ElastiCache security
// group's tfvar, an unset list leaves the base empty default untouched (so
// existing deploys are unchanged), and valkey — whose serverless module
// consumes no CIDR input — never emits it (#1981).
func TestProviderTfvars_CacheAllowedCidrBlocks(t *testing.T) {
	t.Run("carried when set", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Caches: []types.ProjectCacheConfig{
				{Name: "c", AllowedCidrBlocks: []string{"10.1.0.0/16", "192.168.0.0/24"}},
			},
		}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		got, _ := tf["redis_allowed_cidr_blocks"].([]string)
		if len(got) != 2 || got[0] != "10.1.0.0/16" || got[1] != "192.168.0.0/24" {
			t.Errorf("redis_allowed_cidr_blocks = %v, want the CIDRs the canvas collected", tf["redis_allowed_cidr_blocks"])
		}
	})
	t.Run("unset keeps the base empty default", func(t *testing.T) {
		cfg := &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c"}}}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		got, ok := tf["redis_allowed_cidr_blocks"].([]string)
		if !ok || len(got) != 0 {
			t.Errorf("redis_allowed_cidr_blocks = %v, want the empty base default", tf["redis_allowed_cidr_blocks"])
		}
	})
	t.Run("valkey never emits the list", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Caches: []types.ProjectCacheConfig{
				{Name: "c", Engine: types.CacheEngineValkey, AllowedCidrBlocks: []string{"10.1.0.0/16"}},
			},
		}
		tf := (&awsProvider{}).ProviderTfvars(cfg)
		got, ok := tf["redis_allowed_cidr_blocks"].([]string)
		if !ok || len(got) != 0 {
			t.Errorf("redis_allowed_cidr_blocks = %v on valkey, want the empty base default (valkey.tf consumes no CIDR input)", tf["redis_allowed_cidr_blocks"])
		}
	})
}

// The cache allow-list reaches the ApsaraDB KVStore whitelist tfvar on Alibaba
// (`kvstore_security_ips` -> `alicloud_kvstore_instance.security_ips`, probed
// against the pinned provider), and an unset list emits NOTHING — the template
// then renders no security_ips argument, so an existing cache keeps whatever
// whitelist it has (#2149, the alibaba leg of #1981).
func TestProviderTfvars_AlibabaCacheSecurityIps(t *testing.T) {
	t.Run("carried when set", func(t *testing.T) {
		cfg := &types.ProjectConfig{
			Caches: []types.ProjectCacheConfig{
				{Name: "c", AllowedCidrBlocks: []string{"10.1.0.0/16", "192.168.0.0/24"}},
			},
		}
		tf := (&alibabaProvider{}).ProviderTfvars(cfg)
		got, _ := tf["kvstore_security_ips"].([]string)
		if len(got) != 2 || got[0] != "10.1.0.0/16" || got[1] != "192.168.0.0/24" {
			t.Errorf("kvstore_security_ips = %v, want the CIDRs the canvas collected", tf["kvstore_security_ips"])
		}
	})
	t.Run("unset emits nothing so existing whitelists are untouched", func(t *testing.T) {
		cfg := &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c"}}}
		tf := (&alibabaProvider{}).ProviderTfvars(cfg)
		if v, ok := tf["kvstore_security_ips"]; ok {
			t.Errorf("kvstore_security_ips = %v when no list was set — emitting it would REPLACE an "+
				"existing instance's whitelist instead of leaving it alone", v)
		}
	})
}

// A global table's replica regions reach the template's `replicas` entry, a
// regional table never emits one, and unset renders the same shape as before
// (#1982).
func TestProviderTfvars_NosqlGlobalReplicas(t *testing.T) {
	cfg := &types.ProjectConfig{
		NosqlTables: []types.ProjectNosqlConfig{
			{Name: "g", TableType: "global", PartitionKey: "pk", GlobalReplicas: []string{"eu-west-1", "us-east-1"}},
			{Name: "r", TableType: "standard", PartitionKey: "pk", GlobalReplicas: []string{"eu-west-1"}},
			{Name: "g2", TableType: "global", PartitionKey: "pk"},
		},
	}
	tf := (&awsProvider{}).ProviderTfvars(cfg)

	global, _ := tf["ddb_global_table_configuration"].([]map[string]interface{})
	if len(global) != 2 {
		t.Fatalf("global tables = %d, want 2", len(global))
	}
	reps, _ := global[0]["replicas"].([]string)
	if len(reps) != 2 || reps[0] != "eu-west-1" || reps[1] != "us-east-1" {
		t.Errorf("global table replicas = %v, want the regions the canvas collected", global[0]["replicas"])
	}
	if _, present := global[1]["replicas"]; present {
		t.Errorf("a global table with no chosen regions must render the template default, not an empty override")
	}
	regional, _ := tf["ddb_table_configuration"].([]map[string]interface{})
	if len(regional) != 1 {
		t.Fatalf("regional tables = %d, want 1", len(regional))
	}
	if _, present := regional[0]["replicas"]; present {
		t.Errorf("a regional table must never emit replicas")
	}
}

// NumCacheNodes is withdrawn on Azure (#1993): the old wiring flipped the
// legacy tier to "Standard" and discarded the number (two nodes and twenty
// produced the same plan), and Azure Managed Redis has no node/replica/shard
// count for the number to become. The withdrawn knob must emit NOTHING — a
// tier flip wearing a count's name is exactly what the gated-carrier state
// exists to catch.
func TestProviderTfvars_AzureCacheNodeCountWithdrawn(t *testing.T) {
	three := 3
	cfg := &types.ProjectConfig{
		Caches: []types.ProjectCacheConfig{{Name: "c", NumCacheNodes: &three}},
	}
	tf := (&azureProvider{}).ProviderTfvars(cfg)
	if v, present := tf["azure_cache_sku"]; present {
		t.Errorf("azure_cache_sku = %v — the node count flips the tier again; it must emit nothing", v)
	}
}

// AllowedCidrBlocks is withdrawn on Azure caches (#2148): Managed Redis — the only cache Azure
// lets us deterministically create — has no CIDR firewall surface, in the service or in azurerm
// 4.81.0/5.0.1, and the two look-alikes are both traps: `public_network_access` is an on/off
// switch that discards every address typed, and NSP is not onboarded for any Microsoft.Cache type
// (docs/research/azure-cache-cidr.md). The withdrawn list must reach NO azure tfvar under any
// name — this walks every emitted value for the sentinel CIDR rather than guessing key names, so
// a future carrier smuggled in under a new key fails here until the exclusions ceiling is
// deliberately lifted.
func TestProviderTfvars_AzureCacheAllowedCidrBlocksWithdrawn(t *testing.T) {
	const sentinel = "203.0.113.0/24"
	cfg := &types.ProjectConfig{
		Caches: []types.ProjectCacheConfig{{Name: "c", AllowedCidrBlocks: []string{sentinel}}},
	}
	tf := (&azureProvider{}).ProviderTfvars(cfg)

	var contains func(v interface{}) bool
	contains = func(v interface{}) bool {
		switch x := v.(type) {
		case string:
			return x == sentinel
		case []string:
			for _, s := range x {
				if s == sentinel {
					return true
				}
			}
		case []interface{}:
			for _, e := range x {
				if contains(e) {
					return true
				}
			}
		case map[string]interface{}:
			for _, e := range x {
				if contains(e) {
					return true
				}
			}
		case []map[string]interface{}:
			for _, e := range x {
				if contains(e) {
					return true
				}
			}
		}
		return false
	}
	for key, v := range tf {
		if contains(v) {
			t.Errorf("tfvar %q carries the withdrawn cache CIDR %q — the control is a recorded ceiling on azure and must emit nothing", key, sentinel)
		}
	}
}

// ── the leaf passthrough: 5 clouds × 7 kinds (#4259) ──────────────────────────────────
//
// Every leaf component carries a `provider_config` JSONB, and until #4259 only the cluster, the DNS
// and the database handed theirs to mergeProviderConfig — a cache's, a queue's, a bucket's key was
// stored by the console and reached no tfvar. These tests pin the plumbing per CELL, because the
// shape differs: a cache is root-level variables on every cloud, a queue is one entry of a map, a
// bucket one element of a list, and a Firestore "table" is the project's one database. A test that
// only checked "the key is somewhere in tfvars" would pass a key that landed on the wrong object.

// leafProbeKey names a knob NO template declares, so nothing but the passthrough can place it.
const leafProbeKey = "x_probe_knob"

// leafProbeValue is what the probe carries; the tests look for this exact value where it should land.
const leafProbeValue = "probe"

// leafBogus is the colliding value a provider_config offers for a key the typed code already owns.
const leafBogus = "bogus"

// leafLocator finds the object a component's provider_config merges into: the root tfvars for a
// root-level component, or the component's own entry inside a map/list tfvar.
type leafLocator func(t *testing.T, tf map[string]interface{}) map[string]interface{}

// atRoot locates the root tfvars — cache on every cloud, registry on aws/azure, nosql on gcp.
func atRoot(t *testing.T, tf map[string]interface{}) map[string]interface{} { return tf }

// entryOfMap locates the named entry of a map(object) tfvar such as `sqs_queues`.
func entryOfMap(root, name string) leafLocator {
	return func(t *testing.T, tf map[string]interface{}) map[string]interface{} {
		t.Helper()
		m, ok := tf[root].(map[string]interface{})
		if !ok {
			t.Fatalf("tfvar %q = %T, want a map of entries", root, tf[root])
		}
		entry, ok := m[name].(map[string]interface{})
		if !ok {
			t.Fatalf("tfvar %q has no object entry %q (got %T)", root, name, m[name])
		}
		return entry
	}
}

// firstOfList locates the first element of a list(object) tfvar such as `bucket_configuration`.
func firstOfList(root string) leafLocator {
	return func(t *testing.T, tf map[string]interface{}) map[string]interface{} {
		t.Helper()
		l, ok := tf[root].([]map[string]interface{})
		if !ok || len(l) == 0 {
			t.Fatalf("tfvar %q = %#v, want a non-empty list of objects", root, tf[root])
		}
		return l[0]
	}
}

// tfvarsMentionKey walks every map nested anywhere inside the tfvars for a key of that name — the
// question an EXCLUDED cell asks, where the probe must land nowhere rather than somewhere specific.
func tfvarsMentionKey(v interface{}, key string) bool {
	switch x := v.(type) {
	case map[string]interface{}:
		if _, ok := x[key]; ok {
			return true
		}
		for _, e := range x {
			if tfvarsMentionKey(e, key) {
				return true
			}
		}
	case map[string]string:
		_, ok := x[key]
		return ok
	case []map[string]interface{}:
		for _, e := range x {
			if tfvarsMentionKey(e, key) {
				return true
			}
		}
	case []map[string]string:
		for _, e := range x {
			if tfvarsMentionKey(e, key) {
				return true
			}
		}
	case []interface{}:
		for _, e := range x {
			if tfvarsMentionKey(e, key) {
				return true
			}
		}
	}
	return false
}

// leafKinds is the row set of the passthrough table, in the order the issue names them.
var leafKinds = []string{"cache", "queue", "topic", "nosql", "bucket", "secret", "registry"}

// leafProviders is the column set of the passthrough table.
var leafProviders = map[string]CloudProvider{
	"aws":     &awsProvider{},
	"gcp":     &gcpProvider{},
	"azure":   &azureProvider{},
	"alibaba": &alibabaProvider{},
	"hetzner": &hetznerProvider{},
}

// leafConfig builds a project holding ONE component of the kind, whose provider_config is pc. The
// component names are what the locators look entries up by.
func leafConfig(kind string, pc map[string]any) *types.ProjectConfig {
	cfg := &types.ProjectConfig{ProjectName: "p"}
	switch kind {
	case "database":
		cfg.Databases = []types.ProjectDatabaseConfig{{Name: "d", ProviderConfig: pc}}
	case "cache":
		cfg.Caches = []types.ProjectCacheConfig{{Name: "c", ProviderConfig: pc}}
	case "queue":
		cfg.Queues = []types.ProjectQueueConfig{{Name: "q", ProviderConfig: pc}}
	case "topic":
		cfg.Topics = []types.ProjectTopicConfig{{Name: "t", ProviderConfig: pc}}
	case "nosql":
		cfg.NosqlTables = []types.ProjectNosqlConfig{{
			Name: "n", PartitionKey: "pk", TableType: types.NosqlTableTypeStandard, ProviderConfig: pc,
		}}
	case "bucket":
		cfg.StorageBuckets = []types.ProjectStorageBucketConfig{{Name: "b", ProviderConfig: pc}}
	case "secret":
		cfg.Secrets = []types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 16, ProviderConfig: pc}}
	case "registry":
		cfg.ContainerRegistries = []types.ProjectContainerRegistryConfig{{Name: "reg", ProviderConfig: pc}}
	}
	return cfg
}

// TestProviderTfvars_LeafPassthrough pins, per cloud × kind, WHERE a leaf component's
// provider_config lands: on the root tfvars, or on the component's own entry of the map/list
// variable the template models it as. A hetzner row with no OpenTofu surface for the kind carries
// the reason instead, and asserts the probe reaches NOTHING — an in-cluster chart's values are not
// a tfvar, and inventing a passthrough for one would emit a key tofu silently drops.
//
// The table is asserted COMPLETE (every cloud × every kind exactly once) before a row is run, so a
// deleted row cannot read as a passing one.
func TestProviderTfvars_LeafPassthrough(t *testing.T) {
	type leafCase struct {
		cloud, kind string
		// locate finds the object the probe must land on; nil for an excluded cell.
		locate leafLocator
		// excluded names why the cell has no OpenTofu surface for a passthrough to reach.
		excluded string
	}
	cases := []leafCase{
		// aws — the cache and the registry (`ecr_*`) are root-level; the rest are items.
		{cloud: "aws", kind: "cache", locate: atRoot},
		{cloud: "aws", kind: "queue", locate: entryOfMap("sqs_queues", "q")},
		{cloud: "aws", kind: "topic", locate: entryOfMap("sns_topics", "t")},
		{cloud: "aws", kind: "nosql", locate: firstOfList("ddb_table_configuration")},
		{cloud: "aws", kind: "bucket", locate: firstOfList("bucket_configuration")},
		{cloud: "aws", kind: "secret", locate: firstOfList("custom_secrets")},
		{cloud: "aws", kind: "registry", locate: atRoot},

		// gcp — a queue is a Pub/Sub topic with one subscription; Firestore is ONE database per
		// project, so nosql is root-level; a registry is an entry of `artifact_registry_repos`.
		{cloud: "gcp", kind: "cache", locate: atRoot},
		{cloud: "gcp", kind: "queue", locate: entryOfMap("pubsub_topics", "q")},
		{cloud: "gcp", kind: "topic", locate: entryOfMap("pubsub_topics", "t")},
		{cloud: "gcp", kind: "nosql", locate: atRoot},
		{cloud: "gcp", kind: "bucket", locate: firstOfList("cloud_storage_buckets")},
		{cloud: "gcp", kind: "secret", locate: firstOfList("custom_secrets")},
		{cloud: "gcp", kind: "registry", locate: entryOfMap("artifact_registry_repos", "reg")},

		// azure — the registry (`acr_sku`) is root-level; secrets share gcp's builder.
		{cloud: "azure", kind: "cache", locate: atRoot},
		{cloud: "azure", kind: "queue", locate: entryOfMap("service_bus_queues", "q")},
		{cloud: "azure", kind: "topic", locate: entryOfMap("service_bus_topics", "t")},
		{cloud: "azure", kind: "nosql", locate: firstOfList("cosmos_db_collections")},
		{cloud: "azure", kind: "bucket", locate: firstOfList("storage_containers")},
		{cloud: "azure", kind: "secret", locate: firstOfList("custom_secrets")},
		{cloud: "azure", kind: "registry", locate: atRoot},

		// alibaba — a registry is an entry of `cr_repos`, never an instance argument.
		{cloud: "alibaba", kind: "cache", locate: atRoot},
		{cloud: "alibaba", kind: "queue", locate: entryOfMap("mns_queues", "q")},
		{cloud: "alibaba", kind: "topic", locate: entryOfMap("mns_topics", "t")},
		{cloud: "alibaba", kind: "nosql", locate: firstOfList("ots_tables")},
		{cloud: "alibaba", kind: "bucket", locate: firstOfList("oss_buckets")},
		{cloud: "alibaba", kind: "secret", locate: firstOfList("custom_secrets")},
		{cloud: "alibaba", kind: "registry", locate: entryOfMap("cr_repos", "reg")},

		// hetzner — the bucket is the one leaf the Talos template provisions through OpenTofu.
		// Everything else is in-cluster, and the reason is recorded here until the exclusions
		// ledger for template knobs lands in its own lane.
		{cloud: "hetzner", kind: "bucket", locate: firstOfList("buckets")},
		{cloud: "hetzner", kind: "cache", excluded: "Valkey runs in-cluster as a Helm release; its knobs are chart values, not OpenTofu variables"},
		{cloud: "hetzner", kind: "queue", excluded: "RabbitMQ runs in-cluster as a Helm release; its knobs are chart values, not OpenTofu variables"},
		{cloud: "hetzner", kind: "topic", excluded: "RabbitMQ runs in-cluster as a Helm release; a topic is an exchange declared by the application, not a resource tofu provisions"},
		{cloud: "hetzner", kind: "nosql", excluded: "ScyllaDB runs in-cluster as a Helm release (#3228); its knobs are chart values, not OpenTofu variables"},
		{cloud: "hetzner", kind: "secret", excluded: "Vault runs in-cluster as a Helm release; the template declares no `custom_secrets` variable"},
		{cloud: "hetzner", kind: "registry", excluded: "Harbor runs in-cluster as a Helm release; the template's only registry surface is `incluster_registry_hosts`, a list(string) of mirror hosts with no per-registry object to merge into"},
	}

	// COMPLETENESS first: every cloud × kind exactly once.
	seen := map[string]int{}
	for _, tc := range cases {
		seen[tc.cloud+"/"+tc.kind]++
	}
	for cloud := range leafProviders {
		for _, kind := range leafKinds {
			if n := seen[cloud+"/"+kind]; n != 1 {
				t.Errorf("table has %d row(s) for %s/%s, want exactly 1 — a missing cell reads as a passing one", n, cloud, kind)
			}
		}
	}
	if len(cases) != len(leafProviders)*len(leafKinds) {
		t.Fatalf("table has %d rows, want %d (5 clouds × 7 kinds)", len(cases), len(leafProviders)*len(leafKinds))
	}

	for _, tc := range cases {
		t.Run(tc.cloud+"/"+tc.kind, func(t *testing.T) {
			if (tc.locate == nil) == (tc.excluded == "") {
				t.Fatalf("a row is either located or excluded with a reason, never both or neither")
			}
			tf := leafProviders[tc.cloud].ProviderTfvars(leafConfig(tc.kind, map[string]any{leafProbeKey: leafProbeValue}))
			if tc.excluded != "" {
				if tfvarsMentionKey(tf, leafProbeKey) {
					t.Errorf("%s/%s: the probe reached the tfvars, but the cell is excluded — %s", tc.cloud, tc.kind, tc.excluded)
				}
				return
			}
			if got := tc.locate(t, tf)[leafProbeKey]; got != leafProbeValue {
				t.Errorf("%s/%s: provider_config[%q] did not reach its tfvars object (got %v) — the component's "+
					"provider_config is stored by the console and read by nothing", tc.cloud, tc.kind, leafProbeKey, got)
			}
		})
	}
}

// TestProviderTfvars_LeafPassthrough_TypedWins pins merge-if-absent at every new site: a
// provider_config key that collides with an attribute the typed code emits is ignored, so the UI's
// validated value can never be clobbered by a hand-typed one. The second table pins the reserved
// keys: an attribute the builder OWNS but did not emit this time (a withdrawn offer, a value it
// consumes under another name, the side of a switch left empty) must stay absent rather than be
// filled from provider_config — the same rule the database's IAM-auth reservation applies.
func TestProviderTfvars_LeafPassthrough_TypedWins(t *testing.T) {
	yes, no := true, false
	thirty := 30
	pc := func(key string) map[string]any { return map[string]any{key: leafBogus} }

	type typedCase struct {
		cloud, kind string
		cfg         *types.ProjectConfig
		locate      leafLocator
		key         string
		// want is the typed value that must survive; nil asserts only that the bogus one did not land.
		want interface{}
	}
	cases := []typedCase{
		{"aws", "cache", &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c", EngineVersion: "7.0", ProviderConfig: pc("redis_engine_version")}}}, atRoot, "redis_engine_version", "7.0"},
		{"aws", "queue", &types.ProjectConfig{Queues: []types.ProjectQueueConfig{{Name: "q", Ordered: &yes, ProviderConfig: pc("fifo_queue")}}}, entryOfMap("sqs_queues", "q"), "fifo_queue", true},
		{"aws", "topic", &types.ProjectConfig{Topics: []types.ProjectTopicConfig{{Name: "t", Subscriptions: []types.TopicSubscription{{Protocol: types.TopicSubscriptionProtocolEmail, Endpoint: "a@b"}}, ProviderConfig: pc("subscriptions")}}}, entryOfMap("sns_topics", "t"), "subscriptions", nil},
		{"aws", "nosql", &types.ProjectConfig{NosqlTables: []types.ProjectNosqlConfig{{Name: "n", PartitionKey: "pk", TableType: types.NosqlTableTypeStandard, ProviderConfig: pc("hash_key")}}}, firstOfList("ddb_table_configuration"), "hash_key", "pk"},
		{"aws", "bucket", &types.ProjectConfig{StorageBuckets: []types.ProjectStorageBucketConfig{{Name: "b", Versioning: true, ProviderConfig: pc("versioning_enabled")}}}, firstOfList("bucket_configuration"), "versioning_enabled", true},
		{"aws", "secret", &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 16, ProviderConfig: pc("secret_name")}}}, firstOfList("custom_secrets"), "secret_name", "s"},
		{"aws", "registry", &types.ProjectConfig{ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "reg", ProviderConfig: pc("provision_ecr")}}}, atRoot, "provision_ecr", true},

		{"gcp", "cache", &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c", EngineVersion: "7.0", ProviderConfig: pc("memorystore_redis_version")}}}, atRoot, "memorystore_redis_version", "REDIS_7_0"},
		{"gcp", "queue", &types.ProjectConfig{Queues: []types.ProjectQueueConfig{{Name: "q", MessageRetention: &thirty, ProviderConfig: pc("message_retention_duration")}}}, entryOfMap("pubsub_topics", "q"), "message_retention_duration", "30s"},
		{"gcp", "topic", &types.ProjectConfig{Topics: []types.ProjectTopicConfig{{Name: "t", ProviderConfig: pc("message_retention_duration")}}}, entryOfMap("pubsub_topics", "t"), "message_retention_duration", "86400s"},
		{"gcp", "nosql", &types.ProjectConfig{NosqlTables: []types.ProjectNosqlConfig{{Name: "n", PartitionKey: "pk", PointInTimeRecovery: true, ProviderConfig: pc("firestore_point_in_time_recovery")}}}, atRoot, "firestore_point_in_time_recovery", true},
		{"gcp", "bucket", &types.ProjectConfig{StorageBuckets: []types.ProjectStorageBucketConfig{{Name: "b", Versioning: true, ProviderConfig: pc("versioning")}}}, firstOfList("cloud_storage_buckets"), "versioning", true},
		{"gcp", "secret", &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 16, ProviderConfig: pc("length")}}}, firstOfList("custom_secrets"), "length", 16},
		{"gcp", "registry", &types.ProjectConfig{ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "reg", ImmutableTags: &no, ProviderConfig: pc("immutable_tags")}}}, entryOfMap("artifact_registry_repos", "reg"), "immutable_tags", false},

		{"azure", "cache", &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c", MultiAz: &yes, ProviderConfig: pc("azure_cache_multi_az")}}}, atRoot, "azure_cache_multi_az", true},
		{"azure", "queue", &types.ProjectConfig{Queues: []types.ProjectQueueConfig{{Name: "q", Ordered: &yes, ProviderConfig: pc("requires_session")}}}, entryOfMap("service_bus_queues", "q"), "requires_session", true},
		{"azure", "topic", &types.ProjectConfig{Topics: []types.ProjectTopicConfig{{Name: "t", ProviderConfig: pc("subscriptions")}}}, entryOfMap("service_bus_topics", "t"), "subscriptions", nil},
		{"azure", "nosql", &types.ProjectConfig{NosqlTables: []types.ProjectNosqlConfig{{Name: "n", PartitionKey: "/pk", ProviderConfig: pc("partition_key")}}}, firstOfList("cosmos_db_collections"), "partition_key", "/pk"},
		{"azure", "bucket", &types.ProjectConfig{StorageBuckets: []types.ProjectStorageBucketConfig{{Name: "b", PublicAccess: true, ProviderConfig: pc("access_type")}}}, firstOfList("storage_containers"), "access_type", "blob"},
		{"azure", "secret", &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 16, ProviderConfig: pc("length")}}}, firstOfList("custom_secrets"), "length", 16},
		{"azure", "registry", &types.ProjectConfig{ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "reg", ProviderConfig: pc("provision_acr")}}}, atRoot, "provision_acr", true},

		{"alibaba", "cache", &types.ProjectConfig{Caches: []types.ProjectCacheConfig{{Name: "c", EngineVersion: "7.0", ProviderConfig: pc("kvstore_engine_version")}}}, atRoot, "kvstore_engine_version", "7.0"},
		{"alibaba", "queue", &types.ProjectConfig{Queues: []types.ProjectQueueConfig{{Name: "q", VisibilityTimeout: &thirty, ProviderConfig: pc("visibility_timeout")}}}, entryOfMap("mns_queues", "q"), "visibility_timeout", 30},
		{"alibaba", "topic", &types.ProjectConfig{Topics: []types.ProjectTopicConfig{{Name: "t", ProviderConfig: pc("subscriptions")}}}, entryOfMap("mns_topics", "t"), "subscriptions", nil},
		{"alibaba", "nosql", &types.ProjectConfig{NosqlTables: []types.ProjectNosqlConfig{{Name: "n", PartitionKey: "pk", ProviderConfig: pc("primary_keys")}}}, firstOfList("ots_tables"), "primary_keys", nil},
		{"alibaba", "bucket", &types.ProjectConfig{StorageBuckets: []types.ProjectStorageBucketConfig{{Name: "b", PublicAccess: true, ProviderConfig: pc("acl")}}}, firstOfList("oss_buckets"), "acl", "public-read"},
		{"alibaba", "secret", &types.ProjectConfig{Secrets: []types.ProjectSecretConfig{{Name: "s", Generate: true, Length: 16, ProviderConfig: pc("length")}}}, firstOfList("custom_secrets"), "length", 16},
		{"alibaba", "registry", &types.ProjectConfig{ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "reg", ImmutableTags: &no, ProviderConfig: pc("immutable_tags")}}}, entryOfMap("cr_repos", "reg"), "immutable_tags", false},

		{"hetzner", "bucket", &types.ProjectConfig{StorageBuckets: []types.ProjectStorageBucketConfig{{Name: "b", Versioning: true, ProviderConfig: pc("versioning")}}}, firstOfList("buckets"), "versioning", true},
	}
	for _, tc := range cases {
		t.Run(tc.cloud+"/"+tc.kind+"/"+tc.key, func(t *testing.T) {
			got := tc.locate(t, leafProviders[tc.cloud].ProviderTfvars(tc.cfg))[tc.key]
			if got == leafBogus {
				t.Fatalf("%s/%s: provider_config[%q] overrode the typed emit — the passthrough must be merge-if-absent", tc.cloud, tc.kind, tc.key)
			}
			if tc.want != nil && got != tc.want {
				t.Errorf("%s/%s: %s = %v (%T), want the typed value %v (%T)", tc.cloud, tc.kind, tc.key, got, got, tc.want, tc.want)
			}
		})
	}

	// RESERVED keys: owned by the builder, not emitted this time, and never to be filled from
	// provider_config. Each row builds the kind with the typed field UNSET and offers the key.
	reopen := []struct {
		cloud, kind, key string
		locate           leafLocator
		why              string
	}{
		{"aws", "cache", "redis_multi_az_enabled", atRoot, "written only when MultiAz is set"},
		{"aws", "nosql", "replicas", firstOfList("ddb_table_configuration"), "a regional table never carries replicas"},
		{"aws", "bucket", "encryption_algorithm", firstOfList("bucket_configuration"), "consumed by s3SSEAlgorithm under sse_algorithm"},
		{"aws", "secret", "manual", firstOfList("custom_secrets"), "the other side of the generate switch"},
		{"gcp", "cache", "memorystore_tier", atRoot, "written only when the canvas asked for HA"},
		{"azure", "cache", "azure_cache_sku", atRoot, "the tier flip the node count used to become (#1993)"},
		{"azure", "cache", "azure_cache_redis_version", atRoot, "the engine-version variable the template deleted (#1993)"},
		{"azure", "cache", "azure_cache_allowed_cidr_blocks", atRoot, "the allow-list is withdrawn on azure (#2148)"},
		{"azure", "queue", "delay_seconds", entryOfMap("service_bus_queues", "q"), "withdrawn: a per-message property, not a queue setting (#1994)"},
		{"azure", "queue", "forward_dead_lettered_messages_to", entryOfMap("service_bus_queues", "q"), "withdrawn: named no queue to forward to (#1994)"},
		{"alibaba", "cache", "kvstore_shard_count", atRoot, "written only when NumCacheNodes is set"},
		{"alibaba", "nosql", "primary_key", firstOfList("ots_tables"), "the wrong spelling the module's try swallowed (#1836)"},
		{"alibaba", "bucket", "encryption_algorithm", firstOfList("oss_buckets"), "consumed by ossSSEAlgorithm under sse_algorithm"},
	}
	for _, tc := range reopen {
		t.Run("reserved/"+tc.cloud+"/"+tc.kind+"/"+tc.key, func(t *testing.T) {
			obj := tc.locate(t, leafProviders[tc.cloud].ProviderTfvars(leafConfig(tc.kind, pc(tc.key))))
			if v, present := obj[tc.key]; present {
				t.Errorf("%s/%s: provider_config re-opened reserved key %q (= %v) — %s", tc.cloud, tc.kind, tc.key, v, tc.why)
			}
		})
	}
}

// Both halves of the union are read from the SOURCE, not from a list written here.
//
// The two tests below this one enumerate components by hand, and a hand-written list is exactly
// what a new component type is invisible to: add a kind, give it a reserved slice, forget to add
// it here, and the carrier test reports all-clear for keys nothing closes. Same for the call sites
// — one root merge added later without its union is the original defect surviving, and no test
// that names sites individually would notice.
//
// So this reads the provider files themselves and asks two questions that cannot go stale:
// every `xxxReserved` slice a provider declares must be an argument to that file's
// `unionReserved(...)`, and every root-level `mergeProviderConfig(tfvars, …)` must be passed a
// `RootReserved` union. Text rather than an AST because the call site IS the text: what is being
// checked is which identifier a human typed at a call, not what the program computes.
func TestEveryReservedSliceAndRootMergeIsCoveredBySource(t *testing.T) {
	// Hetzner has ONE root-level component (the database, cache and queue are in-cluster charts,
	// buckets and registry hosts are per-item), so there is no other component to decide for and
	// no union to pass. Recorded here rather than skipped silently.
	const hetznerFile = "hetzner_provider.go"

	declRe := regexp.MustCompile(`(?m)^\t(\w+Reserved)\s*=\s*\[\]string\{`)
	unionArgsRe := regexp.MustCompile(`(?s)unionReserved\((.*?)\)\n`)
	rootMergeRe := regexp.MustCompile(`(?m)^\s*mergeProviderConfig\(tfvars,.*$`)

	for _, file := range []string{
		"aws_provider.go", "gcp_provider.go", "azure_provider.go",
		"alibaba_provider.go", hetznerFile,
	} {
		t.Run(file, func(t *testing.T) {
			src, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("reading %s: %v", file, err)
			}
			text := string(src)

			// 1. Every declared reserved slice is folded into this file's union.
			union := ""
			if m := unionArgsRe.FindStringSubmatch(text); m != nil {
				union = m[1]
			}
			for _, d := range declRe.FindAllStringSubmatch(text, -1) {
				name := d[1]
				if strings.HasSuffix(name, "RootReserved") {
					continue // the union itself
				}
				if !strings.Contains(union, name) {
					t.Errorf("%s declares %s but does not pass it to unionReserved — every root "+
						"merge on this cloud would leave its keys open to every other component",
						file, name)
				}
			}

			// 2. Every root-level merge is passed a union.
			for _, call := range rootMergeRe.FindAllString(text, -1) {
				if file == hetznerFile {
					continue
				}
				if !strings.Contains(call, "RootReserved...") {
					t.Errorf("%s: root merge is not passed its cloud's union — one component's "+
						"provider_config can decide another's variable:\n  %s",
						file, strings.TrimSpace(call))
				}
			}
		})
	}
}

// A registry that owns no ECR repository must not reconfigure the ECR module.
//
// `buildECRNamesMap` and `buildECRRepoSettings` both skip a row whose name normalises to nothing,
// so such a row produces no repository and leaves `provision_ecr` false. The passthrough loop was
// missing that filter, so the phantom row's provider_config still set `ecr_*` on root tfvars —
// configuring encryption, lifecycle policy and scanning for repositories that OTHER registries and
// repo-sourced services created. Merge-if-absent makes it worse rather than safer: reached first in
// slice order, the phantom wins over the real registry's answer.
func TestProviderTfvars_AWSRegistryWithNoRepositoryCarriesNothing(t *testing.T) {
	cfg := &types.ProjectConfig{
		ProjectName: "p",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{
			{Name: "--", ProviderConfig: map[string]any{"ecr_encryption_type": "KMS"}},
			{Name: "real", ProviderConfig: map[string]any{"ecr_encryption_type": "AES256"}},
		},
	}
	tfvars := leafProviders["aws"].ProviderTfvars(cfg)
	if got := tfvars["ecr_encryption_type"]; got != "AES256" {
		t.Fatalf("ecr_encryption_type = %v, want AES256 — a registry whose name normalises to "+
			"nothing owns no repository, so it must not answer for the ones that do", got)
	}
}

// A reserved key must be closed to every OTHER root-level component, not only to the one that
// reserves it.
//
// This is the second axis the table above cannot have. There, each reserved key is offered through
// the provider_config of the very component that reserves it, which is the one path the reservation
// covers by construction — so that table stays green while a different root merge in the same
// `ProviderTfvars` leaves the key wide open. It did: every root-level merge writes the same flat
// tfvars map, so a cache's provider_config could set `rds_iam_auth_enabled` whenever the database's
// typed mapping had not, an Azure registry's could re-open the whole withdrawn cache SKU family,
// and a Firestore table's could set `cloud_sql_iam_auth` — keyless database auth on a cloud × engine
// cell the canvas does not offer and the deploy gate would refuse.
//
// So this walks the cloud's whole reserved union against every carrier that is not its owner. It is
// derived from the same slices the call sites pass, which is what stops it going stale: a key added
// to a component is tested against every neighbour in the same edit.
//
// The probe is a SENTINEL rather than an absence check, because some reserved keys are written
// unconditionally by typed code — `provision_acr` is emitted for every project with a registry — so
// "the key is present" is not the question. "The carrier's value won" is.
func TestProviderTfvars_ReservedKeysAreClosedToEveryOtherComponent(t *testing.T) {
	const sentinel = "carrier-should-never-win"

	cases := []struct {
		cloud string
		// byOwner maps the component that owns a reserved list to that list. Owners that are not
		// carriers (the cluster, the DNS zone) are listed so their keys are probed from every
		// carrier — there is no self-pairing to skip.
		byOwner map[string][]string
		// carriers are the kinds whose provider_config reaches ROOT tfvars on this cloud.
		carriers []string
	}{
		{
			cloud: "aws",
			byOwner: map[string][]string{
				"database": awsDatabaseReserved, "cache": awsCacheReserved,
				"registry": awsRegistryReserved, "cluster": awsClusterReserved, "dns": awsDNSReserved,
			},
			carriers: []string{"database", "cache", "registry"},
		},
		{
			cloud: "gcp",
			byOwner: map[string][]string{
				"database": gcpDatabaseReserved, "cache": gcpCacheReserved,
				"nosql": gcpNosqlReserved, "cluster": gcpClusterReserved, "dns": gcpDNSReserved,
			},
			carriers: []string{"database", "cache", "nosql"},
		},
		{
			cloud: "azure",
			byOwner: map[string][]string{
				"database": azureDatabaseReserved, "cache": azureCacheReserved,
				"registry": azureRegistryReserved, "cluster": azureClusterReserved,
				"dns": azureDNSReserved,
			},
			carriers: []string{"database", "cache", "registry"},
		},
		{
			cloud: "alibaba",
			byOwner: map[string][]string{
				"database": alibabaDatabaseReserved, "cache": alibabaCacheReserved,
				"dns": alibabaDNSReserved,
			},
			carriers: []string{"database", "cache"},
		},
	}

	for _, tc := range cases {
		for owner, keys := range tc.byOwner {
			for _, key := range keys {
				for _, carrier := range tc.carriers {
					if carrier == owner {
						continue // the direction the reservation already covered
					}
					t.Run(tc.cloud+"/"+key+"/from-"+carrier, func(t *testing.T) {
						cfg := leafConfig(carrier, map[string]any{key: sentinel})
						tfvars := leafProviders[tc.cloud].ProviderTfvars(cfg)
						if v, present := tfvars[key]; present && v == sentinel {
							t.Fatalf("%s: a %s's provider_config set %q, which the %s owns — "+
								"one component's knobs decided another's variable, walking around "+
								"both the offer gate (#1508) and the deploy refusal (#1510)",
								tc.cloud, carrier, key, owner)
						}
					})
				}
			}
		}
	}
}

// The union each root-level merge is passed must actually contain every per-component list, or the
// test above probes a set narrower than the one the call sites use and reports all-clear for keys
// nothing closes. Deriving the union does not prove it was derived from the RIGHT slices.
func TestRootReservedUnionsCoverEveryComponentList(t *testing.T) {
	cases := []struct {
		cloud string
		union []string
		parts map[string][]string
	}{
		{"aws", awsRootReserved, map[string][]string{
			"database": awsDatabaseReserved, "cache": awsCacheReserved,
			"registry": awsRegistryReserved, "cluster": awsClusterReserved, "dns": awsDNSReserved,
		}},
		{"gcp", gcpRootReserved, map[string][]string{
			"database": gcpDatabaseReserved, "cache": gcpCacheReserved, "nosql": gcpNosqlReserved,
			"cluster": gcpClusterReserved, "dns": gcpDNSReserved,
		}},
		{"azure", azureRootReserved, map[string][]string{
			"database": azureDatabaseReserved, "cache": azureCacheReserved,
			"registry": azureRegistryReserved, "cluster": azureClusterReserved,
			"dns": azureDNSReserved,
		}},
		{"alibaba", alibabaRootReserved, map[string][]string{
			"database": alibabaDatabaseReserved, "cache": alibabaCacheReserved,
			"dns": alibabaDNSReserved,
		}},
	}
	for _, tc := range cases {
		t.Run(tc.cloud, func(t *testing.T) {
			in := make(map[string]bool, len(tc.union))
			for _, k := range tc.union {
				in[k] = true
			}
			for owner, keys := range tc.parts {
				for _, k := range keys {
					if !in[k] {
						t.Errorf("%s: %q is reserved by the %s but missing from the union every "+
							"root merge is passed — every other component can set it", tc.cloud, k, owner)
					}
				}
			}
		})
	}
}
