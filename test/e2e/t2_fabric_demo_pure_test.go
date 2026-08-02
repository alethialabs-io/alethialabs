// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE fabric enterprise-demo helpers (#845) — no cloud, no Postgres, no
// e2e_t2 tag. These prove the acceptance gate cannot pass vacuously: an empty overlay list is a
// HARD error rather than a zero-iteration success, a misrouted ApplicationSet-generated app is
// refused rather than matched, and the verdict only reads green when every tier actually placed,
// converged, and delivered resources.
package e2e

import (
	"strings"
	"testing"
	"time"
)

func TestFabricDemoSlug(t *testing.T) {
	cases := []struct {
		name, env, tier, want string
	}{
		{"plain", "30735441957-1", "dev", "e2e-demo-dev-30735441957-1"},
		{"uppercase + spaces", " Prod ", "Staging", "e2e-demo-staging-prod"},
		{"unsafe characters collapse", "a/b_c", "dev", "e2e-demo-dev-a-b-c"},
		{"empty tier falls back", "x", "", "e2e-demo-env-x"},
		{"empty env is dropped", "", "dev", "e2e-demo-dev"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := fabricDemoSlug(c.env, c.tier); got != c.want {
				t.Fatalf("fabricDemoSlug(%q, %q) = %q, want %q", c.env, c.tier, got, c.want)
			}
		})
	}

	// The k8s namespace limit is 63 chars and a slug that blows it is rejected by the API server
	// AFTER the placement job is already running — bound it here instead.
	long := fabricDemoSlug(strings.Repeat("verylongenvironment", 10), "staging")
	if len(long) > 63 {
		t.Fatalf("slug is %d chars (%q) — exceeds the 63-char RFC-1123 namespace limit", len(long), long)
	}
	if strings.HasSuffix(long, "-") {
		t.Fatalf("truncated slug %q ends in '-', which is not a valid namespace", long)
	}

	// Disjoint from the sibling placement scenarios: three placements run inside ONE cluster
	// lifetime, so colliding prefixes would have them fight over the same namespace.
	if ns := fabricDemoSlug("e", "dev"); strings.HasPrefix(ns, namespaceTenantSlug("e")) || strings.HasPrefix(ns, vclusterTenantSlug("e")) {
		t.Fatalf("fabric-demo slug %q collides with the #959/#1308 namespaces", ns)
	}
}

func TestFabricDemoOverlays(t *testing.T) {
	t.Run("default tracks the enterprise-demo layout", func(t *testing.T) {
		tiers, err := fabricDemoOverlays("aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tiers) != 2 || tiers[0] != "dev" || tiers[1] != "staging" {
			t.Fatalf("default overlays = %v, want [dev staging]", tiers)
		}
	})

	t.Run("explicit list is parsed and normalised", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, " Dev , STAGING ,, prod ")
		tiers, err := fabricDemoOverlays("aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tiers) != 3 || tiers[0] != "dev" || tiers[1] != "staging" || tiers[2] != "prod" {
			t.Fatalf("overlays = %v, want [dev staging prod]", tiers)
		}
	})

	t.Run("per-provider override wins", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, "dev")
		t.Setenv(envFabricDemoOverlays+"_GCP", "dev,staging")
		tiers, err := fabricDemoOverlays("gcp")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tiers) != 2 {
			t.Fatalf("gcp overlays = %v, want the per-provider override [dev staging]", tiers)
		}
	})

	// The vacuity refuter: an all-separator value must be a HARD error. A scenario that iterates
	// zero tiers would otherwise report success having asserted nothing at all.
	t.Run("empty list is a hard error", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, " , , ")
		if _, err := fabricDemoOverlays("aws"); err == nil {
			t.Fatal("expected a HARD FAIL for an empty overlay list — the gate would prove nothing")
		}
	})
}

func TestFabricDemoTimeout(t *testing.T) {
	if got := fabricDemoTimeout(); got != 10*time.Minute {
		t.Fatalf("default timeout = %v, want 10m", got)
	}
	t.Setenv(envFabricDemoTimeout, "90s")
	if got := fabricDemoTimeout(); got != 90*time.Second {
		t.Fatalf("override timeout = %v, want 90s", got)
	}
	// A non-positive or unparseable bound must fall back rather than becoming an instant timeout.
	for _, bad := range []string{"-1m", "0s", "soon", ""} {
		t.Setenv(envFabricDemoTimeout, bad)
		if got := fabricDemoTimeout(); got != 10*time.Minute {
			t.Fatalf("timeout for %q = %v, want the 10m fallback", bad, got)
		}
	}
}

func TestBuildFabricDemoSnapshot(t *testing.T) {
	p := fabricDemoParams{
		project: "alethia-nl", env: "30735441957-1", provider: "aws", region: "us-east-1",
		fabricClust: "eks-ue1-x-alethia-nl",
	}
	snap := buildFabricDemoSnapshot(p, "dev", "e2e-demo-dev-x", "https://github.com/o/r")

	if snap["placement_mode"] != "namespace" {
		t.Fatalf("placement_mode = %v, want namespace", snap["placement_mode"])
	}
	// The tier — not the base env — is the environment_stage: the overlay directory and the placed
	// env must name the same thing or the ApplicationSet's app and the placement diverge.
	if snap["environment_stage"] != "dev" {
		t.Fatalf("environment_stage = %v, want the tier 'dev'", snap["environment_stage"])
	}
	if snap["namespace"] != "e2e-demo-dev-x" {
		t.Fatalf("namespace = %v", snap["namespace"])
	}
	// No cluster SHAPE — a placement must never trigger a tofu run.
	cluster, ok := snap["cluster"].(map[string]any)
	if !ok || cluster["cluster_name"] != p.fabricClust {
		t.Fatalf("cluster = %v, want only the existing Fabric's name", snap["cluster"])
	}
	if len(cluster) != 1 {
		t.Fatalf("cluster carries %d keys (%v) — a namespace placement must carry NO node shape", len(cluster), cluster)
	}
	repos, ok := snap["repositories"].(map[string]any)
	if !ok || repos["apps_destination_repo"] != "https://github.com/o/r" {
		t.Fatalf("repositories = %v — without the apps repo the ApplicationSet generates nothing", snap["repositories"])
	}
}

func TestOverlayAppName(t *testing.T) {
	// Must match the ApplicationSet template's `apps-{{ .path.basename }}` over `overlays/*`
	// (infra/templates/argocd/user-apps-overlays.yaml) or the assertion addresses a name ArgoCD
	// never created.
	if got := overlayAppName(" Dev "); got != "apps-dev" {
		t.Fatalf("overlayAppName = %q, want apps-dev", got)
	}
}

// overlayAppJSON builds a one-item Application list in the shape kubectl returns.
func overlayAppJSON(name, project, path, ns, health, sync string) string {
	return `{"items":[{"metadata":{"name":"` + name + `"},"spec":{"project":"` + project +
		`","source":{"repoURL":"https://github.com/o/r","path":"` + path + `"},` +
		`"destination":{"server":"https://kubernetes.default.svc","namespace":"` + ns + `"}},` +
		`"status":{"health":{"status":"` + health + `"},"sync":{"status":"` + sync + `"}}}]}`
}

func TestFindOverlayApp(t *testing.T) {
	t.Run("matches the generated app", func(t *testing.T) {
		app, err := findOverlayApp([]byte(overlayAppJSON("apps-dev", "apps", "overlays/dev", "boutique-dev", "Healthy", "Synced")), "dev")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if app.Spec.Destination.Namespace != "boutique-dev" {
			t.Fatalf("destination namespace = %q", app.Spec.Destination.Namespace)
		}
		if !overlayConverged(app) {
			t.Fatal("Healthy+Synced app did not read as converged")
		}
	})

	// Fail-closed refuters. Each is a way a misrouted or absent overlay could otherwise slide
	// through as "converged".
	refuters := []struct {
		name, raw, tier string
	}{
		{"no such app", overlayAppJSON("apps-staging", "apps", "overlays/staging", "boutique-staging", "Healthy", "Synced"), "dev"},
		{"wrong project", overlayAppJSON("apps-dev", "infra", "overlays/dev", "boutique-dev", "Healthy", "Synced"), "dev"},
		{"wrong source path", overlayAppJSON("apps-dev", "apps", "overlays/production", "boutique-dev", "Healthy", "Synced"), "dev"},
		{"no destination namespace", overlayAppJSON("apps-dev", "apps", "overlays/dev", "   ", "Healthy", "Synced"), "dev"},
		{"empty list", `{"items":[]}`, "dev"},
		{"malformed json", `{"items":`, "dev"},
	}
	for _, r := range refuters {
		t.Run(r.name, func(t *testing.T) {
			if _, err := findOverlayApp([]byte(r.raw), r.tier); err == nil {
				t.Fatalf("expected a HARD FAIL for %q", r.name)
			}
		})
	}

	// Degraded / OutOfSync is FOUND (so the poll can report why) but must not read as converged.
	app, err := findOverlayApp([]byte(overlayAppJSON("apps-dev", "apps", "overlays/dev", "boutique-dev", "Degraded", "OutOfSync")), "dev")
	if err != nil {
		t.Fatalf("a routed-but-unhealthy app must still be found: %v", err)
	}
	if overlayConverged(app) {
		t.Fatal("Degraded/OutOfSync read as converged")
	}
}

// passingSummary is the shape of a fully-proven run; each refuter below breaks exactly one field.
func passingSummary() FabricDemoSummary {
	return FabricDemoSummary{
		Enabled: true, Provider: "aws", Fabric: "eks-ue1-x", Repo: "https://github.com/o/r",
		Tiers: []FabricDemoTier{
			{Tier: "dev", Placed: true, Converged: true, ResourceCount: 12, OverlayNS: "boutique-dev"},
			{Tier: "staging", Placed: true, Converged: true, ResourceCount: 12, OverlayNS: "boutique-staging"},
		},
		ArgoNotReinstalled: true,
		ReceiptScope:       "fabric",
		FabricPlanSHA:      strings.Repeat("a", 64),
		DriftChecked:       true, DriftInSync: true, DriftDrifted: 0,
	}
}

func TestFabricDemoVerdictPass(t *testing.T) {
	if !fabricDemoVerdictPass(passingSummary()) {
		t.Fatal("a fully-proven summary did not pass")
	}

	refuters := []struct {
		name   string
		break_ func(*FabricDemoSummary)
	}{
		{"disabled", func(s *FabricDemoSummary) { s.Enabled = false }},
		{"no tiers at all", func(s *FabricDemoSummary) { s.Tiers = nil }},
		{"a tier never placed", func(s *FabricDemoSummary) { s.Tiers[1].Placed = false }},
		{"a tier never converged", func(s *FabricDemoSummary) { s.Tiers[0].Converged = false }},
		{"a tier delivered no resources", func(s *FabricDemoSummary) { s.Tiers[0].ResourceCount = 0 }},
		{"argocd was reinstalled", func(s *FabricDemoSummary) { s.ArgoNotReinstalled = false }},
		{"no verified fabric receipt", func(s *FabricDemoSummary) { s.FabricPlanSHA = "" }},
		{"drift ran and found drift", func(s *FabricDemoSummary) { s.DriftDrifted = 3 }},
		{"drift ran and is not in-sync", func(s *FabricDemoSummary) { s.DriftInSync = false }},
	}
	for _, r := range refuters {
		t.Run(r.name, func(t *testing.T) {
			s := passingSummary()
			r.break_(&s)
			if fabricDemoVerdictPass(s) {
				t.Fatalf("summary still passed with %q — the verdict is vacuous", r.name)
			}
		})
	}

	// A drift check that did NOT run must not gate (it is bounded work the scenario may skip when
	// there is no base deploy job to alias state from) — but everything else must still hold.
	s := passingSummary()
	s.DriftChecked, s.DriftInSync, s.DriftDrifted = false, false, 7
	if !fabricDemoVerdictPass(s) {
		t.Fatal("an un-run drift check gated the verdict; only a check that RAN should")
	}
}

func TestFabricDemoSummaryVerdict(t *testing.T) {
	if got := fabricDemoSummaryVerdict(FabricDemoSummary{}); !strings.Contains(got, "skipped") {
		t.Fatalf("disabled verdict = %q, want a skip line", got)
	}
	pass := fabricDemoSummaryVerdict(passingSummary())
	if !strings.HasPrefix(pass, "✅") {
		t.Fatalf("passing verdict = %q, want a ✅ prefix", pass)
	}
	for _, want := range []string{"dev→boutique-dev", "staging→boutique-staging", "receipt(fabric)", "drift: in_sync=true"} {
		if !strings.Contains(pass, want) {
			t.Fatalf("verdict %q is missing %q", pass, want)
		}
	}
	// The 64-char digest must be abbreviated — the verdict is a ONE-LINE step-summary row.
	if strings.Contains(pass, strings.Repeat("a", 64)) {
		t.Fatalf("verdict dumps the full plan digest: %q", pass)
	}

	s := passingSummary()
	s.Tiers[0].Converged = false
	if got := fabricDemoSummaryVerdict(s); !strings.HasPrefix(got, "❌") {
		t.Fatalf("failing verdict = %q, want a ❌ prefix", got)
	}
}

func TestShortPlanSHA(t *testing.T) {
	if got := shortPlanSHA(""); got != "absent" {
		t.Fatalf("empty digest rendered %q, want 'absent' — a missing receipt must SAY so", got)
	}
	if got := shortPlanSHA("abc"); got != "abc" {
		t.Fatalf("short digest = %q", got)
	}
	if got := shortPlanSHA(strings.Repeat("b", 64)); got != strings.Repeat("b", 12)+"…" {
		t.Fatalf("long digest = %q", got)
	}
}
