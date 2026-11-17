// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"encoding/json"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
)

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

// TestDBEngineVersions pins the invariants of the offline version baseline. They are checked here
// (Go, over the embedded JSON) as well as in gen-catalog.mjs, because the two consumers read the
// same file by different paths and a malformed list must red the build that touches it, not the
// build that happens to regenerate the TS mirror.
//
// The ordering assertion is deliberately weak — "newest-first" is asserted as a total order the
// list agrees with, not a semver parse. Alibaba's "16.0" and Azure MySQL's "8.0.21" are the same
// axis at different grains, and a strict parser would have to encode every provider's scheme to
// say anything at all.
func TestDBEngineVersions(t *testing.T) {
	c := MustLoad()
	for provider, dp := range c.Database {
		for _, e := range dp.Engines {
			if len(e.Versions) == 0 {
				t.Errorf("%s/%s has no versions — the offline picker would fall back to an empty list", provider, e.Value)
				continue
			}
			if !slices.Contains(e.Versions, e.DefaultVersion) {
				t.Errorf("%s/%s default_version %q is not in versions %v — the seeded default is not offerable",
					provider, e.Value, e.DefaultVersion, e.Versions)
			}
			seen := map[string]bool{}
			for _, v := range e.Versions {
				if seen[v] {
					t.Errorf("%s/%s repeats version %q", provider, e.Value, v)
				}
				seen[v] = true
			}
			if !slices.IsSortedFunc(e.Versions, func(a, b string) int { return compareVersionsDesc(a, b) }) {
				t.Errorf("%s/%s versions %v are not newest-first", provider, e.Value, e.Versions)
			}
		}
	}
}

// compareVersionsDesc orders two version strings newest-first by numeric segment, so "9" sorts
// BELOW "10" (a lexical compare gets that backwards) and "8.0.21" below "8.4". Non-numeric or
// missing segments compare as 0, which is what makes it total over every provider's grain.
func compareVersionsDesc(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(as), len(bs)); i++ {
		an, bn := 0, 0
		if i < len(as) {
			an, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			bn, _ = strconv.Atoi(bs[i])
		}
		if an != bn {
			return bn - an
		}
	}
	return 0
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

// TestInstanceOwners: a catalog SKU names the one cloud that lists it, and an SKU the catalog has
// never heard of names none — which validate.go reads as "no evidence", never as "invalid" (#5269).
func TestInstanceOwners(t *testing.T) {
	c := MustLoad()
	cases := map[string][]string{
		"t3.large":        {"aws"},
		"e2-standard-2":   {"gcp"},
		"Standard_D2s_v5": {"azure"},
		"cpx22":           {"hetzner"},
		"ecs.g6.large":    {"alibaba"},
		"m6i.large":       nil,
	}
	for sku, want := range cases {
		if got := c.InstanceOwners(sku); !reflect.DeepEqual(got, want) {
			t.Errorf("InstanceOwners(%q) = %v, want %v", sku, got, want)
		}
	}
}

// TestAvailabilityIsDeclaredForEveryCloud holds the catalog to the rules the TypeScript generator
// also enforces, so each reader fails on its own: every cloud carries one of the two values, a
// cloud listed in both blocks carries the same value in each, and at least one cloud is available.
func TestAvailabilityIsDeclaredForEveryCloud(t *testing.T) {
	c := MustLoad()
	if len(c.Live.Providers) == 0 {
		t.Fatal("live.providers decoded to no clouds")
	}
	available := 0
	for _, p := range c.Live.Providers {
		switch p.Availability {
		case AvailabilityAvailable:
			available++
		case AvailabilityHidden:
		default:
			t.Errorf("live.providers.%s availability = %q, want available or hidden", p.Slug, p.Availability)
		}
	}
	if available == 0 {
		t.Error("no cloud is available")
	}
	for _, p := range c.Providers {
		live, ok := c.Availability(p.Slug)
		if !ok {
			t.Errorf("providers[] lists %q but live.providers does not", p.Slug)
			continue
		}
		if p.Availability != live {
			t.Errorf("%s availability: providers[] says %q, live.providers says %q", p.Slug, p.Availability, live)
		}
	}
}

// TestOfferedClouds fixes the offered set by decision (2026-11-17): AWS, GCP, Azure and Hetzner are
// offered; Alibaba, DigitalOcean and Civo are hidden. The order is catalog.json's.
func TestOfferedClouds(t *testing.T) {
	t.Setenv(HiddenCloudsEnv, "")
	c := MustLoad()

	all := make([]string, 0, len(c.Live.Providers))
	for _, p := range c.Live.Providers {
		all = append(all, p.Slug)
	}
	wantAll := []string{"aws", "gcp", "azure", "alibaba", "digitalocean", "hetzner", "civo"}
	if !slices.Equal(all, wantAll) {
		t.Fatalf("connectable clouds = %v, want %v (catalog.json order)", all, wantAll)
	}

	want := []string{"aws", "gcp", "azure", "hetzner"}
	if got := c.OfferedProviders(); !slices.Equal(got, want) {
		t.Errorf("OfferedProviders() = %v, want %v", got, want)
	}
	for _, slug := range want {
		if !c.Offered(slug) {
			t.Errorf("Offered(%q) = false, want true", slug)
		}
	}
	for _, slug := range []string{"alibaba", "digitalocean", "civo"} {
		if c.Offered(slug) {
			t.Errorf("Offered(%q) = true, want false", slug)
		}
		if a, ok := c.Availability(slug); !ok || a != AvailabilityHidden {
			t.Errorf("Availability(%q) = %q, %v; want hidden, true", slug, a, ok)
		}
	}
	for _, slug := range []string{"", "nimbus", "AWS", " aws"} {
		if c.Offered(slug) {
			t.Errorf("Offered(%q) = true for a slug the catalog does not list", slug)
		}
	}
}

// TestHiddenCloudOverride covers the operator setting: it re-enables exactly the hidden clouds it
// names, never removes an available one, and reports a slug the catalog does not list.
func TestHiddenCloudOverride(t *testing.T) {
	c := MustLoad()

	t.Run("re-enables only the named hidden cloud", func(t *testing.T) {
		t.Setenv(HiddenCloudsEnv, "alibaba")
		if !c.Offered("alibaba") {
			t.Error("alibaba is not offered under the override")
		}
		if c.Offered("civo") {
			t.Error("civo is offered although the override does not name it")
		}
		want := []string{"aws", "gcp", "azure", "alibaba", "hetzner"}
		if got := c.OfferedProviders(); !slices.Equal(got, want) {
			t.Errorf("OfferedProviders() = %v, want %v", got, want)
		}
	})

	t.Run("accepts spaces, blanks and repeats", func(t *testing.T) {
		t.Setenv(HiddenCloudsEnv, " civo , ,alibaba,civo,")
		got, err := c.HiddenCloudOverride()
		if err != nil {
			t.Fatalf("HiddenCloudOverride: %v", err)
		}
		if want := []string{"civo", "alibaba"}; !slices.Equal(got, want) {
			t.Errorf("HiddenCloudOverride() = %v, want %v", got, want)
		}
	})

	t.Run("cannot narrow the offered set", func(t *testing.T) {
		t.Setenv(HiddenCloudsEnv, "aws")
		want := []string{"aws", "gcp", "azure", "hetzner"}
		if got := c.OfferedProviders(); !slices.Equal(got, want) {
			t.Errorf("OfferedProviders() = %v, want %v", got, want)
		}
	})

	t.Run("reports an unknown slug and enables nothing for it", func(t *testing.T) {
		t.Setenv(HiddenCloudsEnv, "alibaba,nimbus,Civo")
		got, err := c.HiddenCloudOverride()
		if err == nil {
			t.Fatal("HiddenCloudOverride returned no error for unknown slugs")
		}
		for _, slug := range []string{"nimbus", "Civo"} {
			if !strings.Contains(err.Error(), slug) {
				t.Errorf("error %q does not name %q", err, slug)
			}
		}
		if want := []string{"alibaba"}; !slices.Equal(got, want) {
			t.Errorf("HiddenCloudOverride() = %v, want %v", got, want)
		}
		if c.Offered("nimbus") || c.Offered("civo") {
			t.Error("an unknown or differently-cased slug enabled a cloud")
		}
		if !c.Offered("alibaba") {
			t.Error("the valid item of a partly invalid override was not applied")
		}
	})

	t.Run("unset means nothing is re-enabled", func(t *testing.T) {
		t.Setenv(HiddenCloudsEnv, "")
		got, err := c.HiddenCloudOverride()
		if err != nil || len(got) != 0 {
			t.Errorf("HiddenCloudOverride() = %v, %v; want empty, nil", got, err)
		}
	})
}

// TestConnectableProvidersDecoding covers the ordered decoder's refusals: the block must be an
// object, and an entry's slug must equal the key it sits under.
func TestConnectableProvidersDecoding(t *testing.T) {
	var ordered ConnectableProviders
	if err := json.Unmarshal([]byte(`{"b":{"slug":"b","availability":"hidden"},"a":{"slug":"a","availability":"available"}}`), &ordered); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(ordered) != 2 || ordered[0].Slug != "b" || ordered[1].Slug != "a" {
		t.Errorf("decoded order = %+v, want b then a", ordered)
	}
	for name, doc := range map[string]string{
		"array":         `[]`,
		"slug mismatch": `{"a":{"slug":"b","availability":"available"}}`,
		"bad entry":     `{"a":7}`,
	} {
		var p ConnectableProviders
		if err := json.Unmarshal([]byte(doc), &p); err == nil {
			t.Errorf("%s: Unmarshal accepted %s", name, doc)
		}
	}
}
