// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
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
		assertEq(t, tf, "azure_cache_redis_version", "6")
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
