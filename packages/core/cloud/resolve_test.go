// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestResolveRegion: canonical id maps per provider; provider-native codes pass through.
func TestResolveRegion(t *testing.T) {
	if got := resolveRegion("gcp", "eu-west-1"); got != "europe-west1" {
		t.Errorf("gcp eu-west-1 = %q, want europe-west1", got)
	}
	if got := resolveRegion("azure", "eu-west-1"); got != "westeurope" {
		t.Errorf("azure eu-west-1 = %q, want westeurope", got)
	}
	// AWS canonical id == aws code (identity).
	if got := resolveRegion("aws", "eu-west-1"); got != "eu-west-1" {
		t.Errorf("aws eu-west-1 = %q, want eu-west-1", got)
	}
	// Legacy provider-native code (not a canonical id) passes through unchanged.
	if got := resolveRegion("gcp", "europe-west1"); got != "europe-west1" {
		t.Errorf("gcp europe-west1 passthrough = %q", got)
	}
}

// TestResolveDBEngine: abstract family resolves; legacy concrete engine passes through.
func TestResolveDBEngine(t *testing.T) {
	eng, ver := resolveDBEngine("aws", types.ProjectDatabaseConfig{EngineFamily: "postgres"})
	if eng != "aurora-postgresql" || ver != "16.6" {
		t.Errorf("aws postgres = (%q,%q), want (aurora-postgresql,16.6)", eng, ver)
	}
	eng, _ = resolveDBEngine("gcp", types.ProjectDatabaseConfig{EngineFamily: "mysql"})
	if eng != "cloudsql-mysql" {
		t.Errorf("gcp mysql = %q, want cloudsql-mysql", eng)
	}
	// Legacy concrete engine (no family) passes through.
	eng, _ = resolveDBEngine("aws", types.ProjectDatabaseConfig{Engine: "aurora-mysql"})
	if eng != "aurora-mysql" {
		t.Errorf("legacy engine passthrough = %q", eng)
	}
	// Explicit version wins over the catalog default.
	_, ver = resolveDBEngine("aws", types.ProjectDatabaseConfig{EngineFamily: "postgres", EngineVersion: "15.4"})
	if ver != "15.4" {
		t.Errorf("explicit version = %q, want 15.4", ver)
	}
}

// TestResolveCacheNodeType: abstract memory resolves to nearest SKU; legacy node type wins.
func TestResolveCacheNodeType(t *testing.T) {
	if got := resolveCacheNodeType("gcp", types.ProjectCacheConfig{MemoryGB: 4}); got != "M2" {
		t.Errorf("gcp 4GB = %q, want M2", got)
	}
	if got := resolveCacheNodeType("aws", types.ProjectCacheConfig{NodeType: "cache.r6g.large"}); got != "cache.r6g.large" {
		t.Errorf("legacy node type passthrough = %q", got)
	}
}

// TestResolveInstanceTypes: abstract node size resolves; explicit list wins.
func TestResolveInstanceTypes(t *testing.T) {
	got := resolveInstanceTypes("aws", types.ProjectClusterConfig{
		NodeSize: &types.NodeSize{VCPU: 2, MemoryGB: 4},
	})
	if len(got) != 1 || got[0] != "t3.medium" {
		t.Errorf("aws 2/4 = %v, want [t3.medium]", got)
	}
	got = resolveInstanceTypes("gcp", types.ProjectClusterConfig{
		InstanceTypes: []string{"e2-standard-4"},
	})
	if len(got) != 1 || got[0] != "e2-standard-4" {
		t.Errorf("explicit list passthrough = %v", got)
	}
}
