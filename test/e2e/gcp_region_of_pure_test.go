// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGCPRegionOf pins the zone→region normalization and, more importantly, its IDEMPOTENCE.
//
// `ALETHIA_E2E_REGION` holds a ZONE for gcp on purpose — GKE needs one, because a bare region makes
// the cluster regional and multiplies every node count by the zone count. So every consumer that
// needs a REGION derives it, and this is the FOURTH rendering of one rule:
//
//	infra/templates/project/gcp/locals.tf:62   regex("-[a-z]$") → substr(…, len-2)
//	scripts/e2e/gcp-cleanup.sh                 *-[a-z]) REGION="${REGION%-?}" ;;
//	firestore.tf / existing-network.tf         consume local.gcp_region_key
//	GCPRegionOf                                this one
//
// A rule with four renderings is how a fix reaches three of them, so the string forms of the other
// three are pinned below: if someone changes the shape test in one place, this fails rather than
// letting the renderings drift apart silently.
func TestGCPRegionOf(t *testing.T) {
	for _, tc := range []struct {
		in, want, why string
	}{
		{"europe-west3-a", "europe-west3", "the rotating nightly zone that started this (#4951)"},
		{"europe-west3-b", "europe-west3", "…and its siblings"},
		{"europe-west3-c", "europe-west3", "…"},
		{"us-central1-f", "us-central1", "a US zone, different dash arithmetic"},
		{"europe-west3", "europe-west3", "ALREADY a region — must pass through, not lose a character"},
		{"us-central1", "us-central1", "…the shorter region shape too"},
		{"", "", "empty in, empty out — never index past the end"},
		{"a", "a", "too short to carry a zone suffix"},
		{"-a", "-a", "a bare suffix is not a zone; leaves nothing to be a region"},
		{"europe-west3-A", "europe-west3-A", "uppercase is NOT a gcp zone suffix; gcp zones are lowercase"},
		{"europe-west3-ab", "europe-west3-ab", "two letters is not the zone suffix shape"},
		{"  europe-west3-a  ", "europe-west3", "whitespace trimmed, as the env var may carry it"},
	} {
		if got := GCPRegionOf(tc.in); got != tc.want {
			t.Errorf("GCPRegionOf(%q) = %q, want %q  (%s)", tc.in, got, tc.want, tc.why)
		}
	}

	// IDEMPOTENCE is the property that makes this safe to apply at a call site that may already
	// hold a region. The three other renderings all rely on it — locals.tf runs on `var.region`
	// whatever shape it arrives in — so a normalizer that ate a character on a second pass would
	// corrupt a region rather than leave it alone.
	for _, in := range []string{
		"europe-west3-a", "europe-west3", "us-central1-f", "us-central1", "", "-a", "europe-west3-A",
	} {
		once := GCPRegionOf(in)
		if twice := GCPRegionOf(once); twice != once {
			t.Errorf("GCPRegionOf is not idempotent on %q: once=%q twice=%q", in, once, twice)
		}
	}
}

// TestGCPRegionOfAgreesWithTheOtherRenderings pins the shape test used by the three renderings this
// one was derived from. It asserts the STRINGS, which is a weaker claim than executing them — Go
// cannot run HCL or the shell — and it is stated here so nobody reads it as more.
//
// What it does buy: changing the shape test in locals.tf or gcp-cleanup.sh without changing
// GCPRegionOf now fails HERE, in a test named for the disagreement, rather than in a paid cloud run.
func TestGCPRegionOfAgreesWithTheOtherRenderings(t *testing.T) {
	root := filepath.Join(e2ePackageDir(t), "..", "..")
	for _, c := range []struct {
		path, want, why string
	}{
		{
			path: filepath.Join(root, "infra", "templates", "project", "gcp", "locals.tf"),
			want: `can(regex("-[a-z]$", var.region))`,
			why:  "the HCL shape test GCPRegionOf mirrors",
		},
		{
			path: filepath.Join(root, "scripts", "e2e", "gcp-cleanup.sh"),
			want: `*-[a-z]) REGION="${REGION%-?}" ;;`,
			why:  "the shell rendering, already self-tested in that script",
		},
	} {
		raw, err := os.ReadFile(c.path)
		if err != nil {
			t.Fatalf("read %s: %v", c.path, err)
		}
		if !strings.Contains(string(raw), c.want) {
			t.Errorf("%s no longer carries the shape test GCPRegionOf mirrors (%s):\n  %s",
				c.path, c.why, c.want)
		}
	}
}

// TestByoIacSnapshotNormalizesTheGCPZone is the test whose ABSENCE let #4951 ship.
//
// `TestByoIacSnapshotCarriesIacSource` builds the same snapshot but asserts only the `iac_source`
// keys, so the `region` value was never read by anything. Deleting the normalization left the whole
// package green — measured, by deleting it — and the defect surfaced only on a paid cloud run when
// GCS answered `Error 400: The specified location constraint is not valid.`
//
// A fixture is not a test. That fixture passed `"europe-west4"`, a REGION, which is the one shape
// production never supplies; correcting it to a zone was necessary and on its own bought nothing,
// because no assertion looked at the field.
func TestByoIacSnapshotNormalizesTheGCPZone(t *testing.T) {
	src := byoIacSource{RepoURL: "https://x/y", Ref: "main", Path: "iac/drift/gcp", CommitSHA: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee"}

	for _, tc := range []struct {
		provider, in, want, why string
	}{
		{"gcp", "europe-west3-a", "europe-west3", "the shape resolveT2Region actually supplies for gcp"},
		{"gcp", "europe-west3", "europe-west3", "already regional — unchanged, so this is safe to apply twice"},
		{"aws", "us-east-1", "us-east-1", "aws puts a real region here; normalizing would EAT the -1"},
		{"azure", "westeurope", "westeurope", "azure likewise"},
		{"alibaba", "eu-central-1", "eu-central-1", "alibaba likewise — and -1 is not a zone suffix"},
		{"hetzner", "nbg1", "nbg1", "hetzner puts a location here"},
	} {
		snap := buildByoIacSnapshot("proj", "e2e1", tc.provider, tc.in, src)
		got, _ := snap["region"].(string)
		if got != tc.want {
			t.Errorf("buildByoIacSnapshot(%s, %q)[\"region\"] = %q, want %q\n  %s",
				tc.provider, tc.in, got, tc.want, tc.why)
		}
	}
}
