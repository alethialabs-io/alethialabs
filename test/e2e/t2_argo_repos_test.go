// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Untagged unit proof for the ArgoCD-with-repos config seam (BYOC A0.6): the
// enable/skip/hard-fail decision, the snapshot wiring, the derived deterministic
// Application + credential-Secret names, and the fail-closed "apps" derivation — all
// exercised WITHOUT a cloud, a token, or the e2e_t2 build tag, so a bare
// `go test ./...` in test/e2e catches a regression in the seam before the nightly does.
//
// The point of A0.6 is that the assertion CANNOT vacuously pass, so these tests attack
// exactly that: a half-wired config must hard-error (never silently disable), the
// repo-sourced Applications must be genuinely derived, and the token must never enter the
// persisted snapshot.
package e2e

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// clearArgoReposEnv blanks every A0.6 env var — the shared vars, the leg-selecting provider var, and
// the per-provider override siblings for the clouds these tests exercise — so a developer's ambient
// shell (or another test) can't perturb the resolution under test.
func clearArgoReposEnv(t *testing.T) {
	t.Helper()
	bases := []string{
		envArgoAppsRepo, envArgoByoChartRepo, envArgoByoChartPath, envArgoByoRevision,
		envArgoByoNamespace,
	}
	for _, k := range append(bases, envArgoGitToken, envArgoReposRequire, envE2EProvider) {
		t.Setenv(k, "")
	}
	// Per-provider override siblings for the clouds under test (AWS/GCP/AZURE).
	for _, base := range bases {
		for _, p := range []string{"AWS", "GCP", "AZURE"} {
			t.Setenv(base+"_"+p, "")
		}
	}
}

func TestT2ArgoReposDecide(t *testing.T) {
	const (
		apps  = "https://github.com/acme/apps"
		chart = "https://github.com/acme/charts"
		tok   = "ghs_deadbeef"
	)
	cases := []struct {
		name        string
		appsRepo    string
		byoRepo     string
		token       string
		require     bool
		wantEnabled bool
		wantErr     bool
		errNeedle   string // substring the error must mention (when wantErr)
	}{
		{name: "all present ⇒ enabled", appsRepo: apps, byoRepo: chart, token: tok, wantEnabled: true},
		{name: "none + not required ⇒ clean skip", wantEnabled: false},
		{name: "none + REQUIRED ⇒ hard fail", require: true, wantErr: true, errNeedle: envArgoAppsRepo},
		{name: "apps only ⇒ partial hard fail", appsRepo: apps, wantErr: true, errNeedle: envArgoByoChartRepo},
		{name: "missing token (partial) ⇒ hard fail names token", appsRepo: apps, byoRepo: chart, wantErr: true, errNeedle: envArgoGitToken},
		{name: "missing token + REQUIRED ⇒ hard fail", appsRepo: apps, byoRepo: chart, require: true, wantErr: true, errNeedle: "REQUIRED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearArgoReposEnv(t)
			t.Setenv(envArgoAppsRepo, tc.appsRepo)
			t.Setenv(envArgoByoChartRepo, tc.byoRepo)
			t.Setenv(envArgoGitToken, tc.token)
			if tc.require {
				t.Setenv(envArgoReposRequire, "1")
			}
			cfg := t2ArgoReposFromEnv()
			enabled, err := cfg.decide()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want a hard error, got enabled=%v nil err", enabled)
				}
				if enabled {
					t.Errorf("an errored decision must not report enabled")
				}
				if tc.errNeedle != "" && !strings.Contains(err.Error(), tc.errNeedle) {
					t.Errorf("error %q should mention %q", err.Error(), tc.errNeedle)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if enabled != tc.wantEnabled {
				t.Errorf("enabled = %v, want %v", enabled, tc.wantEnabled)
			}
		})
	}
}

func TestT2ArgoReposDefaults(t *testing.T) {
	clearArgoReposEnv(t)
	t.Setenv(envArgoAppsRepo, "https://github.com/acme/apps")
	t.Setenv(envArgoByoChartRepo, "https://github.com/acme/charts")
	t.Setenv(envArgoGitToken, "ghs_x")
	cfg := t2ArgoReposFromEnv()
	if cfg.byoChartPath != "chart" {
		t.Errorf("default byo chart path = %q, want %q", cfg.byoChartPath, "chart")
	}
	if cfg.byoRevision != "HEAD" {
		t.Errorf("default byo revision = %q, want %q", cfg.byoRevision, "HEAD")
	}
	if cfg.byoNamespace != "byo-e2e" {
		t.Errorf("default byo namespace = %q, want %q", cfg.byoNamespace, "byo-e2e")
	}
	if !cfg.tokenPresent {
		t.Errorf("token should be detected present")
	}
}

// TestT2ArgoReposPerProviderOverride proves the P2-D (#1066) per-cloud override precedence: with a
// leg's provider set, a "<base>_<PROVIDER>" sibling wins over the shared cross-cloud var, and an
// absent sibling falls back to the shared var — so gcp/azure point at cloud-appropriate charts (whose
// #687 bindings resolve against per-cloud tofu outputs) while aws stays on the shared, proven repo.
func TestT2ArgoReposPerProviderOverride(t *testing.T) {
	const (
		sharedApps  = "https://github.com/acme/apps"
		sharedChart = "https://github.com/acme/charts"
		gcpChart    = "https://github.com/acme/charts-gcp"
	)

	// GCP leg with a per-provider BYO chart override + a per-provider revision, but no per-provider
	// apps repo ⇒ chart+revision come from the GCP siblings, apps repo falls back to the shared var.
	clearArgoReposEnv(t)
	t.Setenv(envE2EProvider, "gcp")
	t.Setenv(envArgoAppsRepo, sharedApps)
	t.Setenv(envArgoByoChartRepo, sharedChart)
	t.Setenv(envArgoByoChartRepo+"_GCP", gcpChart)
	t.Setenv(envArgoByoRevision+"_GCP", "gcp-branch")
	t.Setenv(envArgoGitToken, "ghs_x")
	cfg := t2ArgoReposFromEnv()
	if cfg.byoChartRepo != gcpChart {
		t.Errorf("gcp BYO chart = %q, want the per-provider override %q", cfg.byoChartRepo, gcpChart)
	}
	if cfg.byoRevision != "gcp-branch" {
		t.Errorf("gcp BYO revision = %q, want the per-provider override %q", cfg.byoRevision, "gcp-branch")
	}
	if cfg.appsRepo != sharedApps {
		t.Errorf("apps repo = %q, want the shared fallback %q (no gcp override set)", cfg.appsRepo, sharedApps)
	}

	// AWS leg with the SAME env: aws has no per-provider siblings, so every input is the shared var —
	// the proven aws path must be byte-for-byte unchanged by the override mechanism.
	t.Setenv(envE2EProvider, "aws")
	awsCfg := t2ArgoReposFromEnv()
	if awsCfg.byoChartRepo != sharedChart {
		t.Errorf("aws BYO chart = %q, want the shared var %q (no aws override)", awsCfg.byoChartRepo, sharedChart)
	}
	if awsCfg.byoRevision != "HEAD" {
		t.Errorf("aws BYO revision = %q, want the default HEAD (no aws override)", awsCfg.byoRevision)
	}
}

func TestT2ArgoReposByoNamingAndShape(t *testing.T) {
	clearArgoReposEnv(t)
	const chart = "https://github.com/acme/charts"
	t.Setenv(envArgoAppsRepo, "https://github.com/acme/apps")
	t.Setenv(envArgoByoChartRepo, chart)
	t.Setenv(envArgoByoChartPath, "charts/podinfo")
	t.Setenv(envArgoByoRevision, "v1.2.3")
	t.Setenv(envArgoByoNamespace, "demo")
	t.Setenv(envArgoGitToken, "ghs_x")
	cfg := t2ArgoReposFromEnv()

	// Names are deterministic + match the runner's own derivation, so the assertion can
	// address the exact Application + credential Secret the deploy creates.
	if got, want := cfg.byoAppName(), argocd.AddOnAppName(byoAddonID); got != want {
		t.Errorf("byoAppName = %q, want %q", got, want)
	}
	if got, want := cfg.byoAppName(), "addon-byo-e2e"; got != want {
		t.Errorf("byoAppName = %q, want %q", got, want)
	}
	if got, want := cfg.byoSecretName(), argocd.ByoRepoSecretName(chart); got != want {
		t.Errorf("byoSecretName = %q, want %q", got, want)
	}
	if !strings.HasPrefix(cfg.byoSecretName(), "repo-byo-") {
		t.Errorf("byo credential Secret %q must be a repo-byo-* name", cfg.byoSecretName())
	}

	add := cfg.byoAddon()
	if add.Mode != "managed" {
		t.Errorf("BYO add-on must be managed (so RenderManagedAddOns renders its Application), got %q", add.Mode)
	}
	if !add.IsGitSource() {
		t.Errorf("BYO add-on must be a git source (Source=git), got %q", add.Source)
	}
	if add.ChartRepo != chart || add.Path != "charts/podinfo" || add.Version != "v1.2.3" || add.Namespace != "demo" {
		t.Errorf("BYO add-on coordinates not carried through: %+v", add)
	}
}

func TestT2ArgoReposApplyToSnapshot(t *testing.T) {
	clearArgoReposEnv(t)
	const apps = "https://github.com/acme/apps"
	t.Setenv(envArgoAppsRepo, apps)
	t.Setenv(envArgoByoChartRepo, "https://github.com/acme/charts")
	t.Setenv(envArgoGitToken, "ghs_super_secret_value")
	cfg := t2ArgoReposFromEnv()

	snap := map[string]any{
		"provider": "hetzner",
		"addons":   seedAddOns(), // the base reloader seed
	}
	if err := cfg.applyToSnapshot(snap); err != nil {
		t.Fatalf("applyToSnapshot: %v", err)
	}

	// repositories.apps_destination_repo drives repo-apps credentials + the "apps" app-of-apps.
	repos, ok := snap["repositories"].(map[string]any)
	if !ok || repos["apps_destination_repo"] != apps {
		t.Fatalf("snapshot repositories not wired: %#v", snap["repositories"])
	}

	// The BYO add-on is APPENDED — the reloader seed (the base ArgoCD-health teeth) is preserved.
	//
	// Read via addOnIDsInSnapshot, which tolerates BOTH shapes. Asserting
	// `.([]types.AddOnInstall)` here is what made this test blind: production reaches
	// applyToSnapshot through a05NormalizeSnapshot's json round trip, so the live shape is
	// `[]any` — a shape this assertion would have called "unexpected" while the code under test
	// silently dropped everything. See TestApplyToSnapshotPreservesRoundTrippedAddOns.
	ids := addOnIDsInSnapshot(t, snap)
	if len(ids) != 2 {
		t.Fatalf("want 2 add-ons (reloader + BYO), got %d: %v", len(ids), ids)
	}
	var haveReloader, haveByo bool
	for _, id := range ids {
		switch id {
		case "reloader":
			haveReloader = true
		case byoAddonID:
			haveByo = true
		}
	}
	if !haveReloader || !haveByo {
		t.Errorf("expected both reloader and %q add-ons, got %v", byoAddonID, ids)
	}

	// SECURITY: the git token must NEVER appear in the persisted snapshot (it crosses only via
	// the git-token API). Marshal the whole snapshot and grep for it.
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "ghs_super_secret_value") {
		t.Fatalf("git token leaked into the config snapshot: %s", raw)
	}
}

func TestT2AssertContains(t *testing.T) {
	if err := t2AssertContains([]string{"apps", "addon-byo-e2e", "metrics-server"}, "apps"); err != nil {
		t.Errorf("apps should be found: %v", err)
	}
	err := t2AssertContains([]string{"metrics-server", "external-secrets-operator"}, "apps")
	if err == nil {
		t.Fatal("a missing repo-apps app must be a loud error, not a silent pass")
	}
	if !strings.Contains(err.Error(), "vacuous") {
		t.Errorf("missing-app error should call out the vacuity risk, got %q", err.Error())
	}
}

// TestDeriveExpectedArgoApps_AppsRepoFromDecision proves the end-to-end derivation: a persisted
// apps-repo "installed" infra-service decision must derive the "apps" Application (fail-closed,
// via the infraServiceArgoApps map), and a "skipped" one must NOT — so the repo-apps assertion
// only fires when the deploy actually wired the repo.
func TestDeriveExpectedArgoApps_AppsRepoFromDecision(t *testing.T) {
	installed := argocd.InfraServiceDecisions(&argocd.InfraFacts{AppsDestinationRepo: "https://github.com/acme/apps"})
	meta, _ := json.Marshal(map[string]any{
		"infra_services": installed,
		"addon_status":   map[string]any{"addon-reloader": map[string]string{"health": "Healthy", "sync": "Synced"}},
	})
	apps, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("derive with apps-repo installed: %v", err)
	}
	if err := t2AssertContains(apps, "apps"); err != nil {
		t.Errorf("apps-repo installed must derive the \"apps\" Application: %v", err)
	}

	skipped := argocd.InfraServiceDecisions(&argocd.InfraFacts{}) // no apps repo
	metaSkip, _ := json.Marshal(map[string]any{
		"infra_services": skipped,
		"addon_status":   map[string]any{"addon-reloader": map[string]string{"health": "Healthy", "sync": "Synced"}},
	})
	appsSkip, err := DeriveExpectedArgoApps("aws", metaSkip)
	if err != nil {
		t.Fatalf("derive with apps-repo skipped: %v", err)
	}
	for _, a := range appsSkip {
		if a == "apps" {
			t.Errorf("a skipped apps-repo decision must NOT derive the \"apps\" Application, got %v", appsSkip)
		}
	}
}

// addOnIDsInSnapshot reads add-on ids from a snapshot in EITHER shape — the typed slice a builder
// produces, or the []any a json round trip produces. Tests must be able to read both, because
// production sees both at different points in the same pipeline.
func addOnIDsInSnapshot(t *testing.T, snap map[string]any) []string {
	t.Helper()
	raw, err := json.Marshal(snap["addons"])
	if err != nil {
		t.Fatalf("addons not encodable: %v", err)
	}
	var list []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatalf("addons is not a list: %v", err)
	}
	ids := make([]string, 0, len(list))
	for _, a := range list {
		ids = append(ids, a.ID)
	}
	return ids
}

// TestApplyToSnapshotPreservesRoundTrippedAddOns is THE regression, and it is the test the previous
// one could not be.
//
// `t2DeploySnapshot` builds `full` as `a05NormalizeSnapshot(base)` — a json.Marshal/Unmarshal round
// trip — and only then calls `repos.applyToSnapshot(full)`. So the live shape of `snap["addons"]`
// at that moment is `[]any`, never `[]types.AddOnInstall`. The old line
//
//	existing, _ := snap["addons"].([]types.AddOnInstall)
//
// therefore always failed, `_` swallowed it, `existing` was nil, and the append REPLACED every
// seeded add-on with the single BYO chart.
//
// Measured on hetzner/addons: twenty Applications asserted on 2026-08-24, four on 2026-08-25, with
// `E2E_ARGO_APPS_REPO` being set between them the only change. On aws/full the same day the expected
// set was six. Both runs reported the "18-chart sweep".
//
// The axis this varies is THE SHAPE OF THE SNAPSHOT, which is the axis the bug lived on. A test
// that only ever builds the typed shape passes against the defect — the previous one did, for weeks.
func TestApplyToSnapshotPreservesRoundTrippedAddOns(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	seeded := seedAddOns()
	if len(seeded) < 5 {
		t.Fatalf("full add-on surface expected; got %d — this test would be vacuous", len(seeded))
	}

	base := map[string]any{"addons": seeded}
	// EXACTLY what t2DeploySnapshot does, and the whole point of the test.
	full, err := a05NormalizeSnapshot(base)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if _, isAny := full["addons"].([]any); !isAny {
		t.Fatalf("precondition failed: after the round trip addons should be []any, got %T", full["addons"])
	}

	cfg := t2ArgoRepos{appsRepo: "https://example.com/apps", byoChartRepo: "https://example.com/chart", byoNamespace: "byo-e2e"}
	if err := cfg.applyToSnapshot(full); err != nil {
		t.Fatalf("applyToSnapshot: %v", err)
	}

	ids := addOnIDsInSnapshot(t, full)
	if len(ids) != len(seeded)+1 {
		t.Fatalf("the BYO add-on must be APPENDED, not substituted: want %d add-ons, got %d: %v",
			len(seeded)+1, len(ids), ids)
	}
	// Name one that must survive, so a length-only check cannot pass on the wrong set.
	var haveReloader, haveByo bool
	for _, id := range ids {
		if id == "reloader" {
			haveReloader = true
		}
		if id == byoAddonID {
			haveByo = true
		}
	}
	if !haveReloader {
		t.Error("reloader was dropped — the seeded surface did not survive the append")
	}
	if !haveByo {
		t.Errorf("%q was not added", byoAddonID)
	}
}

// TestSnapshotListRefusesANonList — the helper must REPORT a shape it cannot read, never return an
// empty list. Returning nil is what turned a caller's append into a silent substitution.
func TestSnapshotListRefusesANonList(t *testing.T) {
	if _, err := snapshotList(map[string]any{"addons": "not-a-list"}, "addons"); err == nil {
		t.Fatal("a string must be reported, not treated as an empty list")
	}
	got, err := snapshotList(map[string]any{}, "addons")
	if err != nil || got != nil {
		t.Fatalf("an ABSENT key is genuinely empty and must not error: %v / %v", got, err)
	}
}
