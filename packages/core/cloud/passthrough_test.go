// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"regexp"
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
