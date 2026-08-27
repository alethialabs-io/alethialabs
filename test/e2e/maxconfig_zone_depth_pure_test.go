// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2843: Hetzner Cloud DNS refuses a zone name with more than two labels. hetzner/maxconfig run
// 32984975119 died on `32984975119-1.e2e.alethia-e2e.com` with `unsupported tld (invalid_input)`,
// 422 — a `.com` name, a TLD the repo's own probe set proved is accepted.
//
// These are pure: no cloud, no network, so they run on every PR.

package e2e

import (
	"os"
	"strings"
	"testing"
)

// labelCount is the property that actually matters to Hetzner's validator.
func labelCount(zone string) int {
	return len(strings.Split(strings.Trim(zone, "."), "."))
}

func TestHetznerZoneNameIsTwoLabels(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ENV", "32984975119-1")
	t.Setenv("ALETHIA_E2E_MAXCONFIG_DOMAIN_SUFFIX_HETZNER", "alethia-e2e.com")

	got := MaxConfigDomainFor("hetzner")
	if got != "alethia-e2e.com" {
		t.Fatalf("hetzner zone = %q, want the bare suffix", got)
	}
	// The assertion that would have caught the failing run BEFORE it cost EUR 0.75 and 4 minutes.
	if n := labelCount(got); n > 2 {
		t.Fatalf("hetzner zone %q has %d labels; Hetzner Cloud DNS refuses more than 2", got, n)
	}
	// And the run id must NOT be smuggled in — dropping the prefix is the whole point.
	if strings.Contains(got, "32984975119") {
		t.Fatalf("run scoping leaked into the hetzner zone name: %q", got)
	}
}

func TestHetznerZoneRejectsAMultiLabelSuffix(t *testing.T) {
	// The configuration that actually broke: a THREE-label suffix. Dropping the run prefix is not
	// enough on its own, so this pins that the resulting name is still too deep and would fail —
	// documenting that the repo variable must be a registrable domain, not a subdomain.
	t.Setenv("ALETHIA_E2E_ENV", "run-1")
	t.Setenv("ALETHIA_E2E_MAXCONFIG_DOMAIN_SUFFIX_HETZNER", "e2e.alethia-e2e.com")

	got := MaxConfigDomainFor("hetzner")
	if labelCount(got) <= 2 {
		t.Fatalf("expected %q to still be too deep — a 3-label SUFFIX cannot be rescued by dropping "+
			"the prefix, and the variable itself must be a registrable domain", got)
	}
}

func TestOtherCloudsKeepRunScoping(t *testing.T) {
	// The narrowness is the safety. aws's certificate path is wired to a run-scoped name under
	// e2e.alethialabs.io, and flattening every cloud would break it — one cloud moves, the working
	// paths are left alone.
	t.Setenv("ALETHIA_E2E_ENV", "run-9")
	t.Setenv("ALETHIA_E2E_MAXCONFIG_DOMAIN_SUFFIX", "e2e.alethialabs.io")

	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", ""} {
		got := MaxConfigDomainFor(provider)
		if !strings.HasPrefix(got, "run-9.") {
			t.Fatalf("provider %q lost its run scoping: %q", provider, got)
		}
	}
}

func TestFlatNameIsHetznerOnlyAndCaseInsensitive(t *testing.T) {
	// Case-insensitive because the provider string arrives from a workflow input and a snapshot,
	// and a capitalised "Hetzner" silently falling through to the run-scoped branch would fail the
	// same way, four minutes into a real apply.
	for _, p := range []string{"hetzner", "Hetzner", "HETZNER", " hetzner "} {
		if !maxConfigZoneWantsFlatName(p) {
			t.Fatalf("%q should want a flat name", p)
		}
	}
	for _, p := range []string{"aws", "gcp", "azure", "alibaba", "", "hetzner-x", "xhetzner"} {
		if maxConfigZoneWantsFlatName(p) {
			t.Fatalf("%q must NOT want a flat name", p)
		}
	}
}

func TestNoEnvStillYieldsATwoLabelHetznerZone(t *testing.T) {
	// The pure-unit path: with no ALETHIA_E2E_ENV at all the name must still be usable, not an
	// accident of the fallback.
	os.Unsetenv("ALETHIA_E2E_ENV")
	t.Setenv("ALETHIA_E2E_MAXCONFIG_DOMAIN_SUFFIX_HETZNER", "alethia-e2e.com")
	if n := labelCount(MaxConfigDomainFor("hetzner")); n > 2 {
		t.Fatalf("got %d labels with no env set", n)
	}
}
