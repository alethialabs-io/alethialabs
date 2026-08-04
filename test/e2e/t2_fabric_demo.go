// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fabric enterprise-demo acceptance scenario (#845) — the PURE, reusable half. Deliberately
// UNTAGGED (like t2_soak.go / t2_day2_access.go / t2_namespace_tenant.go) so `go mod tidy` sees
// its deps and the derive / route / verdict logic is unit-tested WITHOUT Postgres, a cloud, or a
// build tag (t2_fabric_demo_pure_test.go).
//
// # What this proves — and what it deliberately does NOT
//
// The base T2 run provisions ONE real cluster — the Fabric — and verifies its signed receipt. This
// scenario layers the enterprise-demo shape onto that SAME Fabric: dev and staging as NAMESPACE
// placements plus one VCLUSTER placement, each syncing its own Kustomize overlay.
//
// A placement's delivery is rendered by argocd.RenderNamespaceTenant / RenderVClusterApp, which emit
// ONE Application per placement — `app-<project>-<namespace>`, pinned to the hardened per-namespace
// AppProject `tenant-<project>-<namespace>`. This scenario asserts THAT.
//
// It does NOT assert the `apps-overlays` ApplicationSet. An earlier draft did, and was wrong:
// argocd.RenderApplications is reached only from the DEDICATED path (provisioner/deploy.go), because
// deploy.go dispatches a namespace/vcluster placement into runNamespaceDeploy/runVClusterDeploy and
// returns before it. A placement therefore never generates `apps-<tier>` Applications, and the
// ApplicationSet's generated apps carry no destination namespace at all. The `DeriveExpectedArgoApps`
// blindness to ApplicationSet-generated apps is real, but it belongs to the A0.6 base leg where the
// dedicated deploy genuinely renders that ApplicationSet — not here.
//
// # How this assertion defends its own vacuity
//
//   - CAUSALITY. The base deploy already populated this Fabric with Applications, AppProjects and
//     Namespaces. Every artifact asserted below must be ABSENT BEFORE the placements and PRESENT
//     AFTER (assertCausedByPlacement). Without that, an object the base run created reads as a
//     placement's work and the whole gate is theatre. fabricDemoRepoPrecondition refuses the setup
//     that would make it ambiguous in the first place.
//   - THE OVERLAY IS THE CLAIM. Each placement's Application must sync `overlays/<tier>` from the
//     demo repo (assertTenantAppOverlay). A placement that synced the repo ROOT would converge
//     Healthy just the same and prove nothing about per-tier delivery — that is exactly what the
//     product did before repositories.apps_path was wired.
//   - The tier set is EXPLICIT and non-empty: fabricDemoTiers errors on an empty list rather than
//     looping zero times and reporting success. "Asserted nothing" must never render green.
//   - Each Application must MANAGE RESOURCES (its own `.status.resources`). An empty overlay
//     directory renders Healthy+Synced trivially — the resource count is the honest "GitOps really
//     delivered a workload" floor, the same bar A0.6 applies to the BYO chart.
//   - The placements must land on the EXISTING Fabric (namespaceClusterUnchanged) and must not
//     reinstall its ArgoCD (argocdNotReinstalled) — a scenario that quietly built a second cluster
//     would otherwise "pass".
//   - The PROOF surface is recorded HONESTLY, not fabricated. A namespace placement runs NO tofu
//     (runNamespaceDeploy mints keyless access to an existing cluster), so it has no plan JSON and
//     therefore CANNOT carry a verify receipt. The receipt this scenario reports is the FABRIC's —
//     already verified by the base run — and the summary says so in as many words via receipt_scope.
//   - Every wait is BOUNDED (ALETHIA_E2E_FABRIC_DEMO_TIMEOUT) so a never-converging overlay fails
//     loudly instead of hanging until the job cap kills the leg.
//
// # The namespace is load-bearing, not cosmetic
//
// RenderNamespaceTenant pins the tenant AppProject to `destinations: [{server: in-cluster, namespace:
// <ns>}]`. The enterprise-demo overlays stamp their own namespaces (overlays/dev → boutique-dev,
// overlays/staging → boutique-staging, per the product's own template comment in
// infra/templates/argocd/user-apps-overlays.yaml). An overlay whose manifests carry a DIFFERENT
// namespace than the placement is refused by ArgoCD ("destination is not permitted in project") and
// can never converge. So a tier is a `tier=namespace` PAIR, and the default tracks the demo layout.
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
	envFabricDemoVCluster = "ALETHIA_E2E_FABRIC_DEMO_VCLUSTER"
	envFabricDemoTimeout  = "ALETHIA_E2E_FABRIC_DEMO_TIMEOUT"
	envFabricDemoSummary  = "ALETHIA_E2E_FABRIC_DEMO_SUMMARY"
)

// fabricDemoDefaultRepo is the PUBLIC enterprise-demo repo. Public matters: ArgoCD clones it
// anonymously (argocd.IsRepoAnonymouslyCloneable), so unlike the A0.6 apps-repo path this scenario
// needs NO git token — one less maintainer-held secret between the board and a real proof.
const fabricDemoDefaultRepo = "https://github.com/alethialabs-io/enterprise-demo"

// fabricDemoDefaultOverlays tracks the enterprise-demo layout — the dev+staging pair #845 asks for,
// each mapped to the namespace ITS OVERLAY DECLARES (see the package comment: a mismatch is refused
// by the tenant AppProject and can never converge). Overridable per-provider so a cloud-specific
// fork can carry a different set.
const fabricDemoDefaultOverlays = "dev=boutique-dev,staging=boutique-staging"

// fabricDemoDefaultVClusterTier names which tier is ALSO placed as a vcluster. #845 requires at least
// one vcluster placement — it is the isolation rung neither Porter nor Qovery offers, so it is the
// headline of this gate, not an optional extra.
const fabricDemoDefaultVClusterTier = "staging"

// fabricDemoPollInterval is how often a convergence poll re-reads. A Kustomize render plus an ArgoCD
// sync is tens of seconds, so a short poll is not wasted.
const fabricDemoPollInterval = 15 * time.Second

// fabricDemoOverlayTier is one placed tier: the overlay directory to sync AND the namespace that
// overlay's kustomization stamps on every resource.
type fabricDemoOverlayTier struct {
	Tier      string // "dev"          → source path overlays/dev
	Namespace string // "boutique-dev" → what the overlay declares, and where the placement must land
}

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
	// baseAppsRepo is the apps repo the BASE (dedicated) deploy used. If it were the demo repo, the
	// base run's apps-overlays ApplicationSet would already be delivering these very overlays — see
	// fabricDemoRepoPrecondition.
	baseAppsRepo string
}

// fabricDemoEnabled reports whether the opt-in scenario should run. Off by default: the base T2
// proof is unchanged unless a maintainer opts in.
func fabricDemoEnabled() bool { return t2Truthy(os.Getenv(envFabricDemo)) }

// fabricDemoRepo resolves the apps-destination repo for this cloud, per-provider-overridable via
// the shared <BASE>_<PROVIDER> idiom, defaulting to the public enterprise-demo.
func fabricDemoRepo(provider string) string {
	return t2ArgoEnvForProvider(envFabricDemoRepo, provider, fabricDemoDefaultRepo)
}

// fabricDemoTimeout bounds the convergence + drift waits — ALETHIA_E2E_FABRIC_DEMO_TIMEOUT when set
// (a Go duration), else 10m. Each wait returns the moment it succeeds, so the default only costs
// time on a genuinely stuck overlay.
func fabricDemoTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv(envFabricDemoTimeout)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 10 * time.Minute
}

// fabricDemoOverlayPath is the single definition of a tier's source path, used by BOTH the snapshot
// that requests it and the assertion that checks it. One definition, so the request and the check
// can never drift into agreeing about the wrong thing.
func fabricDemoOverlayPath(tier string) string {
	return "overlays/" + strings.ToLower(strings.TrimSpace(tier))
}

// fabricDemoStage maps a tier name onto a real environment_stage enum value
// (development|staging|production). The runner treats environment_stage as a label/tag value rather
// than validating it, so an unmapped tier is not fatal — but these snapshots are the shape a
// customer's console would really emit, and a demo that ships an impossible enum value is not a demo.
// An unrecognised tier falls back to development, the most conservative drift cadence.
func fabricDemoStage(tier string) string {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "staging", "stage":
		return "staging"
	case "prod", "production":
		return "production"
	default:
		return "development"
	}
}

var fabricDemoSlugUnsafe = regexp.MustCompile(`[^a-z0-9-]+`)

// fabricDemoSlug derives an RFC-1123 namespace for a tier that did not declare one. Distinct prefix
// from #959's `e2e-ns-` and #1308's `e2e-vc-` so the placement scenarios never collide inside one
// run. Bounded to 63 chars (the k8s namespace limit). Correct ONLY for a namespace-agnostic apps
// repo — the enterprise-demo is not one, which is why the default config declares its namespaces.
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

// isRFC1123Label reports whether s is a valid k8s namespace name.
func isRFC1123Label(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i != 0 && i != len(s)-1:
		default:
			return false
		}
	}
	return true
}

// fabricDemoTiers resolves the tiers this run REQUIRES to have converged, parsing `tier[=namespace]`
// pairs. Fail-closed on an empty result (a gate that iterates zero tiers reports success having
// asserted nothing), on a duplicate tier, on a duplicate namespace (two placements would fight over
// one namespace), and on a namespace that is not a valid RFC-1123 label.
func fabricDemoTiers(env, provider string) ([]fabricDemoOverlayTier, error) {
	raw := t2ArgoEnvForProvider(envFabricDemoOverlays, provider, fabricDemoDefaultOverlays)
	var tiers []fabricDemoOverlayTier
	seenTier, seenNS := map[string]bool{}, map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		tier, ns, hasNS := strings.Cut(part, "=")
		tier = strings.ToLower(strings.TrimSpace(tier))
		ns = strings.ToLower(strings.TrimSpace(ns))
		if tier == "" {
			return nil, fmt.Errorf("%s entry %q has an empty tier name", envFabricDemoOverlays, part)
		}
		if !hasNS || ns == "" {
			// No declared namespace: only correct for a namespace-agnostic apps repo.
			ns = fabricDemoSlug(env, tier)
		}
		if !isRFC1123Label(ns) {
			return nil, fmt.Errorf("%s entry %q resolves to namespace %q, which is not a valid RFC-1123 label", envFabricDemoOverlays, part, ns)
		}
		if seenTier[tier] {
			return nil, fmt.Errorf("%s lists tier %q twice", envFabricDemoOverlays, tier)
		}
		if seenNS[ns] {
			return nil, fmt.Errorf("%s maps two tiers onto namespace %q — the placements would fight over one namespace", envFabricDemoOverlays, ns)
		}
		seenTier[tier], seenNS[ns] = true, true
		tiers = append(tiers, fabricDemoOverlayTier{Tier: tier, Namespace: ns})
	}
	if len(tiers) == 0 {
		return nil, fmt.Errorf("%s resolved to %q — no overlay tiers to assert; the scenario would pass having proven nothing", envFabricDemoOverlays, raw)
	}
	return tiers, nil
}

// fabricDemoVClusterTier picks WHICH tier is also placed as a vcluster. #845 requires at least one
// vcluster placement, so an empty value is a HARD error rather than a quiet downgrade to
// namespace-only — a gate that silently drops its headline differentiator is worse than a red one.
func fabricDemoVClusterTier(provider string, tiers []fabricDemoOverlayTier) (fabricDemoOverlayTier, error) {
	want := strings.ToLower(strings.TrimSpace(t2ArgoEnvForProvider(envFabricDemoVCluster, provider, fabricDemoDefaultVClusterTier)))
	if want == "" {
		return fabricDemoOverlayTier{}, fmt.Errorf("%s is empty — #845 requires at least one vcluster placement, so this must name one of the configured tiers", envFabricDemoVCluster)
	}
	names := make([]string, 0, len(tiers))
	for _, t := range tiers {
		names = append(names, t.Tier)
		if t.Tier == want {
			return t, nil
		}
	}
	return fabricDemoOverlayTier{}, fmt.Errorf("%s = %q, which is not one of the configured tiers %v", envFabricDemoVCluster, want, names)
}

// fabricDemoVClusterSlug names this scenario's vcluster. Disjoint from #1308's `e2e-vc-` so both can
// live inside one Fabric lifetime. Bounded to 54 chars so the host namespace `vcluster-<name>` still
// fits the 63-char limit.
func fabricDemoVClusterSlug(env string) string {
	clean := strings.Trim(fabricDemoSlugUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(env)), "-"), "-")
	if clean == "" {
		clean = "env"
	}
	name := "e2e-vcdemo-" + clean
	if len(name) > 54 {
		name = strings.TrimRight(name[:54], "-")
	}
	return name
}

// sameRepoURL compares two git URLs modulo case, a trailing slash and a `.git` suffix — the three
// ways the same repo is spelled across a config, a snapshot and ArgoCD's own echo of it.
func sameRepoURL(a, b string) bool {
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		s = strings.TrimSuffix(s, "/")
		s = strings.TrimSuffix(s, ".git")
		return strings.TrimSuffix(s, "/")
	}
	return norm(a) != "" && norm(a) == norm(b)
}

// fabricDemoRepoPrecondition refuses a configuration where the BASE deploy's apps repo is the same
// repo whose overlays this gate places. The base ran the DEDICATED path, so its apps-overlays
// ApplicationSet would already have generated Applications for these very overlays — with
// CreateNamespace=true, so the tier namespaces would already exist, the causality guard would fire
// mid-run, and two Applications would fight over one namespace. Fail LOUD here, before any job is
// seeded and any cloud spend happens.
func fabricDemoRepoPrecondition(baseAppsRepo, demoRepo string) error {
	if strings.TrimSpace(baseAppsRepo) == "" {
		return nil
	}
	if sameRepoURL(baseAppsRepo, demoRepo) {
		return fmt.Errorf("the base leg's apps repo (%s) is the same repo this gate places overlays from — the base dedicated deploy's apps-overlays ApplicationSet already delivers them, so the placements would prove nothing and would collide. Point %s (or the base %s) at a different repo",
			baseAppsRepo, envFabricDemoRepo, envArgoAppsRepo)
	}
	return nil
}

// kubeIdent is a live object's identity as `kubectl get <kind> -o json` reports it.
type kubeIdent struct {
	UID     string `json:"uid"`
	Created string `json:"creationTimestamp"`
}

// parseKubeIdents parses ANY kubectl list into name → identity, so one causality guard covers
// Applications, AppProjects and Namespaces alike.
func parseKubeIdents(listJSON []byte) (map[string]kubeIdent, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name              string `json:"name"`
				UID               string `json:"uid"`
				CreationTimestamp string `json:"creationTimestamp"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return nil, fmt.Errorf("decode object list: %w", err)
	}
	out := make(map[string]kubeIdent, len(list.Items))
	for _, it := range list.Items {
		out[it.Metadata.Name] = kubeIdent{UID: it.Metadata.UID, Created: it.Metadata.CreationTimestamp}
	}
	return out, nil
}

// assertCausedByPlacement is THE guard this scenario was missing.
//
// The base deploy already put Applications, AppProjects and Namespaces on this Fabric. An assertion
// that merely finds an object cannot tell "the placement created this" from "the base run did, and
// the placement did nothing" — and the second reads green. So the artifact must be ABSENT BEFORE the
// placement and PRESENT AFTER it. Nothing weaker is evidence.
func assertCausedByPlacement(kind, name string, before, after map[string]kubeIdent) error {
	if b, ok := before[name]; ok {
		return fmt.Errorf("%s %q already existed BEFORE the placements (uid=%s created=%s) — it is the base deploy's artifact, so asserting on it proves nothing about the placement", kind, name, b.UID, b.Created)
	}
	a, ok := after[name]
	if !ok || strings.TrimSpace(a.UID) == "" {
		return fmt.Errorf("%s %q does not exist after the placement — the placement created nothing to assert on", kind, name)
	}
	return nil
}

// assertTenantAppOverlay fails unless the placed tenant Application syncs THIS tier's overlay from
// THIS repo. Without it the gate accepts an Application syncing the repo ROOT — which is what the
// product did before repositories.apps_path was wired, converges Healthy just the same, and would
// let "the dev overlay converged" mean "the whole repo converged, twice".
func assertTenantAppOverlay(a namespaceAppState, repo, tier string) error {
	if !sameRepoURL(a.Spec.Source.RepoURL, repo) {
		return fmt.Errorf("Application %q syncs repo %q, want %q", a.Metadata.Name, a.Spec.Source.RepoURL, repo)
	}
	want := fabricDemoOverlayPath(tier)
	got := strings.TrimSpace(a.Spec.Source.Path)
	if got == "." || got == "" {
		return fmt.Errorf("Application %q syncs the repository ROOT (path %q), not this tier's overlay %q — repositories.apps_path did not reach the runner, so the per-tier Kustomize claim is vacuous", a.Metadata.Name, got, want)
	}
	if got != want {
		return fmt.Errorf("Application %q source path = %q, want %q", a.Metadata.Name, got, want)
	}
	return nil
}

// buildFabricDemoSnapshot returns the runner-facing config_snapshot for one tier's namespace
// placement onto the existing Fabric. It carries NO cluster shape (no tofu runs) — only the
// placement, the destination namespace, the EXISTING cluster to mint against, and the apps repo
// plus the per-tier overlay subpath.
func buildFabricDemoSnapshot(p fabricDemoParams, t fabricDemoOverlayTier, repo string) map[string]any {
	return map[string]any{
		"id":                "e2e-" + p.env + "-demo-" + t.Tier,
		"project_name":      p.project,
		"environment_stage": fabricDemoStage(t.Tier),
		"region":            p.region,
		"provider":          p.provider,
		"placement_mode":    "namespace",
		"namespace":         t.Namespace,
		"cluster":           map[string]any{"cluster_name": p.fabricClust},
		// apps_path is what makes this a KUSTOMIZE-OVERLAY proof rather than a repo-root sync.
		"repositories": map[string]any{
			"apps_destination_repo": repo,
			"apps_path":             fabricDemoOverlayPath(t.Tier),
		},
	}
}

// FabricDemoTier is the per-tier result recorded in the summary. Every assertion the run makes has a
// field here, so the verdict can never pass on something the run did not actually do.
type FabricDemoTier struct {
	Tier              string `json:"tier"`
	Namespace         string `json:"namespace"`
	Placed            bool   `json:"placed"`
	TenantApp         string `json:"tenant_app"`        // app-<project>-<ns>
	TenantProject     string `json:"tenant_appproject"` // tenant-<project>-<ns>
	SourcePath        string `json:"source_path"`       // overlays/<tier>
	CausedByPlacement bool   `json:"caused_by_placement"`
	Converged         bool   `json:"converged"`
	ResourceCount     int    `json:"managed_resources"`
}

// FabricDemoVCluster is the vcluster tier's result — #845's headline differentiator.
type FabricDemoVCluster struct {
	Name              string `json:"name"`
	Tier              string `json:"tier"`
	Placed            bool   `json:"placed"`
	App               string `json:"app"`
	SourcePath        string `json:"source_path"`
	CausedByPlacement bool   `json:"caused_by_placement"`
	ResourceCount     int    `json:"managed_resources"`
	Deregistered      bool   `json:"deregistered"`
}

// FabricDemoSummary is the machine-readable result of the #845 acceptance gate, written to
// ALETHIA_E2E_FABRIC_DEMO_SUMMARY so the proof capture can fold one line into the per-provider step
// summary. It carries only names/booleans/counts and the Fabric's PUBLIC plan digest — no secrets.
type FabricDemoSummary struct {
	Enabled  bool               `json:"enabled"`
	Provider string             `json:"provider"`
	Fabric   string             `json:"fabric_cluster"`
	Repo     string             `json:"apps_repo"`
	Tiers    []FabricDemoTier   `json:"tiers"`
	VCluster FabricDemoVCluster `json:"vcluster"`
	// BaseAppsRepo and PreExistingApps record what the placements were measured AGAINST, so a reader
	// can see the causality baseline rather than take it on trust.
	BaseAppsRepo       string `json:"base_apps_repo"`
	PreExistingApps    int    `json:"pre_existing_applications"`
	ArgoNotReinstalled bool   `json:"argocd_not_reinstalled"`
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
// zero tiers, or one whose artifacts pre-existed the placements, or one that synced the repo root,
// or one without a vcluster tier, can never pass.
func fabricDemoVerdictPass(s FabricDemoSummary) bool {
	if !s.Enabled || len(s.Tiers) == 0 {
		return false
	}
	for _, t := range s.Tiers {
		if !t.Placed || !t.CausedByPlacement || !t.Converged || t.ResourceCount == 0 {
			return false
		}
		// A root sync is not an overlay proof.
		if t.SourcePath != fabricDemoOverlayPath(t.Tier) {
			return false
		}
	}
	// #845 requires at least ONE vcluster placement. A run without a caused, delivering, cleanly
	// deregistered vcluster tier is not this gate and must not read green.
	v := s.VCluster
	if !v.Placed || !v.CausedByPlacement || v.ResourceCount == 0 || !v.Deregistered {
		return false
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
		parts = append(parts, fmt.Sprintf("%s→%s(%s,res=%d,converged=%t)", t.Tier, t.Namespace, t.SourcePath, t.ResourceCount, t.Converged))
	}
	tiers := "none"
	if len(parts) > 0 {
		tiers = strings.Join(parts, " ")
	}
	vc := "vcluster: n/a"
	if s.VCluster.Placed {
		vc = fmt.Sprintf("vcluster: %s(%s,res=%d,deregistered=%t)", s.VCluster.Name, s.VCluster.SourcePath, s.VCluster.ResourceCount, s.VCluster.Deregistered)
	}
	drift := "drift: n/a"
	if s.DriftChecked {
		drift = fmt.Sprintf("drift: in_sync=%t drifted=%d", s.DriftInSync, s.DriftDrifted)
	}
	return fmt.Sprintf("%s fabric-demo on %s: placements %s · %s · argocd-preserved=%t · receipt(%s)=%s · %s",
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
