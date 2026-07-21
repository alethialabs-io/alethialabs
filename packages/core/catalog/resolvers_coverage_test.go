// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import "testing"

// TestMustLoadReturnsCatalog asserts MustLoad returns a non-nil, populated catalog
// (the embedded JSON is valid, so it must never panic).
func TestMustLoadReturnsCatalog(t *testing.T) {
	c := MustLoad()
	if c == nil {
		t.Fatal("MustLoad returned nil")
	}
	if len(c.Providers) == 0 {
		t.Fatal("MustLoad returned a catalog with no providers")
	}
}

// TestProviderLookup covers both the hit and miss paths of Provider, including the
// service-naming metadata a hit carries.
func TestProviderLookup(t *testing.T) {
	c := MustLoad()

	p, ok := c.Provider("aws")
	if !ok {
		t.Fatal("aws provider not found")
	}
	if p.Slug != "aws" {
		t.Errorf("slug = %q, want aws", p.Slug)
	}
	if p.Name == "" {
		t.Error("aws provider has empty display Name")
	}
	if p.ClusterService == "" {
		t.Error("aws provider has empty ClusterService")
	}

	if got, ok := c.Provider("does-not-exist"); ok {
		t.Errorf("unknown provider resolved: %+v", got)
	}
}

// TestDefaultK8sVersion covers the previously-untested default-version resolver: a
// present default returns (version,true); an unknown provider returns ("",false).
func TestDefaultK8sVersion(t *testing.T) {
	c := MustLoad()

	for _, provider := range []string{"aws", "gcp", "azure", "hetzner", "alibaba"} {
		v, ok := c.DefaultK8sVersion(provider)
		if !ok {
			t.Errorf("%s: expected a default k8s version, got ok=false", provider)
			continue
		}
		if v == "" {
			t.Errorf("%s: default k8s version is empty despite ok=true", provider)
		}
		// The default must be one the provider actually offers.
		cp := c.Compute[provider]
		found := false
		for _, kv := range cp.K8sVersions {
			if kv == v {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s: default k8s version %q not in offered versions %v", provider, v, cp.K8sVersions)
		}
	}

	if v, ok := c.DefaultK8sVersion("nope"); ok || v != "" {
		t.Errorf("unknown provider DefaultK8sVersion = (%q,%v), want (\"\",false)", v, ok)
	}
}

// TestRegionEdgeCases covers the miss branches of Region: an unknown canonical id and
// an unknown provider on a known region both return ("",false). It also confirms the
// non-managed clouds (hetzner, alibaba) resolve, which the existing test skips.
func TestRegionEdgeCases(t *testing.T) {
	c := MustLoad()

	// Unknown canonical region id → miss.
	if code, ok := c.Region("mars-central-1", "aws"); ok || code != "" {
		t.Errorf("unknown region = (%q,%v), want (\"\",false)", code, ok)
	}

	// Known region, unknown provider → miss (the codes map has no such key).
	if code, ok := c.Region("us-east-1", "oracle"); ok || code != "" {
		t.Errorf("known region unknown provider = (%q,%v), want (\"\",false)", code, ok)
	}

	// Non-managed clouds resolve to concrete codes.
	for _, provider := range []string{"hetzner", "alibaba"} {
		code, ok := c.Region("us-east-1", provider)
		if !ok || code == "" {
			t.Errorf("us-east-1 does not resolve on %q (code=%q ok=%v)", provider, code, ok)
		}
	}
}

// TestDBEngineEdgeCases covers the miss branches of DBEngine: unknown provider, and a
// known provider that lacks the requested family (Hetzner offers postgres only, no mysql).
func TestDBEngineEdgeCases(t *testing.T) {
	c := MustLoad()

	if e, ok := c.DBEngine("nope", "postgres"); ok {
		t.Errorf("unknown provider resolved a db engine: %+v", e)
	}

	// Hetzner has a postgres engine but no mysql family → miss without erroring.
	if e, ok := c.DBEngine("hetzner", "postgres"); !ok || e.Family != "postgres" {
		t.Errorf("hetzner postgres = %+v (ok=%v), want a postgres engine", e, ok)
	}
	if e, ok := c.DBEngine("hetzner", "mysql"); ok {
		t.Errorf("hetzner mysql resolved unexpectedly: %+v", e)
	}
}

// TestNearestInstanceFamilyFallback covers the two untested family branches: an empty
// family (no filter — nearest across all SKUs) and a family with zero members (falls
// back to the full inventory rather than returning false).
func TestNearestInstanceFamilyFallback(t *testing.T) {
	c := MustLoad()

	// Empty family, exact capability match → the exact SKU regardless of family.
	got, ok := c.NearestInstance("aws", 2, 4, "")
	if !ok || got.Value != "t3.medium" {
		t.Errorf("aws 2/4 no-family = %q (ok=%v), want t3.medium", got.Value, ok)
	}

	// A family with no members falls back to the whole inventory: 2 vCPU / 16 GB with a
	// bogus family should still find r5.large (the exact 2/16 SKU).
	got, ok = c.NearestInstance("aws", 2, 16, "nonexistent-family")
	if !ok {
		t.Fatal("bogus family should fall back to full inventory, got ok=false")
	}
	if got.Value != "r5.large" {
		t.Errorf("aws 2/16 bogus-family = %q, want r5.large (nearest across all)", got.Value)
	}

	// Requested family that DOES have members is honored even off the cheapest SKU.
	got, ok = c.NearestInstance("aws", 2, 4, "compute")
	if !ok || got.Family != "compute" {
		t.Errorf("aws 2/4 compute = %+v (ok=%v), want a compute-family SKU", got, ok)
	}
}

// TestNearestCacheTierUnknownProvider covers the miss branch (no cache inventory).
func TestNearestCacheTierUnknownProvider(t *testing.T) {
	c := MustLoad()
	if tier, ok := c.NearestCacheTier("nope", 4); ok {
		t.Errorf("unknown provider resolved a cache tier: %+v", tier)
	}
}

// TestNearestCacheTierAtLeast encodes the CORRECT behavior promised by the doc comment
// ("closest to (and, when possible, at least) the requested size"): a 6 GB request on GCP
// (tiers 1/4/10/35) must round UP to M3 (10 GB), never down to M2 (4 GB). Fixed in #999.
func TestNearestCacheTierAtLeast(t *testing.T) {
	c := MustLoad()
	got, ok := c.NearestCacheTier("gcp", 6)
	if !ok || got.Value != "M3" {
		t.Errorf("gcp cache >=6GB = %q (ok=%v), want M3 (>= requested per doc)", got.Value, ok)
	}
}

// TestNearestCacheTierRoundsUpAndFallsBack exercises the between-tiers round-up and the
// no-tier-large-enough fallback to the largest available (#999).
func TestNearestCacheTierRoundsUpAndFallsBack(t *testing.T) {
	c := MustLoad()
	// GCP tiers 1/4/10/35: 5 GB rounds UP to M3 (smallest tier >= 5), never down to M2.
	if got, ok := c.NearestCacheTier("gcp", 5); !ok || got.Value != "M3" {
		t.Errorf("gcp cache ~5GB = %q (ok=%v), want M3 (round up, never under-provision)", got.Value, ok)
	}
	// An exact match returns that tier: 4 GB -> M2.
	if got, ok := c.NearestCacheTier("gcp", 4); !ok || got.Value != "M2" {
		t.Errorf("gcp cache 4GB = %q (ok=%v), want M2 (exact)", got.Value, ok)
	}
	// Bigger than every tier -> fall back to the largest (M4 = 35 GB).
	if got, ok := c.NearestCacheTier("gcp", 1000); !ok || got.Value != "M4" {
		t.Errorf("gcp cache 1000GB = %q (ok=%v), want M4 (largest fallback)", got.Value, ok)
	}
}
