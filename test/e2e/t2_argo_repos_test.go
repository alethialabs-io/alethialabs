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

// clearArgoReposEnv blanks every A0.6 env var so a developer's ambient shell (or another
// test) can't perturb the resolution under test.
func clearArgoReposEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		envArgoAppsRepo, envArgoByoChartRepo, envArgoByoChartPath, envArgoByoRevision,
		envArgoByoNamespace, envArgoGitToken, envArgoReposRequire,
	} {
		t.Setenv(k, "")
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
	cfg.applyToSnapshot(snap)

	// repositories.apps_destination_repo drives repo-apps credentials + the "apps" app-of-apps.
	repos, ok := snap["repositories"].(map[string]any)
	if !ok || repos["apps_destination_repo"] != apps {
		t.Fatalf("snapshot repositories not wired: %#v", snap["repositories"])
	}

	// The BYO add-on is APPENDED — the reloader seed (the base ArgoCD-health teeth) is preserved.
	addons, ok := snap["addons"].([]types.AddOnInstall)
	if !ok {
		t.Fatalf("addons has unexpected type %T", snap["addons"])
	}
	if len(addons) != 2 {
		t.Fatalf("want 2 add-ons (reloader + BYO), got %d: %+v", len(addons), addons)
	}
	var haveReloader, haveByo bool
	for _, a := range addons {
		switch a.ID {
		case "reloader":
			haveReloader = true
		case byoAddonID:
			haveByo = true
		}
	}
	if !haveReloader || !haveByo {
		t.Errorf("expected both reloader and %q add-ons, got %+v", byoAddonID, addons)
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
	apps, err := DeriveExpectedArgoApps(meta)
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
	appsSkip, err := DeriveExpectedArgoApps(metaSkip)
	if err != nil {
		t.Fatalf("derive with apps-repo skipped: %v", err)
	}
	for _, a := range appsSkip {
		if a == "apps" {
			t.Errorf("a skipped apps-repo decision must NOT derive the \"apps\" Application, got %v", appsSkip)
		}
	}
}
