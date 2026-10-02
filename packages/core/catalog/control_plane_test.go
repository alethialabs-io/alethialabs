// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"strings"
	"testing"
	"time"
)

// TestControlPlaneCoversEveryProvider asserts every catalog provider has a control-plane entry
// (#5371): a cloud added to providers[] without one would be estimated with no control plane at
// all, and nothing else would notice.
func TestControlPlaneCoversEveryProvider(t *testing.T) {
	c := MustLoad()
	for _, p := range c.Providers {
		if _, ok := c.ControlPlane[p.Slug]; !ok {
			t.Errorf("provider %q has no control_plane entry", p.Slug)
		}
	}
	for slug := range c.ControlPlane {
		if _, ok := c.Provider(slug); !ok {
			t.Errorf("control_plane names %q, which is not a catalog provider", slug)
		}
	}
}

// TestControlPlaneTiersAreSourced asserts each tier is well-formed: the default tier exists, every
// tier names an https source and a date it was read, and a fee is either absent (no fee) or
// positive. A zero fee is refused, because the estimate would show it as a billed line.
func TestControlPlaneTiersAreSourced(t *testing.T) {
	for slug, cp := range MustLoad().ControlPlane {
		if len(cp.Tiers) == 0 {
			t.Errorf("%s: no tiers", slug)
		}
		seen := map[string]bool{}
		for _, tier := range cp.Tiers {
			if seen[tier.Tier] {
				t.Errorf("%s: tier %q repeats", slug, tier.Tier)
			}
			seen[tier.Tier] = true
			if tier.Label == "" {
				t.Errorf("%s/%s: no label", slug, tier.Tier)
			}
			if !strings.HasPrefix(tier.Source, "https://") {
				t.Errorf("%s/%s: source %q is not an https URL", slug, tier.Tier, tier.Source)
			}
			if _, err := time.Parse("2006-01-02", tier.AsOf); err != nil {
				t.Errorf("%s/%s: as_of %q is not a date: %v", slug, tier.Tier, tier.AsOf, err)
			}
			if tier.HourlyUSD != nil && *tier.HourlyUSD <= 0 {
				t.Errorf("%s/%s: hourly_usd %v must be positive, or null for no fee", slug, tier.Tier, *tier.HourlyUSD)
			}
		}
		if !seen[cp.DefaultTier] {
			t.Errorf("%s: default_tier %q is not one of its tiers", slug, cp.DefaultTier)
		}
		if cp.SelfHostedServers < 0 {
			t.Errorf("%s: self_hosted_servers %d is negative", slug, cp.SelfHostedServers)
		}
	}
}

// TestControlPlaneFees pins the fee each cloud's deployed tier carries, as read from the providers'
// pricing pages on the tiers' as_of date.
func TestControlPlaneFees(t *testing.T) {
	cases := []struct {
		provider, tier string
		hourly         float64 // 0 = no fee (hourly_usd null)
		selfHosted     int
	}{
		{"aws", "standard", 0.10, 0},
		{"aws", "extended", 0.60, 0},
		{"gcp", "standard", 0.10, 0},
		{"gcp", "extended", 0.60, 0},
		{"azure", "free", 0, 0},
		{"azure", "standard", 0.10, 0},
		{"azure", "premium", 0.60, 0},
		{"alibaba", "basic", 0, 0},
		{"alibaba", "pro", 0.09, 0},
		{"hetzner", "self-hosted", 0, 1},
	}
	c := MustLoad()
	for _, tc := range cases {
		cp := c.ControlPlane[tc.provider]
		if cp.SelfHostedServers != tc.selfHosted {
			t.Errorf("%s: self_hosted_servers = %d, want %d", tc.provider, cp.SelfHostedServers, tc.selfHosted)
		}
		var found *ControlPlaneTier
		for i := range cp.Tiers {
			if cp.Tiers[i].Tier == tc.tier {
				found = &cp.Tiers[i]
			}
		}
		if found == nil {
			t.Errorf("%s: no tier %q", tc.provider, tc.tier)
			continue
		}
		switch {
		case tc.hourly == 0 && found.HourlyUSD != nil:
			t.Errorf("%s/%s: hourly_usd = %v, want null (no fee)", tc.provider, tc.tier, *found.HourlyUSD)
		case tc.hourly != 0 && (found.HourlyUSD == nil || *found.HourlyUSD != tc.hourly):
			t.Errorf("%s/%s: hourly_usd = %v, want %v", tc.provider, tc.tier, found.HourlyUSD, tc.hourly)
		}
	}
}
