// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import "testing"

// TestLoad asserts the embedded catalog parses and has the expected providers.
func TestLoad(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Version != 1 {
		t.Fatalf("version = %d, want 1", c.Version)
	}
	for _, slug := range []string{"aws", "gcp", "azure"} {
		if _, ok := c.Provider(slug); !ok {
			t.Errorf("missing provider %q", slug)
		}
		if _, ok := c.Compute[slug]; !ok {
			t.Errorf("missing compute inventory for %q", slug)
		}
		if _, ok := c.Database[slug]; !ok {
			t.Errorf("missing database inventory for %q", slug)
		}
		if _, ok := c.Cache[slug]; !ok {
			t.Errorf("missing cache inventory for %q", slug)
		}
	}
}

// TestRegionResolvesEverywhere asserts every canonical region resolves on all clouds —
// the property that makes a project's region cloud-indifferent.
func TestRegionResolvesEverywhere(t *testing.T) {
	c := MustLoad()
	if len(c.Regions) == 0 {
		t.Fatal("no regions")
	}
	for _, r := range c.Regions {
		for _, p := range []string{"aws", "gcp", "azure"} {
			code, ok := c.Region(r.ID, p)
			if !ok || code == "" {
				t.Errorf("region %q does not resolve on %q", r.ID, p)
			}
		}
	}
}

// TestNearestInstance checks family preference and capability matching.
func TestNearestInstance(t *testing.T) {
	c := MustLoad()
	// 2 vCPU / 4 GB general on AWS → t3.medium (exact).
	got, ok := c.NearestInstance("aws", 2, 4, "general")
	if !ok || got.Value != "t3.medium" {
		t.Errorf("aws general 2/4 = %q (ok=%v), want t3.medium", got.Value, ok)
	}
	// GPU family is honored even when capability is closer to a general SKU.
	got, ok = c.NearestInstance("gcp", 4, 16, "gpu")
	if !ok || got.Family != "gpu" {
		t.Errorf("gcp gpu = %+v (ok=%v), want a gpu-family instance", got, ok)
	}
	// Unknown provider → not ok.
	if _, ok := c.NearestInstance("nope", 2, 4, "general"); ok {
		t.Error("unknown provider resolved an instance")
	}
}

// TestDBEngine maps abstract families to concrete provider engines.
func TestDBEngine(t *testing.T) {
	c := MustLoad()
	cases := map[string]map[string]string{
		"aws":   {"postgres": "aurora-postgresql", "mysql": "aurora-mysql"},
		"gcp":   {"postgres": "cloudsql-postgresql", "mysql": "cloudsql-mysql"},
		"azure": {"postgres": "azure-postgresql", "mysql": "azure-mysql"},
	}
	for provider, families := range cases {
		for family, want := range families {
			e, ok := c.DBEngine(provider, family)
			if !ok || e.Value != want {
				t.Errorf("%s/%s = %q (ok=%v), want %q", provider, family, e.Value, ok, want)
			}
		}
	}
}

// TestNearestCacheTier checks memory-based matching.
func TestNearestCacheTier(t *testing.T) {
	c := MustLoad()
	// ~4 GB on GCP → M2 (Basic 4 GB).
	got, ok := c.NearestCacheTier("gcp", 4)
	if !ok || got.Value != "M2" {
		t.Errorf("gcp cache ~4GB = %q (ok=%v), want M2", got.Value, ok)
	}
}
