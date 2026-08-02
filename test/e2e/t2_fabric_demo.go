// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fabric enterprise-demo acceptance scenario (#845) — the PURE, reusable half. Deliberately
// UNTAGGED (like t2_soak.go / t2_day2_access.go / t2_namespace_tenant.go) so `go mod tidy` sees
// its deps and the derive / route / verdict logic is unit-tested WITHOUT Postgres, a cloud, or a
// build tag (t2_fabric_demo_pure_test.go).
//
// # What #845 proves
//
// The base T2 run provisions ONE real cluster — the Fabric — and verifies its signed receipt. This
// scenario then layers the enterprise-demo shape onto that SAME Fabric: dev and staging as
// NAMESPACE placements, each carrying the apps-destination repo, so the runner renders the
// `apps-overlays` ApplicationSet (infra/templates/argocd/user-apps-overlays.yaml). That
// ApplicationSet's git-directories generator discovers every `overlays/*` directory in the repo and
// emits one ArgoCD Application per overlay — the standard Kustomize base+overlays layout, and
// exactly what github.com/alethialabs-io/enterprise-demo carries (overlays/dev, overlays/staging).
//
// The gap this closes: `DeriveExpectedArgoApps` (argocd_assert.go) derives app names from
// infra_services + addon_status, so it is STRUCTURALLY BLIND to ApplicationSet-generated apps.
// Before this scenario nothing in test/e2e asserted a Kustomize overlay ever converged — the
// multi-environment delivery path shipped with unit coverage only (packages/core/argocd
// render_test.go).
//
// # How this assertion defends its own vacuity
//
//   - The overlay set is EXPLICIT and non-empty: fabricDemoOverlays errors on an empty list rather
//     than looping zero times and reporting success. "Asserted nothing" must never render green.
//   - Each generated Application must MANAGE RESOURCES (assertArgoAppManagesResources reads its own
//     `.status.resources`). An empty overlay directory renders Healthy+Synced trivially — the
//     resource count is the honest "GitOps really delivered a workload" signal, the same floor A0.6
//     applies to the BYO chart.
//   - findOverlayApp fails CLOSED on a misrouted app: an overlay Application pinned to a project
//     other than `apps`, or with no destination namespace, is an error rather than a match.
//   - The placements must land on the EXISTING Fabric (namespaceClusterUnchanged) and must not
//     reinstall its ArgoCD (argocdNotReinstalled) — a scenario that quietly built a second cluster
//     would otherwise "pass".
//   - The PROOF surface is recorded HONESTLY, not fabricated. A namespace placement runs NO tofu
//     (runNamespaceDeploy mints keyless access to an existing cluster), so it has no plan JSON and
//     therefore CANNOT carry a verify receipt. The receipt this scenario reports is the FABRIC's —
//     already verified by the base run — and the summary says so in as many words. Asserting a
//     per-placement receipt would be asserting something the architecture cannot produce.
//   - Every wait is BOUNDED (ALETHIA_E2E_FABRIC_DEMO_TIMEOUT) so a never-converging overlay fails
//     loudly instead of hanging until the job cap kills the leg.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// Env vars this scenario reads. Every one must be set by .github/workflows/e2e-nightly.yml (as
// `${{ vars.X }}`, which keeps it off until a maintainer opts in) or TestScenarioEnablesReachTheNightly
// fails the build — a harness the nightly can never reach is dead code that looks shipped.
const (
	envFabricDemo         = "ALETHIA_E2E_FABRIC_DEMO"
	envFabricDemoRepo     = "ALETHIA_E2E_FABRIC_DEMO_REPO"
	envFabricDemoOverlays = "ALETHIA_E2E_FABRIC_DEMO_OVERLAYS"
	envFabricDemoTimeout  = "ALETHIA_E2E_FABRIC_DEMO_TIMEOUT"
	envFabricDemoSummary  = "ALETHIA_E2E_FABRIC_DEMO_SUMMARY"
)

// fabricDemoDefaultRepo is the PUBLIC enterprise-demo repo. Public matters: ArgoCD clones it
// anonymously (argocd.IsRepoAnonymouslyCloneable), so unlike the A0.6 apps-repo path this scenario
// needs NO git token — one less maintainer-held secret between the board and a real proof.
const fabricDemoDefaultRepo = "https://github.com/alethialabs-io/enterprise-demo"

// fabricDemoDefaultOverlays tracks the enterprise-demo layout (overlays/dev, overlays/staging) —
// the dev+staging pair #845 asks for. Overridable per-provider so a cloud-specific fork can carry a
// different set; the ApplicationSet discovers whatever `overlays/*` the repo actually has, and this
// list is what we REQUIRE to have converged.
const fabricDemoDefaultOverlays = "dev,staging"

// fabricDemoPollInterval is how often the overlay convergence poll re-reads. An ApplicationSet
// generator refresh plus a Kustomize render is tens of seconds, so a short poll is not wasted.
const fabricDemoPollInterval = 15 * time.Second

// fabricDemoParams carries what the scenario needs from the completed base provision.
type fabricDemoParams struct {
	project     string
	env         string
	provider    string
	region      string
	fabricClust string // meta.ClusterName from the base deploy — the Fabric every placement lands on
	owner       string // the SeedRunner owner, so the still-running base runner claims the seeded jobs
	deployJobID string // the base DEPLOY job — the state a drift re-prove aliases to
	planSHA     string // the Fabric's VERIFIED plan sha256 (base run), carried into the summary
}

// fabricDemoEnabled reports whether the opt-in scenario should run. Off by default: the base T2
// proof is unchanged unless a maintainer opts in.
func fabricDemoEnabled() bool { return t2Truthy(os.Getenv(envFabricDemo)) }

// fabricDemoRepo resolves the apps-destination repo for this cloud, per-provider-overridable via
// the shared <BASE>_<PROVIDER> idiom, defaulting to the public enterprise-demo.
func fabricDemoRepo(provider string) string {
	return t2ArgoEnvForProvider(envFabricDemoRepo, provider, fabricDemoDefaultRepo)
}

// fabricDemoTimeout bounds the overlay convergence + drift waits — ALETHIA_E2E_FABRIC_DEMO_TIMEOUT
// when set (a Go duration), else 10m. Each wait returns the moment it succeeds, so the default only
// costs time on a genuinely stuck overlay.
func fabricDemoTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv(envFabricDemoTimeout)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 10 * time.Minute
}

// fabricDemoOverlays resolves the overlay tiers this run REQUIRES to have converged. Fail-closed on
// an empty result: a scenario that iterates zero overlays would report success having asserted
// nothing, which is precisely the vacuity this file exists to prevent.
func fabricDemoOverlays(provider string) ([]string, error) {
	raw := t2ArgoEnvForProvider(envFabricDemoOverlays, provider, fabricDemoDefaultOverlays)
	var tiers []string
	for _, part := range strings.Split(raw, ",") {
		if t := strings.ToLower(strings.TrimSpace(part)); t != "" {
			tiers = append(tiers, t)
		}
	}
	if len(tiers) == 0 {
		return nil, fmt.Errorf("%s resolved to %q — no overlay tiers to assert; the scenario would pass having proven nothing", envFabricDemoOverlays, raw)
	}
	return tiers, nil
}

var fabricDemoSlugUnsafe = regexp.MustCompile(`[^a-z0-9-]+`)

// fabricDemoSlug derives the RFC-1123 namespace for a placed tier. Distinct prefix from #959's
// `e2e-ns-` and #1308's `e2e-vc-` so the three placement scenarios never collide inside one run.
// Bounded to 63 chars (the k8s namespace limit).
func fabricDemoSlug(env, tier string) string {
	clean := func(s string) string {
		return strings.Trim(fabricDemoSlugUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-"), "-")
	}
	t, e := clean(tier), clean(env)
	if t == "" {
		t = "env"
	}
	name := "e2e-demo-" + t
	if e != "" {
		name += "-" + e
	}
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	return name
}

// buildFabricDemoSnapshot returns the runner-facing config_snapshot for one tier's namespace
// placement onto the existing Fabric. It carries NO cluster shape (no tofu runs) — only the
// placement, the destination namespace, the EXISTING cluster to mint against, and the apps repo
// whose overlays/ directories drive the ApplicationSet.
func buildFabricDemoSnapshot(p fabricDemoParams, tier, ns, repo string) map[string]any {
	return map[string]any{
		"id":                "e2e-" + p.env + "-demo-" + tier,
		"project_name":      p.project,
		"environment_stage": tier,
		"region":            p.region,
		"provider":          p.provider,
		"placement_mode":    "namespace",
		"namespace":         ns,
		"cluster":           map[string]any{"cluster_name": p.fabricClust},
		"repositories":      map[string]any{"apps_destination_repo": repo},
	}
}

// overlayAppName is the Application name the apps-overlays ApplicationSet generates for a tier:
// `apps-{{ .path.basename }}` over `overlays/*`. Deterministic, so the assertion can address it.
func overlayAppName(tier string) string { return "apps-" + strings.ToLower(strings.TrimSpace(tier)) }

// overlayAppState is the minimal ArgoCD Application shape the overlay assertions read.
type overlayAppState struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Project string `json:"project"`
		Source  struct {
			RepoURL string `json:"repoURL"`
			Path    string `json:"path"`
		} `json:"source"`
		Destination struct {
			Server    string `json:"server"`
			Namespace string `json:"namespace"`
		} `json:"destination"`
	} `json:"spec"`
	Status struct {
		Health struct {
			Status string `json:"status"`
		} `json:"health"`
		Sync struct {
			Status string `json:"status"`
		} `json:"sync"`
	} `json:"status"`
}

// findOverlayApp parses a `kubectl get applications -o json` list and returns the generated overlay
// Application for a tier. Fail-closed: a missing app, an app pinned to a project other than the
// `apps` project the ApplicationSet template sets, an app whose source path is not this tier's
// overlay directory, or an app with no destination namespace are all errors — a misrouted overlay
// must not read as a converged one.
func findOverlayApp(listJSON []byte, tier string) (overlayAppState, error) {
	name := overlayAppName(tier)
	var list struct {
		Items []overlayAppState `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return overlayAppState{}, fmt.Errorf("decode applications list: %w", err)
	}
	for _, a := range list.Items {
		if a.Metadata.Name != name {
			continue
		}
		if a.Spec.Project != "apps" {
			return a, fmt.Errorf("overlay Application %q is pinned to project %q, want %q — the apps-overlays ApplicationSet template sets project: apps", name, a.Spec.Project, "apps")
		}
		if want := "overlays/" + strings.ToLower(strings.TrimSpace(tier)); a.Spec.Source.Path != want {
			return a, fmt.Errorf("overlay Application %q source path = %q, want %q — it was not generated from this tier's overlay directory", name, a.Spec.Source.Path, want)
		}
		if strings.TrimSpace(a.Spec.Destination.Namespace) == "" {
			return a, fmt.Errorf("overlay Application %q has no destination namespace — the Kustomize overlay set none, so nothing can land", name)
		}
		return a, nil
	}
	return overlayAppState{}, fmt.Errorf("no ArgoCD Application named %q — the apps-overlays ApplicationSet did not generate one for overlays/%s (an ApplicationSet-generated app is invisible to DeriveExpectedArgoApps, so nothing else would have caught this)", name, tier)
}

// overlayConverged reports whether a generated overlay Application has reached Healthy+Synced —
// the same bar AssertArgoAppsHealthy applies to the derived infra apps.
func overlayConverged(a overlayAppState) bool {
	return a.Status.Health.Status == "Healthy" && a.Status.Sync.Status == "Synced"
}

// FabricDemoTier is the per-tier result recorded in the summary.
type FabricDemoTier struct {
	Tier          string `json:"tier"`
	Namespace     string `json:"namespace"`
	Placed        bool   `json:"placed"`
	OverlayApp    string `json:"overlay_app"`
	OverlayNS     string `json:"overlay_namespace"`
	Converged     bool   `json:"converged"`
	ResourceCount int    `json:"managed_resources"`
}

// FabricDemoSummary is the machine-readable result of the #845 acceptance gate, written to
// ALETHIA_E2E_FABRIC_DEMO_SUMMARY so the proof capture can fold one line into the per-provider step
// summary. It carries only names/booleans/counts and the Fabric's PUBLIC plan digest — no secrets.
type FabricDemoSummary struct {
	Enabled            bool             `json:"enabled"`
	Provider           string           `json:"provider"`
	Fabric             string           `json:"fabric_cluster"`
	Repo               string           `json:"apps_repo"`
	Tiers              []FabricDemoTier `json:"tiers"`
	VClusterPlaced     bool             `json:"vcluster_placed"`
	VClusterName       string           `json:"vcluster_name"`
	ArgoNotReinstalled bool             `json:"argocd_not_reinstalled"`
	// ReceiptScope names WHOSE receipt FabricPlanSHA is. It is always "fabric": a namespace
	// placement runs no tofu and therefore has no plan JSON to seal, so there is no per-placement
	// receipt to report and claiming one would be dishonest.
	ReceiptScope  string `json:"receipt_scope"`
	FabricPlanSHA string `json:"fabric_plan_sha256"`
	DriftChecked  bool   `json:"drift_checked"`
	DriftInSync   bool   `json:"drift_in_sync"`
	DriftDrifted  int    `json:"drift_drifted"`
	Verdict       string `json:"verdict"`
}

// fabricDemoVerdictPass reports whether every check that RAN passed non-vacuously. A scenario with
// zero tiers can never pass — that is the vacuity floor. The vcluster tier and the drift re-prove
// gate only when they ran.
func fabricDemoVerdictPass(s FabricDemoSummary) bool {
	if !s.Enabled || len(s.Tiers) == 0 {
		return false
	}
	for _, t := range s.Tiers {
		if !t.Placed || !t.Converged || t.ResourceCount == 0 {
			return false
		}
	}
	if !s.ArgoNotReinstalled {
		return false
	}
	if s.FabricPlanSHA == "" {
		return false
	}
	if s.DriftChecked && (!s.DriftInSync || s.DriftDrifted != 0) {
		return false
	}
	return true
}

// fabricDemoSummaryVerdict renders the one-line human verdict embedded in FabricDemoSummary.Verdict.
func fabricDemoSummaryVerdict(s FabricDemoSummary) string {
	if !s.Enabled {
		return "fabric-demo: skipped (" + envFabricDemo + " unset)"
	}
	icon := "✅"
	if !fabricDemoVerdictPass(s) {
		icon = "❌"
	}
	parts := make([]string, 0, len(s.Tiers))
	for _, t := range s.Tiers {
		parts = append(parts, fmt.Sprintf("%s→%s(res=%d,converged=%t)", t.Tier, t.OverlayNS, t.ResourceCount, t.Converged))
	}
	tiers := "none"
	if len(parts) > 0 {
		tiers = strings.Join(parts, " ")
	}
	vc := "vcluster: n/a"
	if s.VClusterPlaced {
		vc = "vcluster: " + s.VClusterName
	}
	drift := "drift: n/a"
	if s.DriftChecked {
		drift = fmt.Sprintf("drift: in_sync=%t drifted=%d", s.DriftInSync, s.DriftDrifted)
	}
	return fmt.Sprintf("%s fabric-demo on %s: overlays %s · %s · argocd-preserved=%t · receipt(%s)=%s · %s",
		icon, s.Fabric, tiers, vc, s.ArgoNotReinstalled, s.ReceiptScope, shortPlanSHA(s.FabricPlanSHA), drift)
}

// shortPlanSHA renders a plan digest for the one-line verdict without dumping 64 hex chars.
func shortPlanSHA(sha string) string {
	if len(sha) <= 12 {
		if sha == "" {
			return "absent"
		}
		return sha
	}
	return sha[:12] + "…"
}

// writeFabricDemoSummary persists the summary as indented JSON (no secrets — names, booleans,
// counts, and the Fabric's public plan digest).
func writeFabricDemoSummary(path string, s FabricDemoSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
