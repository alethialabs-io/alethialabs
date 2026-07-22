// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ArgoCD-WITH-REPOS + BYO Helm proof — the customer-repo half of the real-cloud
// provisioning proof (BYOC A0.6, the maintainer's #1 ask). The base T2 proof (A0.1–A0.5)
// stands up a real cluster and asserts the always-rendered platform Applications + a seeded
// marketplace add-on converge. This file adds the piece that was never proven on real infra:
// a real customer APPS-DESTINATION repo and a real BRING-YOUR-OWN Helm chart repo, wired as
// CREDENTIALED ArgoCD Applications, converging Healthy+Synced.
//
// The proof is cloud-agnostic: it works entirely over ArgoCD CRs (kubectl against the runner-written
// kubeconfig), never the ArgoCD URL/ingress (an ingress path would be aws-specific), so it runs
// unchanged on any gate-enabled leg — aws, gcp, azure (P2-D, #1066). Each leg's repo inputs are
// resolvable per provider (see the env-var const block), because a gcp/azure BYO chart / apps-repo —
// and, per #687, its service-binding against per-cloud tofu outputs — often cannot be the aws one.
//
// What it proves, end to end, over CRs only:
//
//   - repo-apps: the runner credentials ArgoCD to the apps-destination repo (the shared
//     "repo-apps" repository Secret) and renders the "apps" app-of-apps that syncs it. This
//     file asserts the "repo-apps" Secret exists AND the "apps" Application (derived from the
//     persisted apps-repo infra-service decision — never hardcoded) reaches Healthy+Synced.
//   - repo-byo-*: a bring-your-own git-source Helm chart is a managed add-on pinned to a
//     hardened per-project AppProject with a PER-REPO "repo-byo-<hash>" credential Secret. This
//     file asserts that Secret exists AND the chart's "addon-<id>" Application (already in the
//     derived set via addon_status) reaches Healthy+Synced.
//
// # Credential handling (program invariant 1: cred-holding steps are schedule/dispatch-only)
//
// The git token is NEVER placed in the config_snapshot (which is persisted to Postgres and
// could surface in a dump). It is served by the control plane's production-faithful
// POST /jobs/{id}/git-token handler straight from the T2 process env (ALETHIA_E2E_GIT_TOKEN,
// wired from the CI secret) and crosses to the sandbox child via its allowlisted env. The
// repo URLs are non-secret CI vars. Nothing here logs the token: go-git authenticates with a
// BasicAuth struct (no tokenized URL), ConfigureRepoCredentials logs only repoURL + secret
// name, and the credential-Secret checks read `-o name` (existence only, never the data).
//
// # How this proof defends its own vacuity (the whole point of A0.6)
//
//   - The expected set is DERIVED (DeriveExpectedArgoApps): "apps" comes from the apps-repo
//     infra-service decision the deploy recorded, and "addon-<byo-id>" from addon_status. The
//     test then HARD-ASSERTS both names are actually in that derived set (t2AssertContains) —
//     so a regression that stopped wiring the repo (empty derivation) fails loudly, never
//     passes quietly.
//   - Both credentialed Applications must be PRESENT and Healthy AND Synced (a missing app is a
//     hard failure in evaluateArgoApps), not merely "no error".
//   - A bring-your-own git-source Application renders with MANUAL sync (the hardened default —
//     an operator reviews an untrusted chart before it deploys), so it would sit OutOfSync
//     forever. AssertArgoReposConverge issues the sync operation over the Application CR (as an
//     operator would) and only then asserts Healthy+Synced — proving the credentialed clone,
//     the template render, and the deploy all actually work, not just that the app exists.
//   - Enablement is fail-safe: a fully-absent config is a clean opt-out skip, but a REQUIRED
//     run (the nightly sets ALETHIA_E2E_ARGO_REPOS_REQUIRE whenever the apps-repo var is set)
//     or any PARTIAL config is a loud error — a half-wired secret can never silently disable
//     the assertion.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The A0.6 configuration env vars. Repo URLs are non-secret CI vars; the token is a CI secret
// consumed only via the git-token API (envArgoGitToken is read by controlplane.go handleGitToken).
//
// Per-cloud overrides (P2-D, #1066): every repo input is ALSO resolvable per provider via a
// "<base>_<PROVIDER>" sibling (e.g. ALETHIA_E2E_ARGO_BYO_CHART_REPO_GCP), so a leg whose chart /
// apps-repo — and, per #687, whose service-binding resolves against THAT cloud's tofu outputs —
// must differ from the aws one can point at a cloud-appropriate repo/revision. When no per-provider
// sibling is set the shared cross-cloud var is used (aws's proven path is unchanged). The git token
// stays a single shared secret (it crosses via the API, and the handler reads only envArgoGitToken),
// so the git account it belongs to must grant read to every per-cloud repo.
const (
	envArgoAppsRepo     = "ALETHIA_E2E_ARGO_APPS_REPO"
	envArgoByoChartRepo = "ALETHIA_E2E_ARGO_BYO_CHART_REPO"
	envArgoByoChartPath = "ALETHIA_E2E_ARGO_BYO_CHART_PATH"
	envArgoByoRevision  = "ALETHIA_E2E_ARGO_BYO_CHART_REVISION"
	envArgoByoNamespace = "ALETHIA_E2E_ARGO_BYO_CHART_NAMESPACE"
	envArgoGitToken     = "ALETHIA_E2E_GIT_TOKEN"
	envArgoReposRequire = "ALETHIA_E2E_ARGO_REPOS_REQUIRE"
	// envE2EProvider is the current leg's cloud (aws|gcp|azure|alibaba|hetzner); the harness sets it
	// from the workflow matrix. Read here (not just by the base test) so the repo inputs can be
	// resolved per provider.
	envE2EProvider = "ALETHIA_E2E_PROVIDER"
)

// t2ArgoEnvForProvider resolves an A0.6 repo input with an optional per-provider override. It prefers
// "<base>_<PROVIDER>" (uppercased provider suffix, matching the conventional CI variable name) so a
// gcp/azure leg can point at a cloud-appropriate chart/apps-repo (#687: its service-binding resolves
// against per-cloud tofu outputs), and falls back to the shared cross-cloud "<base>" (aws's proven
// path), then to def. An empty provider (unit tests, no leg) skips straight to the shared var, so the
// flat resolution is byte-identical to before per-cloud overrides existed.
func t2ArgoEnvForProvider(base, provider, def string) string {
	if p := strings.ToUpper(strings.TrimSpace(provider)); p != "" {
		if v := t2Env(base+"_"+p, ""); v != "" {
			return v
		}
	}
	return t2Env(base, def)
}

// byoAddonID is the catalog id of the seeded bring-your-own chart. Its ArgoCD Application is
// "addon-<byoAddonID>" (argocd.AddOnAppName) and its per-repo credential Secret is
// "repo-byo-<hash>" (argocd.ByoRepoSecretName), both deterministic so the assertion can address
// them without reading anything back from the runner.
const byoAddonID = "byo-e2e"

// t2ArgoRepos is the resolved A0.6 configuration: the apps-destination repo, the bring-your-own
// chart coordinates, whether a git token is available (presence only — the value crosses via the
// API), and whether the run REQUIRES the proof (so a missing input hard-fails instead of skips).
type t2ArgoRepos struct {
	appsRepo     string
	byoChartRepo string
	byoChartPath string
	byoRevision  string
	byoNamespace string
	tokenPresent bool
	require      bool
}

// t2ArgoReposFromEnv reads the A0.6 configuration from the environment, applying safe defaults for
// the BYO chart path/revision/namespace. It reads os.Getenv via t2Env so unit tests drive it with
// t.Setenv.
func t2ArgoReposFromEnv() t2ArgoRepos {
	provider := t2Env(envE2EProvider, "")
	return t2ArgoRepos{
		appsRepo:     t2ArgoEnvForProvider(envArgoAppsRepo, provider, ""),
		byoChartRepo: t2ArgoEnvForProvider(envArgoByoChartRepo, provider, ""),
		byoChartPath: t2ArgoEnvForProvider(envArgoByoChartPath, provider, "chart"),
		byoRevision:  t2ArgoEnvForProvider(envArgoByoRevision, provider, "HEAD"),
		byoNamespace: t2ArgoEnvForProvider(envArgoByoNamespace, provider, "byo-e2e"),
		// The token is a single shared secret (crosses via the API; the handler reads only the flat
		// var), so it is NOT resolved per provider — presence is enough here.
		tokenPresent: t2Env(envArgoGitToken, "") != "",
		require:      t2Truthy(t2Env(envArgoReposRequire, "")),
	}
}

// decide resolves whether the A0.6 proof runs. Three honest outcomes, never a silent disable:
//   - all inputs present ⇒ ENABLED (run the proof);
//   - all inputs absent AND not required ⇒ a clean opt-out skip (base T2 still proves A0.1–A0.5);
//   - anything else — a REQUIRED run missing an input, or a PARTIAL config (always a mistake) —
//     ⇒ a LOUD error, so a half-wired secret can never quietly turn the assertion off.
func (c t2ArgoRepos) decide() (enabled bool, err error) {
	if c.appsRepo != "" && c.byoChartRepo != "" && c.tokenPresent {
		return true, nil
	}
	none := c.appsRepo == "" && c.byoChartRepo == "" && !c.tokenPresent
	if none && !c.require {
		return false, nil
	}
	var missing []string
	if c.appsRepo == "" {
		missing = append(missing, envArgoAppsRepo)
	}
	if c.byoChartRepo == "" {
		missing = append(missing, envArgoByoChartRepo)
	}
	if !c.tokenPresent {
		missing = append(missing, envArgoGitToken)
	}
	why := "partially configured"
	if c.require {
		why = "REQUIRED (" + envArgoReposRequire + " set)"
	}
	return false, fmt.Errorf("ArgoCD-with-repos proof (BYOC A0.6) is %s but incomplete — missing %s (set all three: an apps-destination repo, a BYO chart repo, and a git token, or none of them)",
		why, strings.Join(missing, ", "))
}

// byoAddon builds the bring-your-own git-source Helm add-on: a MANAGED add-on (so
// RenderManagedAddOns renders its "addon-<id>" Application) with Source "git" (so it pulls from
// the customer's chart repo via the per-repo "repo-byo-<hash>" credential and renders into the
// hardened per-project AppProject). It carries MANUAL sync by design; the assertion triggers it.
func (c t2ArgoRepos) byoAddon() types.AddOnInstall {
	return types.AddOnInstall{
		ID:        byoAddonID,
		Mode:      "managed",
		Source:    "git",
		ChartRepo: c.byoChartRepo,
		Path:      c.byoChartPath,
		Version:   c.byoRevision,
		Namespace: c.byoNamespace,
		Values:    map[string]interface{}{},
		SyncWave:  2,
	}
}

// byoAppName is the ArgoCD Application name of the seeded BYO chart (repo-byo-* credentialed).
func (c t2ArgoRepos) byoAppName() string { return argocd.AddOnAppName(byoAddonID) }

// byoSecretName is the per-repo ArgoCD repository credential Secret for the BYO chart repo.
func (c t2ArgoRepos) byoSecretName() string { return argocd.ByoRepoSecretName(c.byoChartRepo) }

// applyToSnapshot wires the A0.6 inputs into a seeded DEPLOY config snapshot: the
// apps-destination repo (drives repo-apps credentials + the "apps" app-of-apps) and the BYO
// chart add-on (appended to the existing seed add-ons — reloader is preserved). The git token is
// deliberately NOT written here; it is served by the control plane's git-token handler.
func (c t2ArgoRepos) applyToSnapshot(snap map[string]any) {
	snap["repositories"] = map[string]any{"apps_destination_repo": c.appsRepo}
	existing, _ := snap["addons"].([]types.AddOnInstall)
	snap["addons"] = append(existing, c.byoAddon())
}

// t2AssertContains reports an error unless want is present in got — the fail-closed guard that the
// repo-sourced Applications are GENUINELY in the derived expected set (not a vacuous pass).
func t2AssertContains(got []string, want string) error {
	for _, g := range got {
		if g == want {
			return nil
		}
	}
	return fmt.Errorf("expected ArgoCD Application %q was NOT derived from the deploy's execution_metadata (got %v) — the repo was not wired; A0.6 would be vacuous", want, got)
}

// assertRepoCredentialSecret verifies an ArgoCD repository-credential Secret exists in the argocd
// namespace, reading `-o name` ONLY (the Secret's data — the git token — is never fetched or
// printed). This is the direct proof that the credential was seeded, complementing the Application
// health check.
func assertRepoCredentialSecret(ctx context.Context, kubeconfigPath, name string) error {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "secret", name, "-n", "argocd", "-o", "name")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return fmt.Errorf("ArgoCD repository credential Secret %q missing in the argocd namespace: %w: %s", name, err, strings.TrimSpace(string(ee.Stderr)))
		}
		return fmt.Errorf("ArgoCD repository credential Secret %q missing in the argocd namespace: %w", name, err)
	}
	if strings.TrimSpace(string(out)) == "" {
		return fmt.Errorf("ArgoCD repository credential Secret %q not found in the argocd namespace", name)
	}
	return nil
}

// assertArgoAppManagesResources proves the named Application is NOT vacuously empty: it reads the
// Application's own `.status.resources` (the live set of manifests ArgoCD manages for it, over the
// CR — never the ArgoCD URL) and requires at least one. An Application that renders zero manifests
// — an EMPTY apps-destination repo or an EMPTY/trivial BYO chart — reports Healthy+Synced trivially,
// so without this check A0.6 could green on "credentialed clone + converge" WITHOUT proving GitOps
// actually deployed a workload. The count is the honest "it really did something" signal.
func assertArgoAppManagesResources(ctx context.Context, kubeconfigPath, name string) error {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", name, "-n", "argocd", "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return fmt.Errorf("read Application %q for resource count: %w: %s", name, err, strings.TrimSpace(string(ee.Stderr)))
		}
		return fmt.Errorf("read Application %q for resource count: %w", name, err)
	}
	var app struct {
		Status struct {
			Resources []struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"resources"`
		} `json:"status"`
	}
	if e := json.Unmarshal(out, &app); e != nil {
		return fmt.Errorf("parse Application %q status: %w", name, e)
	}
	if len(app.Status.Resources) == 0 {
		return fmt.Errorf("Application %q is Healthy+Synced but manages ZERO resources — the repo/chart rendered nothing, so the proof is vacuous (seed the apps repo with a manifest, and point the BYO chart at a non-empty chart)", name)
	}
	return nil
}

// triggerArgoSync issues a sync operation on an Application over its CR (never the ArgoCD URL),
// mirroring what an operator does for a manual-sync (hardened BYO) Application. Best-effort: an
// empty sync uses the app's configured targetRevision, and patching while an operation is already
// running returns a harmless error the caller ignores (it retries next poll).
func triggerArgoSync(ctx context.Context, kubeconfigPath, name string) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "patch", "applications.argoproj.io", name,
		"--type", "merge", "-p", `{"operation":{"sync":{}}}`)
	_ = cmd.Run()
}

// AssertArgoReposConverge is A0.6's convergence assertion. It is A0.2's bounded poll
// (kubectlGetArgoApps → parseArgoApps → evaluateArgoApps, argoPollInterval) EXTENDED with a sync
// trigger for the named manual-sync Applications: on each iteration any listed app that is not yet
// Healthy+Synced is (re)issued a sync operation over its CR, so a hardened bring-your-own chart
// actually converges instead of sitting OutOfSync. Every expected Application — the always-rendered
// platform apps, the seeded marketplace add-on, the repo-apps "apps" app-of-apps, and the repo-byo
// chart — must reach Healthy AND Synced within timeout, else it fails with the same full per-app
// dump + kubectl describe A0.2 produces. An empty expected set is refused (vacuity guard).
func AssertArgoReposConverge(ctx context.Context, kubeconfigPath string, expected, manualSync []string, timeout time.Duration) error {
	if len(expected) == 0 {
		return errors.New("refusing a VACUOUS ArgoCD-with-repos assertion: the expected Application set is empty")
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	var lastLosers []string
	for {
		raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
		if err != nil {
			lastErr = fmt.Errorf("listing ArgoCD Applications failed: %w", err)
			lastLosers = nil
		} else if observed, perr := parseArgoApps(raw); perr != nil {
			lastErr = fmt.Errorf("parsing ArgoCD Applications failed: %w", perr)
			lastLosers = nil
		} else {
			// Nudge the manual-sync (hardened BYO) apps that haven't converged yet.
			for _, name := range manualSync {
				st, ok := observed[name]
				if !ok || st.Health != "Healthy" || st.Sync != "Synced" {
					triggerArgoSync(ctx, kubeconfigPath, name)
				}
			}
			losers, everr := evaluateArgoApps(observed, expected)
			if everr == nil {
				return nil
			}
			lastErr, lastLosers = everr, losers
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ArgoCD Applications (incl. repo-apps + repo-byo) did not all reach Healthy+Synced within %s:\n%v%s",
				timeout, lastErr, describeArgoApps(ctx, kubeconfigPath, lastLosers))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for ArgoCD Applications (%v); last state:\n%v", ctx.Err(), lastErr)
		case <-time.After(argoPollInterval):
		}
	}
}
