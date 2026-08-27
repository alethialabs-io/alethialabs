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
	"sort"
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
// hardened per-project AppProject).
//
// It AUTO-syncs, with prune and selfHeal both off (#2910). This comment used to say "MANUAL sync by
// design; the assertion triggers it" — which described the behaviour #2939 deleted, and described
// it approvingly. The harness triggering the sync was the defect: it was the only sync of a BYO
// chart anywhere, so it proved a path a customer does not have.
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
func (c t2ArgoRepos) applyToSnapshot(snap map[string]any) error {
	snap["repositories"] = map[string]any{"apps_destination_repo": c.appsRepo}
	// `snapshotList`, NOT a bare type assertion. This line read
	//
	//	existing, _ := snap["addons"].([]types.AddOnInstall)
	//
	// and the `_` was load-bearing in the worst way. `t2DeploySnapshot` builds `full` as
	// `a05NormalizeSnapshot(base)` — a json round trip — so by the time this runs `snap["addons"]`
	// is `[]any`, the assertion fails, `existing` is nil, and the append REPLACED every seeded
	// add-on with this one. On a full add-on surface that is 18 charts silently reduced to 1.
	//
	// It only bites when the A0.6 repos are wired, which is why it lay dormant: hetzner/addons
	// asserted twenty Applications on 2026-08-24 and four on 2026-08-25, and the only thing that
	// changed between them was `E2E_ARGO_APPS_REPO` being set.
	existing, err := snapshotList(snap, "addons")
	if err != nil {
		return err
	}
	snap["addons"] = append(existing, c.byoAddon())
	return nil
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
	n, err := argoAppResourceCount(ctx, kubeconfigPath, name)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("Application %q is Healthy+Synced but manages ZERO resources — the repo/chart rendered nothing, so the proof is vacuous (seed the apps repo with a manifest, and point the BYO chart at a non-empty chart)", name)
	}
	return nil
}

// argoAppResourceCount reads how many manifests an Application actually manages. Split out from the
// >0 assertion above so a caller that must RECORD the count in a machine-readable verdict reads it
// from the same place the floor is enforced, instead of keeping a second near-identical kubectl
// reader in step with it.
func argoAppResourceCount(ctx context.Context, kubeconfigPath, name string) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", name, "-n", "argocd", "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return 0, fmt.Errorf("read Application %q for resource count: %w: %s", name, err, strings.TrimSpace(string(ee.Stderr)))
		}
		return 0, fmt.Errorf("read Application %q for resource count: %w", name, err)
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
		return 0, fmt.Errorf("parse Application %q status: %w", name, e)
	}
	return len(app.Status.Resources), nil
}

// triggerArgoSync issues a sync operation on an Application over its CR (never the ArgoCD URL),
// mirroring what an operator does for a manual-sync (hardened BYO) Application.
//
// It RETURNS its error rather than swallowing it, and the difference is not academic. Retrying is
// still correct — patching while an operation is already running fails harmlessly, and the next poll
// succeeds — but `_ = cmd.Run()` made "the sync is queued and the chart is slow" indistinguishable
// from "every sync attempt was rejected". `addon-byo-e2e` sat Missing on hetzner/addons for a whole
// run under that ambiguity: Missing means it was NEVER synced, and the only thing that ever syncs it
// is this function.
//
// So the caller keeps retrying and keeps the LAST error, and reports it if the app never converges.
// Failing on the first error would be wrong — it would red the run on the harmless already-running
// case, which is the reason the error was discarded in the first place.
func triggerArgoSync(ctx context.Context, kubeconfigPath, name string) error {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "patch", "applications.argoproj.io", name,
		"--type", "merge", "-p", `{"operation":{"sync":{}}}`)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// kubectl's stderr carries the actual reason (already-running, not found, forbidden), and
		// those are three different remedies. A bare exit status is not actionable.
		return fmt.Errorf("sync %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
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
	var lastRefs []outOfSyncRef
	// Carried so the shared deadline dump can tell an OutOfSync loser (which HAS a diff to fetch)
	// from a Degraded-but-Synced one (which does not).
	var lastObserved map[string]argoAppState
	lastSyncErr := map[string]error{}
	for {
		raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
		if err != nil {
			lastErr = fmt.Errorf("listing ArgoCD Applications failed: %w", err)
			lastLosers, lastRefs = nil, nil
		} else if observed, perr := parseArgoApps(raw); perr != nil {
			lastErr = fmt.Errorf("parsing ArgoCD Applications failed: %w", perr)
			lastLosers, lastRefs = nil, nil
		} else {
			// Nudge the manual-sync (hardened BYO) apps that haven't converged yet, keeping the
			// last error per app so a persistently-REJECTED sync is reported instead of looking
			// like a slow one.
			for _, name := range manualSync {
				st, ok := observed[name]
				if !ok || st.Health != "Healthy" || st.Sync != "Synced" {
					if serr := triggerArgoSync(ctx, kubeconfigPath, name); serr != nil {
						lastSyncErr[name] = serr
					} else {
						// A success VOIDS an earlier failure. Carrying a stale error forward would
						// report a problem that has since resolved, which is its own wrong answer.
						delete(lastSyncErr, name)
					}
				}
			}
			losers, everr := evaluateArgoApps(observed, expected)
			if everr == nil {
				return nil
			}
			lastErr, lastLosers = everr, losers
			lastRefs = refsForLosers(observed, losers)
			lastObserved = observed
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ArgoCD Applications (incl. repo-apps + repo-byo) did not all reach Healthy+Synced within %s:\n%v%s%s",
				timeout, lastErr,
				renderSyncErrors(lastSyncErr),
				argoDeadlineDump(ctx, kubeconfigPath, lastObserved, lastLosers, lastRefs))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for ArgoCD Applications (%v); last state:\n%v", ctx.Err(), lastErr)
		case <-time.After(argoPollInterval):
		}
	}
}

// renderSyncErrors names the manual-sync apps whose LAST sync attempt was rejected, and why.
//
// This is the half that was missing. `triggerArgoSync` used to discard its error, so a manual-sync
// app that was never successfully synced looked exactly like one that was synced and is converging
// slowly — and ArgoCD reports both as OutOfSync. `addon-byo-e2e` sat `Missing` for a whole
// hetzner/addons run under that ambiguity, and `Missing` means it was NEVER synced: the sync is the
// only thing that could have moved it.
//
// Empty output when nothing failed, so a run whose syncs all succeeded says nothing extra rather
// than printing a reassuring empty section.
func renderSyncErrors(errs map[string]error) string {
	if len(errs) == 0 {
		return ""
	}
	names := make([]string, 0, len(errs))
	for name := range errs {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("\n  manual-sync apps whose LAST sync attempt was REJECTED (not merely slow):")
	for _, name := range names {
		fmt.Fprintf(&b, "\n    - %s: %v", name, errs[name])
	}
	return b.String()
}

// byoAutoSyncPolicy is the `syncPolicy.automated` block a BYO chart Application must carry.
//
// A POINTER, because the whole of #2910 is the difference between "absent" and "present with both
// sub-options false". Those two serialise almost identically to a careless reader and mean opposite
// things: absent is never synced at all, present-with-false is synced once and then left alone.
type byoAutoSyncPolicy struct {
	Prune    *bool `json:"prune"`
	SelfHeal *bool `json:"selfHeal"`
}

// interpretByoSyncPolicy is the verdict half of assertByoAutoSyncPolicy, split out so the three
// outcomes are testable without a cluster.
//
// #2910: a BYO Application rendered with no `automated` policy never syncs, and NOTHING in
// production syncs one — so the customer's chart deployed nothing, silently. The e2e's own
// `triggerArgoSync` was the only sync of a BYO chart anywhere, which is exactly why the bug
// survived: the harness proved a path the customer does not have.
//
// Both directions are checked. A missing policy is the regression that reintroduces the silent
// no-op; prune or selfHeal being TRUE is the opposite regression, where Alethia starts deleting
// resources a customer removed from their chart and reverting their live edits.
func interpretByoSyncPolicy(app string, automated *byoAutoSyncPolicy) error {
	if automated == nil {
		return fmt.Errorf("BYO Application %s carries NO syncPolicy.automated — nothing in production ever syncs a BYO chart, so it would deploy nothing at all and report no error (#2910)", app)
	}
	if automated.Prune == nil || automated.SelfHeal == nil {
		return fmt.Errorf("BYO Application %s has syncPolicy.automated with prune/selfHeal unset; both must be explicitly false", app)
	}
	if *automated.Prune {
		return fmt.Errorf("BYO Application %s has prune=true — Alethia must not delete a customer's workload because their chart stopped declaring it (#2910)", app)
	}
	if *automated.SelfHeal {
		return fmt.Errorf("BYO Application %s has selfHeal=true — ArgoCD must not fight an operator editing their own chart's resources (#2910)", app)
	}
	return nil
}

// assertByoAutoSyncPolicy reads the live Application and checks it can actually sync itself.
//
// On a FAILING verdict it appends what it actually read. aws/day2 run 33074136555 is why: it
// reported "prune/selfHeal unset" and stopped there, and that one sentence is consistent with two
// causes that have opposite fixes —
//
//	the EMITTER regressed          → packages/core/argocd/addons.go rendered no sub-options
//	something DROPPED them in-flight → the manifest carried `prune: false` and the stored object
//	                                  does not, which would make this assertion unsatisfiable
//
// and nothing in the tree distinguishes them: at that run's own SHA the renderer sets
// `&addonAutomated{Prune: false, SelfHeal: false}` with no `omitempty` on either field, ArgoCD
// v3.1.8's Application CRD types both as a plain boolean, and the wave applier `kubectl apply -f`s
// the rendered file without re-marshalling it. Every static half says the field should be there.
// So the next failure has to carry the object, not a description of it.
func assertByoAutoSyncPolicy(ctx context.Context, kubeconfigPath, app string) error {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app,
		"-o", "jsonpath={.spec.syncPolicy.automated}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("read %s syncPolicy: %w: %s", app, err, strings.TrimSpace(string(out)))
	}
	raw := strings.TrimSpace(string(out))
	// jsonpath prints NOTHING for an absent field — which is the regression, not a read failure.
	if raw == "" {
		return withByoSyncEvidence(ctx, kubeconfigPath, app, `<absent>`, interpretByoSyncPolicy(app, nil))
	}
	var automated byoAutoSyncPolicy
	if e := json.Unmarshal([]byte(raw), &automated); e != nil {
		return fmt.Errorf("parse %s syncPolicy.automated %q: %w", app, raw, e)
	}
	return withByoSyncEvidence(ctx, kubeconfigPath, app, raw, interpretByoSyncPolicy(app, &automated))
}

// byoSyncEvidenceLimit caps the dumped spec. A proof bundle is read by a human after a failed run;
// an unbounded Application spec (helm values are embedded as a literal block) would bury the
// verdict it is attached to.
const byoSyncEvidenceLimit = 4000

// withByoSyncEvidence attaches the live `spec.syncPolicy` to a FAILING verdict, and only to a
// failing one — a passing assertion stays silent.
//
// The evidence is strictly additive: if the dump cannot be read, the verdict is returned UNCHANGED
// rather than downgraded to "could not check". A failed second kubectl says nothing about whether
// the policy was right, and letting it mask the verdict would turn a real regression into a
// shrug — the same collapse `interpretArgoDiff` keeps apart for an RBAC refusal.
func withByoSyncEvidence(ctx context.Context, kubeconfigPath, app, observed string, verdict error) error {
	if verdict == nil {
		return nil
	}
	evidence := fmt.Sprintf("\n  observed spec.syncPolicy.automated: %s", observed)
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app,
		"-o", "jsonpath={.spec.syncPolicy}")
	out, err := cmd.CombinedOutput()
	switch {
	case err != nil:
		evidence += fmt.Sprintf("\n  full spec.syncPolicy: UNREADABLE (%v) — the verdict above stands on the read that did succeed", err)
	default:
		dump := strings.TrimSpace(string(out))
		if len(dump) > byoSyncEvidenceLimit {
			dump = dump[:byoSyncEvidenceLimit] + fmt.Sprintf("… (truncated at %d bytes)", byoSyncEvidenceLimit)
		}
		evidence += fmt.Sprintf("\n  full spec.syncPolicy: %s", dump)
	}
	return fmt.Errorf("%w%s", verdict, evidence)
}
