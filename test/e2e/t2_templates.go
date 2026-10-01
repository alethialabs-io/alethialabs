// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The STARTER-TEMPLATES proof (#4113) — the PURE half. Deliberately UNTAGGED, like t2_budget.go and
// t2_argo_repos.go, so every decision below is unit-tested without a cluster, a cloud or a build tag.
// The cloud half is t2_templates_run_test.go (e2e_t2).
//
// # What it proves
//
// Each of the three PUBLIC starter templates deploys once, on hetzner, through the path
// apps/docs/content/docs/guides/design-project/starter-templates.mdx tells a user to follow:
//
//   - alethia-starter-ai    — the environment's ArgoCD apps repository, overlay path EMPTY, on a
//     project carrying the AI Workloads template's webhook-CA marker (`webhook_ca_consumers:
//     ["kserve"]`, #4990/#5002 — what the console's AI template sets, so cert-manager installs
//     issuer-free); PLUS its `chart/` as a bring-your-own chart at ref HEAD.
//   - alethia-starter-chart — a bring-your-own chart: repository, path `chart`, ref `HEAD`.
//   - alethia-starter-apps  — the environment's ArgoCD apps repository, overlay path EMPTY.
//
// # Why TWO deploys on ONE cluster
//
// An environment has exactly ONE apps-destination slot (repositories.apps_destination_repo), and
// two of the three templates are apps repositories. Both BYO charts can ride the first deploy, but
// the two apps repos cannot. The alternatives were worse:
//
//   - a second CLUSTER doubles the spend the issue asks to minimise;
//   - a namespace or vcluster PLACEMENT on the same cluster is not the path the page describes, and
//     cannot prove alethia-starter-apps anyway: its root ships a cluster-scoped Namespace, which the
//     placement's AppProject refuses, and the `apps-overlays` ApplicationSet that turns
//     `overlays/dev` into `apps-dev` renders on the DEDICATED path only
//     (infra/templates/argocd/user-apps-overlays.yaml).
//
// So phase A deploys the AI project (starter-ai apps repo + both BYO charts), and phase B REDEPLOYS
// the same environment with the apps repository changed to alethia-starter-apps — which is exactly
// what a user does when they re-point an environment at a different repository. Phase B's tofu
// state is the phase-A job's (ControlPlane.AliasStateToJob), so the redeploy converges the SAME
// cluster; that it built no new one is asserted, not assumed.
//
// # What "proven" means per Application
//
// Present, Healthy AND Synced; at least one managed resource (except where the template itself
// ships nothing — starter-apps' `addons/` holds only a README, which the template states is the
// point); and, for every Application sourced from a template repository, a sync REVISION equal to
// that template's commit, resolved with `git ls-remote <repo> HEAD` before any spend. The OCI charts
// the AI template's `addons/` pulls (KServe, Kueue) are pinned by the template commit to a chart
// version; that pin is read from the template at the resolved commit and resolved to its manifest
// digest, also before any spend, and the synced revision must be the pinned tag or that digest —
// ArgoCD 3.x reports the digest for a native OCI source (t2_templates_oci.go says where).
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	// envTemplates is the dimension's switch. Set ONLY by scripts/e2e/resolve-dimension.sh's
	// `templates` fidelity, never by a repo variable.
	envTemplates = "ALETHIA_E2E_TEMPLATES"
	// envTemplatesSummary is where the verdict is written AT ASSERT TIME, after each phase. The
	// capture runs after t.Cleanup has destroyed the cluster (#2688), so a verdict not written here
	// does not exist.
	envTemplatesSummary = "ALETHIA_E2E_TEMPLATES_SUMMARY"

	// templatesProvider is the one cloud this dimension runs on. The resolver's
	// dimension_providers says the same thing; TestTemplatesProviderMatchesTheResolver holds the
	// two together.
	templatesProvider = "hetzner"

	// templatesRef is the ref the tutorial tells a user to enter for a BYO chart, and the ref every
	// Alethia-rendered apps Application tracks (`targetRevision: HEAD`).
	templatesRef = "HEAD"

	// templatesChartPath is the tutorial's "Chart path" for both charts.
	templatesChartPath = "chart"

	// templatesWebhookCAConsumer is the AI Workloads template's marker (console:
	// lib/addons/webhook-ca-consumers.ts → projects.webhook_ca_consumers).
	templatesWebhookCAConsumer = "kserve"
)

// The three public starter repositories. HARDCODED, not read from repo variables: a variable could
// point this proof at a fork and still record it as the template's. They are the URLs the docs page
// and the console's template picker (apps/console/components/create-project/templates.ts) both name.
const (
	starterAppsRepo  = "https://github.com/alethialabs-io/alethia-starter-apps"
	starterChartRepo = "https://github.com/alethialabs-io/alethia-starter-chart"
	starterAIRepo    = "https://github.com/alethialabs-io/alethia-starter-ai"
)

// starterTemplate is one template: the key its proof is filed under (demos/proofs/templates/<key>/),
// and the repository it is.
type starterTemplate struct {
	Key  string
	Repo string
}

// starterTemplates is the ordered set. Order is the order of the summary and of the per-template
// proof directories commit-proof.sh writes.
var starterTemplates = []starterTemplate{
	{Key: "apps", Repo: starterAppsRepo},
	{Key: "chart", Repo: starterChartRepo},
	{Key: "ai", Repo: starterAIRepo},
}

// The BYO add-on ids and the namespaces they install into. The id is the console's chart-node slug
// (app/server/actions/byo-charts.ts), and its Application is argocd.AddOnAppName(id).
const (
	starterChartAddonID = "starter-chart"
	starterAIAddonID    = "starter-ai"
)

// Phase budgets. Each is a real, bounded wait, reserved in ResolveT2Budget as the `templates` term.
const (
	// templatesAIConverge WIDENS the base ArgoCD assertion on this dimension. The derived expected
	// set now includes addon-starter-ai, whose first start pulls four images (open-webui alone is
	// ~1.5 GB) and downloads two models (~950 MB, the template's README), so the lean 12m30s window
	// is sized for the wrong surface.
	templatesAIConverge = 20 * time.Minute
	// templatesPhaseAApps bounds the explicit phase-A poll: KServe, Kueue and the `addons` app-of-apps
	// are NOT in the derived expected set (they are children of a customer repo), so they get their
	// own window after the base assertion.
	templatesPhaseAApps = 10 * time.Minute
	// templatesRedeployWait bounds phase B's DEPLOY: a no-op plan over the existing cluster, then the
	// ArgoCD render. Far below the hetzner cold-deploy wait, because nothing is created.
	templatesRedeployWait = 25 * time.Minute
	// templatesPhaseBConverge bounds phase B's poll: the root re-points, the ApplicationSet renders
	// two overlays, and the AI template's add-ons are pruned.
	templatesPhaseBConverge = 10 * time.Minute
)

// templatesBudget is the dimension's whole ladder term.
func templatesBudget() time.Duration {
	return templatesAIConverge + templatesPhaseAApps + templatesRedeployWait + templatesPhaseBConverge
}

// templatesEnabled is the budget-side predicate: the switch alone, never the provider, so an
// over-allocation on a refused cloud is harmless and an under-allocation is impossible.
func templatesEnabled() bool { return t2Truthy(t2Env(envTemplates, "")) }

// templatesConfig is the resolved scenario for one leg.
type templatesConfig struct {
	provider string
	enabled  bool
	// heavy is true when a heavy fidelity switch is also on — a combination this dimension refuses.
	heavy bool
}

// templatesFromEnv reads the scenario for `provider`.
func templatesFromEnv(provider string) templatesConfig {
	return templatesConfig{
		provider: strings.TrimSpace(provider),
		enabled:  templatesEnabled(),
		heavy:    MaxConfigEnabled() || AllAddOnsEnabled(),
	}
}

// decide resolves whether the scenario runs. Off is a clean no-op; on anywhere but hetzner, or on
// top of the heavy surface, is a LOUD error — both would spend on a run this dimension cannot vouch
// for, and both are refused before any spend.
func (c templatesConfig) decide() (bool, error) {
	if !c.enabled {
		return false, nil
	}
	if c.provider != templatesProvider {
		return false, fmt.Errorf("the starter-templates proof (#4113) runs on %s only, not %q — it is proven ONCE, as cheaply as possible, and the tutorial it follows does not change per cloud (scripts/e2e/resolve-dimension.sh --providers templates)", templatesProvider, c.provider)
	}
	if c.heavy {
		return false, errors.New("the starter-templates proof (#4113) refuses to run beside MAX_CONFIG or ALL_ADDONS: its node shape (cluster_json.templates.hetzner.json) is sized for the templates, and the apps-destination slot it owns is the one the heavy surface's A0.6 repos also want")
	}
	return true, nil
}

// templatesByoAddon is the tutorial's bring-your-own chart: repository, path `chart`, ref `HEAD`.
// Managed + git-sourced, exactly the shape the console's BYO chart dialog persists, and auto-syncing
// (the product's own default since #2910) — nothing in this harness syncs it.
func templatesByoAddon(id, repo string) types.AddOnInstall {
	return types.AddOnInstall{
		ID:        id,
		Mode:      "managed",
		Source:    "git",
		ChartRepo: repo,
		Path:      templatesChartPath,
		Version:   templatesRef,
		// Its own namespace per chart, the dialog's namespace field filled in rather than left at
		// `default`: the two charts then cannot be confused for one another in a failure dump.
		Namespace: id,
		Values:    map[string]interface{}{},
		SyncWave:  2,
	}
}

// applyToSnapshot is PHASE A: the AI Workloads project with starter-ai as its apps repository, the
// AI template's webhook-CA marker, and BOTH templates' charts as bring-your-own charts. No git token
// is written (the templates are public and cloned anonymously; the workflow serves none on this
// dimension). Existing add-ons are preserved — the seeded reloader stays, as on every run.
func (c templatesConfig) applyToSnapshot(snap map[string]any) error {
	repos, _ := snap["repositories"].(map[string]any)
	if repos == nil {
		repos = map[string]any{}
	}
	repos["apps_destination_repo"] = starterAIRepo
	// Overlay path EMPTY, as the page says. Deleted rather than blanked so a stray value from an
	// earlier layer cannot turn overlay discovery off.
	delete(repos, "apps_path")
	snap["repositories"] = repos

	existing, err := snapshotList(snap, "addons")
	if err != nil {
		return err
	}
	for _, a := range existing {
		// Read the id through JSON: an entry is a map after a05NormalizeSnapshot and a typed
		// AddOnInstall when a layer appended it, and both must be seen.
		var probe struct {
			ID string `json:"id"`
		}
		if b, merr := json.Marshal(a); merr == nil && json.Unmarshal(b, &probe) == nil {
			if probe.ID == starterChartAddonID || probe.ID == starterAIAddonID {
				return fmt.Errorf("snapshot already carries add-on %q — the templates layer would install it twice", probe.ID)
			}
		}
	}
	snap["addons"] = append(existing,
		templatesByoAddon(starterChartAddonID, starterChartRepo),
		templatesByoAddon(starterAIAddonID, starterAIRepo),
	)

	consumers := []string{templatesWebhookCAConsumer}
	if prior, err := snapshotList(snap, "webhook_ca_consumers"); err == nil {
		for _, p := range prior {
			if s, ok := p.(string); ok && s != templatesWebhookCAConsumer {
				consumers = append(consumers, s)
			}
		}
	}
	snap["webhook_ca_consumers"] = consumers
	return nil
}

// templatesPhaseBSnapshot is PHASE B: the SAME environment, the apps repository re-pointed at
// alethia-starter-apps. Everything else — the charts, the marker, the cluster block — is carried
// over unchanged, because a user changing one field changes one field. A deep copy: phase A's
// snapshot is never mutated.
func templatesPhaseBSnapshot(phaseA map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(phaseA)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	repos, _ := out["repositories"].(map[string]any)
	if repos == nil || repos["apps_destination_repo"] != starterAIRepo {
		return nil, fmt.Errorf("phase A's snapshot does not point the apps repository at %s (got %v) — phase B would not be the re-point it claims to be", starterAIRepo, out["repositories"])
	}
	repos["apps_destination_repo"] = starterAppsRepo
	return out, nil
}

// ── The expected Applications ──────────────────────────────────────────────────────────────────

// Source kinds of an expected Application — what its sync revision is compared against.
const (
	// templateSourceGit: synced from a template repository; revision must be that template's commit.
	templateSourceGit = "git"
	// templateSourceOCI: an upstream chart the template's `addons/` pins; revision must be the
	// version that commit pins, or its manifest digest — both read from the TEMPLATE and the
	// REGISTRY before any spend (resolveTemplateChartPins), never from the Application.
	templateSourceOCI = "oci"
	// templateSourcePlatform: rendered by Alethia because of the template (cert-manager, via the
	// webhook-CA marker); health only — its revision is the platform's, not the template's.
	templateSourcePlatform = "platform"
)

// templateAppExpect is one Application the tutorial promises.
type templateAppExpect struct {
	Template     string
	Application  string
	Source       string
	Repo         string
	MinResources int
	// PinFile is, for an OCI Application, the file in Repo that pins its chart.
	PinFile string
	// Why says, in the summary, where this Application comes from — a reader of the proof must not
	// have to reconstruct the tutorial to know why it was asserted.
	Why string
}

// templatesPhaseAExpect is what the starter-ai + starter-chart deploy promises.
func templatesPhaseAExpect() []templateAppExpect {
	return []templateAppExpect{
		{Template: "ai", Application: "apps", Source: templateSourceGit, Repo: starterAIRepo, MinResources: 1,
			Why: "the root Application syncing the template's kustomization.yaml (the ai-platform namespace + template-info)"},
		{Template: "ai", Application: "addons", Source: templateSourceGit, Repo: starterAIRepo, MinResources: 1,
			Why: "the app-of-apps over addons/, which creates kserve-crd, kserve and kueue"},
		{Template: "ai", Application: "kserve-crd", Source: templateSourceOCI, Repo: starterAIRepo, PinFile: "addons/kserve-crd.yaml", MinResources: 1,
			Why: "addons/kserve-crd.yaml — KServe's CRDs, sync wave -1"},
		{Template: "ai", Application: "kserve", Source: templateSourceOCI, Repo: starterAIRepo, PinFile: "addons/kserve.yaml", MinResources: 1,
			Why: "addons/kserve.yaml — the KServe controller in RawDeployment mode; needs cert-manager"},
		{Template: "ai", Application: "kueue", Source: templateSourceOCI, Repo: starterAIRepo, PinFile: "addons/kueue.yaml", MinResources: 1,
			Why: "addons/kueue.yaml — Kueue"},
		{Template: "ai", Application: "cert-manager", Source: templateSourcePlatform, MinResources: 1,
			Why: "installed issuer-free by the platform BECAUSE the AI Workloads template marks KServe as a webhook-CA consumer (#4990) — KServe does not start without it"},
		{Template: "ai", Application: argocd.AddOnAppName(starterAIAddonID), Source: templateSourceGit, Repo: starterAIRepo, MinResources: 1,
			Why: "chart/ as a bring-your-own chart: Qdrant, TEI embeddings, llama.cpp gemma-3-1b, open-webui"},
		{Template: "chart", Application: argocd.AddOnAppName(starterChartAddonID), Source: templateSourceGit, Repo: starterChartRepo, MinResources: 1,
			Why: "chart/ as a bring-your-own chart: a Deployment, a Service and a ConfigMap"},
	}
}

// templatesPhaseBExpect is what the starter-apps redeploy promises: "three Applications converge:
// the root, apps-dev and apps-staging", plus the `addons` Application the page says the template's
// addons/ directory exists to keep out of ComparisonError.
func templatesPhaseBExpect() []templateAppExpect {
	return []templateAppExpect{
		{Template: "apps", Application: "apps", Source: templateSourceGit, Repo: starterAppsRepo, MinResources: 1,
			Why: "the root Application: kustomization.yaml → the starter namespace + base/"},
		{Template: "apps", Application: "apps-dev", Source: templateSourceGit, Repo: starterAppsRepo, MinResources: 1,
			Why: "overlays/dev, discovered by the apps-overlays ApplicationSet because the overlay path is empty"},
		{Template: "apps", Application: "apps-staging", Source: templateSourceGit, Repo: starterAppsRepo, MinResources: 1,
			Why: "overlays/staging, discovered the same way"},
		// ZERO resources is the template's own contract here, not a gap: addons/ holds only a
		// README so the Application syncs cleanly instead of sitting in ComparisonError.
		{Template: "apps", Application: "addons", Source: templateSourceGit, Repo: starterAppsRepo, MinResources: 0,
			Why: "addons/ holds only a README — it exists so the rendered `addons` Application is Synced rather than in ComparisonError"},
	}
}

// ── Observation ────────────────────────────────────────────────────────────────────────────────

// templateAppObserved is what one Application reports, read over its CR.
type templateAppObserved struct {
	Health         string
	Sync           string
	Revision       string
	RepoURL        string
	Chart          string
	TargetRevision string
	Resources      int
	// The cause half (#5210). Health and sync say THAT an Application is not converged; these say
	// WHY, in ArgoCD's own words. Phase B's first red read `addons: Healthy, OutOfSync, 3 resources`
	// and nothing else, which fits a failed prune, a slow cascade deletion and a refused auto-sync
	// equally — the run had the answer in `.status` and threw it away.
	//
	// OperationPhase/Message/Revision are the LAST sync operation. Its revision is carried because
	// an operation that Succeeded at the PREVIOUS commit reads as healthy unless you can see it is
	// stale — exactly the shape of an auto-sync that refused to start.
	OperationPhase    string
	OperationMessage  string
	OperationRevision string
	// Conditions are `.status.conditions` as `Type: message` (SyncError, ComparisonError, …).
	Conditions []string
	// NotSyncedResources names every managed resource whose own sync status is not Synced, as
	// `group/Kind namespace/name Status`, with `(requires pruning)` when ArgoCD marks it for
	// deletion. Sorted.
	NotSyncedResources []string
}

// parseTemplateApps reads `kubectl get applications -n argocd -o json` into the fields the
// templates assertion judges. Single-source Applications only — every Application the templates
// render has one source, and a multi-source one would carry no `.spec.source`, which then fails the
// repo check loudly rather than passing on an empty string.
func parseTemplateApps(raw []byte) (map[string]templateAppObserved, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Source struct {
					RepoURL        string `json:"repoURL"`
					Chart          string `json:"chart"`
					TargetRevision string `json:"targetRevision"`
				} `json:"source"`
			} `json:"spec"`
			Status struct {
				Health struct {
					Status string `json:"status"`
				} `json:"health"`
				Sync struct {
					Status   string `json:"status"`
					Revision string `json:"revision"`
				} `json:"sync"`
				OperationState *struct {
					Phase      string `json:"phase"`
					Message    string `json:"message"`
					SyncResult *struct {
						Revision string `json:"revision"`
					} `json:"syncResult"`
					Operation struct {
						Sync *struct {
							Revision string `json:"revision"`
						} `json:"sync"`
					} `json:"operation"`
				} `json:"operationState"`
				Conditions []struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"conditions"`
				Resources []struct {
					Group           string `json:"group"`
					Kind            string `json:"kind"`
					Namespace       string `json:"namespace"`
					Name            string `json:"name"`
					Status          string `json:"status"`
					RequiresPruning bool   `json:"requiresPruning"`
				} `json:"resources"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := make(map[string]templateAppObserved, len(list.Items))
	for _, it := range list.Items {
		o := templateAppObserved{
			Health:         orUnknown(it.Status.Health.Status),
			Sync:           orUnknown(it.Status.Sync.Status),
			Revision:       it.Status.Sync.Revision,
			RepoURL:        it.Spec.Source.RepoURL,
			Chart:          it.Spec.Source.Chart,
			TargetRevision: it.Spec.Source.TargetRevision,
			Resources:      len(it.Status.Resources),
		}
		if op := it.Status.OperationState; op != nil {
			o.OperationPhase, o.OperationMessage = op.Phase, strings.TrimSpace(op.Message)
			switch {
			case op.SyncResult != nil && op.SyncResult.Revision != "":
				o.OperationRevision = op.SyncResult.Revision
			case op.Operation.Sync != nil:
				o.OperationRevision = op.Operation.Sync.Revision
			}
		}
		for _, c := range it.Status.Conditions {
			o.Conditions = append(o.Conditions, c.Type+": "+strings.TrimSpace(c.Message))
		}
		for _, r := range it.Status.Resources {
			if r.Status == "Synced" {
				continue
			}
			label := r.Kind
			if r.Group != "" {
				label = r.Group + "/" + r.Kind
			}
			name := r.Name
			if r.Namespace != "" {
				name = r.Namespace + "/" + r.Name
			}
			entry := label + " " + name + " " + orUnknown(r.Status)
			if r.RequiresPruning {
				entry += " (requires pruning)"
			}
			o.NotSyncedResources = append(o.NotSyncedResources, entry)
		}
		sort.Strings(o.NotSyncedResources)
		out[it.Metadata.Name] = o
	}
	return out, nil
}

// noOperation is what a not-OK row records when ArgoCD reports no sync operation at all, so an
// absent operation reads as absent rather than as a blank that looks like nothing went wrong.
const noOperation = "(none — ArgoCD reports no sync operation on this Application)"

// cause is the one-line WHY of a not-converged Application, in ArgoCD's words: the last
// operation (phase, revision, message), the conditions, and what is not Synced. Empty parts say so.
func (r templateAppResult) cause() string {
	op := r.OperationPhase
	if op != noOperation {
		if r.OperationRevision != "" {
			op += " at " + r.OperationRevision
		}
		if r.OperationMessage != "" {
			op += ": " + r.OperationMessage
		}
	}
	conds := "(none)"
	if len(r.Conditions) > 0 {
		conds = strings.Join(r.Conditions, "; ")
	}
	res := "(none)"
	if len(r.NotSyncedResources) > 0 {
		res = strings.Join(r.NotSyncedResources, ", ")
	}
	return "operation=" + op + " | conditions=" + conds + " | not synced=" + res
}

// templateAppResult is one Application's recorded verdict — the unit of the summary.
type templateAppResult struct {
	Application      string `json:"application"`
	Template         string `json:"template"`
	Source           string `json:"source"`
	RepoURL          string `json:"repo_url"`
	Chart            string `json:"chart,omitempty"`
	Revision         string `json:"sync_revision"`
	ExpectedRevision string `json:"expected_revision"`
	// ExpectedDigest is, for an OCI chart, the manifest digest its pinned tag resolved to before the
	// run — what ArgoCD 3.x reports as the synced revision of a native OCI source.
	ExpectedDigest string `json:"expected_digest,omitempty"`
	Sync           string `json:"sync"`
	Health         string `json:"health"`
	Resources      int    `json:"resources"`
	MinResources   int    `json:"min_resources"`
	OK             bool   `json:"ok"`
	Why            string `json:"why,omitempty"`
	Provenance     string `json:"provenance"`
	// The cause, recorded on every row that is NOT ok (see templateAppObserved): the last sync
	// operation, the conditions and the resources that are not Synced. Omitted on a passing row,
	// where it would be noise.
	OperationPhase     string   `json:"operation_phase,omitempty"`
	OperationMessage   string   `json:"operation_message,omitempty"`
	OperationRevision  string   `json:"operation_revision,omitempty"`
	Conditions         []string `json:"conditions,omitempty"`
	NotSyncedResources []string `json:"not_synced_resources,omitempty"`
}

// sameRepo compares two git URLs the way ArgoCD normalises them (case, a trailing `.git` or `/`).
func sameRepo(a, b string) bool {
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		s = strings.TrimSuffix(s, "/")
		return strings.TrimSuffix(s, ".git")
	}
	return norm(a) != "" && norm(a) == norm(b)
}

// evaluateTemplateApps is the PURE verdict over one observation. Every expected Application gets a
// result row whether or not it passed — the summary records the losers too. The error lists every
// failing row; nil means all passed.
//
// commits maps a template REPO to the commit its HEAD resolved to before the run spent anything;
// charts maps an OCI Application to the chart pin resolved from that commit, also before any spend.
func evaluateTemplateApps(expect []templateAppExpect, observed map[string]templateAppObserved, commits map[string]string, charts map[string]ociChartPin) ([]templateAppResult, error) {
	if len(expect) == 0 {
		return nil, errors.New("refusing a VACUOUS templates assertion: no Application is expected")
	}
	var results []templateAppResult
	var bad []string
	for _, e := range expect {
		r := templateAppResult{
			Application:  e.Application,
			Template:     e.Template,
			Source:       e.Source,
			MinResources: e.MinResources,
			Provenance:   e.Why,
		}
		o, ok := observed[e.Application]
		var why []string
		if !ok {
			why = append(why, "MISSING — no such Application in the argocd namespace")
		} else {
			r.RepoURL, r.Chart, r.Revision = o.RepoURL, o.Chart, o.Revision
			r.Sync, r.Health, r.Resources = o.Sync, o.Health, o.Resources
			if o.Health != "Healthy" {
				why = append(why, "health="+o.Health)
			}
			if o.Sync != "Synced" {
				why = append(why, "sync="+o.Sync)
			}
			if o.Resources < e.MinResources {
				why = append(why, fmt.Sprintf("manages %d resource(s), want ≥ %d — it rendered nothing, so the proof would be vacuous", o.Resources, e.MinResources))
			}
			switch e.Source {
			case templateSourceGit:
				want := commits[e.Repo]
				r.ExpectedRevision = want
				switch {
				case !sameRepo(o.RepoURL, e.Repo):
					why = append(why, fmt.Sprintf("syncs %q, not the template %q", o.RepoURL, e.Repo))
				case want == "":
					why = append(why, "no commit was resolved for "+e.Repo+" — cannot say which revision the template is at")
				case o.Revision != want:
					why = append(why, fmt.Sprintf("synced revision %q is not the template's HEAD %q", o.Revision, want))
				}
			case templateSourceOCI:
				pin, have := charts[e.Application]
				r.ExpectedRevision, r.ExpectedDigest = pin.Tag, pin.Digest
				why = append(why, judgeOCIRevision(o, pin, have)...)
			case templateSourcePlatform:
				r.ExpectedRevision = "(platform — not a template revision)"
			default:
				why = append(why, "unknown source kind "+e.Source)
			}
		}
		r.OK = len(why) == 0
		if !r.OK {
			r.Why = strings.Join(why, "; ")
			line := fmt.Sprintf("  - %s (%s): %s", e.Application, e.Template, r.Why)
			if ok {
				r.OperationPhase, r.OperationMessage, r.OperationRevision = o.OperationPhase, o.OperationMessage, o.OperationRevision
				if r.OperationPhase == "" {
					r.OperationPhase = noOperation
				}
				r.Conditions, r.NotSyncedResources = o.Conditions, o.NotSyncedResources
				line += "\n      " + r.cause()
			}
			bad = append(bad, line)
		}
		results = append(results, r)
	}
	if len(bad) > 0 {
		return results, fmt.Errorf("%d/%d template Application(s) not proven:\n%s", len(bad), len(expect), strings.Join(bad, "\n"))
	}
	return results, nil
}

// ── The template commits ───────────────────────────────────────────────────────────────────────

// parseLsRemoteHead reads `git ls-remote <repo> HEAD` output: exactly one `<sha>\tHEAD` line.
func parseLsRemoteHead(out string) (string, error) {
	var sha string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == "HEAD" {
			if sha != "" {
				return "", errors.New("git ls-remote reported HEAD twice")
			}
			sha = f[0]
		}
	}
	if len(sha) != 40 || strings.Trim(sha, "0123456789abcdef") != "" {
		return "", fmt.Errorf("git ls-remote reported no 40-hex HEAD commit (got %q)", strings.TrimSpace(out))
	}
	return sha, nil
}

// resolveTemplateCommits resolves every template's HEAD, anonymously (they are public), before any
// spend. A template that cannot be resolved stops the run here, in seconds.
func resolveTemplateCommits(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	for _, tpl := range starterTemplates {
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		cmd := exec.CommandContext(cctx, "git", "ls-remote", tpl.Repo, "HEAD")
		// Anonymous on purpose: no credential helper, no prompt.
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false")
		raw, err := cmd.Output()
		cancel()
		if err != nil {
			return nil, fmt.Errorf("git ls-remote %s HEAD: %w", tpl.Repo, err)
		}
		sha, err := parseLsRemoteHead(string(raw))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", tpl.Repo, err)
		}
		out[tpl.Repo] = sha
	}
	return out, nil
}

// ── The cost of what the run provisioned ───────────────────────────────────────────────────────

// templatesServerCost is one provisioned server, priced by Hetzner for its own location.
type templatesServerCost struct {
	Name           string `json:"name"`
	ServerType     string `json:"server_type"`
	Location       string `json:"location"`
	HourlyNetEUR   string `json:"hourly_net_eur"`
	HourlyGrossEUR string `json:"hourly_gross_eur"`
}

// templatesCost is the hourly price of every server carrying this run's cluster label.
type templatesCost struct {
	Source            string                `json:"source"`
	Servers           []templatesServerCost `json:"servers"`
	TotalHourlyNetEUR string                `json:"total_hourly_net_eur"`
	TotalHourlyGross  string                `json:"total_hourly_gross_eur"`
}

// parseHcloudServerCosts prices `GET /v1/servers?label_selector=cluster=<name>`. Each server is
// priced from ITS OWN server_type.prices entry for ITS OWN location — never a list price typed
// here, which would be a number nobody re-measures. No servers, or a server with no price for its
// location, is an ERROR: an empty bill is not a cheap one.
func parseHcloudServerCosts(raw []byte) ([]templatesServerCost, float64, float64, error) {
	var resp struct {
		Servers []struct {
			Name       string `json:"name"`
			ServerType struct {
				Name   string `json:"name"`
				Prices []struct {
					Location    string `json:"location"`
					PriceHourly struct {
						Net   string `json:"net"`
						Gross string `json:"gross"`
					} `json:"price_hourly"`
				} `json:"prices"`
			} `json:"server_type"`
			Datacenter struct {
				Location struct {
					Name string `json:"name"`
				} `json:"location"`
			} `json:"datacenter"`
			Location struct {
				Name string `json:"name"`
			} `json:"location"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, 0, 0, err
	}
	if len(resp.Servers) == 0 {
		return nil, 0, 0, errors.New("no server carries this run's cluster label — nothing to price, which is not the same as free")
	}
	var out []templatesServerCost
	var net, gross float64
	for _, s := range resp.Servers {
		loc := s.Datacenter.Location.Name
		if loc == "" {
			loc = s.Location.Name
		}
		found := false
		for _, p := range s.ServerType.Prices {
			if p.Location != loc {
				continue
			}
			n, nerr := strconv.ParseFloat(p.PriceHourly.Net, 64)
			g, gerr := strconv.ParseFloat(p.PriceHourly.Gross, 64)
			if nerr != nil || gerr != nil {
				return nil, 0, 0, fmt.Errorf("server %s: unparseable hourly price %q/%q", s.Name, p.PriceHourly.Net, p.PriceHourly.Gross)
			}
			net += n
			gross += g
			out = append(out, templatesServerCost{Name: s.Name, ServerType: s.ServerType.Name, Location: loc,
				HourlyNetEUR: p.PriceHourly.Net, HourlyGrossEUR: p.PriceHourly.Gross})
			found = true
			break
		}
		if !found {
			return nil, 0, 0, fmt.Errorf("server %s (%s): Hetzner lists no price for location %q", s.Name, s.ServerType.Name, loc)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, net, gross, nil
}

// hcloudServerCosts reads and prices this run's servers. The token rides only the header.
func hcloudServerCosts(ctx context.Context, token, cluster string) (*templatesCost, error) {
	if strings.TrimSpace(cluster) == "" {
		return nil, errors.New("no cluster name to select servers by")
	}
	var raw json.RawMessage
	if err := hcloudGetJSON(ctx, token, "servers?per_page=50&label_selector=cluster%3D"+cluster, &raw); err != nil {
		return nil, err
	}
	servers, net, gross, err := parseHcloudServerCosts(raw)
	if err != nil {
		return nil, err
	}
	return &templatesCost{
		Source:            "hcloud GET /v1/servers?label_selector=cluster=" + cluster + " — each server's own server_type.prices for its location",
		Servers:           servers,
		TotalHourlyNetEUR: strconv.FormatFloat(net, 'f', 4, 64),
		TotalHourlyGross:  strconv.FormatFloat(gross, 'f', 4, 64),
	}, nil
}

// ── The summary ────────────────────────────────────────────────────────────────────────────────

// Per-template verdicts.
const (
	templatePass   = "PASS"
	templateFail   = "FAIL"
	templateNotRun = "NOT_RUN"
)

// templateVerdict is one template's proof.
type templateVerdict struct {
	Template     string              `json:"template"`
	Repo         string              `json:"repo"`
	Ref          string              `json:"ref"`
	Commit       string              `json:"commit"`
	Phase        string              `json:"phase"`
	Path         string              `json:"path_followed"`
	AssertedAt   string              `json:"asserted_at,omitempty"`
	Verdict      string              `json:"verdict"`
	Why          string              `json:"why,omitempty"`
	Applications []templateAppResult `json:"applications"`
	// Cost is the AI template's: the hourly price of every server the run provisioned for it.
	Cost *templatesCost `json:"cost,omitempty"`
	// CostUnmeasured says why Cost is absent, so an absent bill cannot read as a zero one.
	CostUnmeasured string `json:"cost_unmeasured,omitempty"`
}

// TemplatesSummary is the file envTemplatesSummary names.
type TemplatesSummary struct {
	Issue     string            `json:"issue"`
	Provider  string            `json:"provider"`
	Cluster   string            `json:"cluster"`
	UpdatedAt string            `json:"updated_at"`
	Verdict   string            `json:"verdict"`
	Templates []templateVerdict `json:"templates"`
}

// templatesPaths is the tutorial path each template followed, in the page's own words.
var templatesPaths = map[string]string{
	"apps":  "environment → Repositories → ArgoCD apps repository = the template, Overlay path empty → Deploy (phase B: a redeploy of the same environment)",
	"chart": "Add-ons → Bring your own chart: Chart repository = the template, Chart path = chart, Ref = HEAD → Deploy",
	"ai":    "project from the AI Workloads template (webhook_ca_consumers=[kserve]); ArgoCD apps repository = the template, Overlay path empty; Bring your own chart = the template, path chart, ref HEAD → Deploy",
}

// newTemplatesSummary is the skeleton written BEFORE anything is asserted: every template
// NOT_RUN, so a run that dies early still leaves a summary saying what it never reached.
func newTemplatesSummary(provider, cluster string, commits map[string]string) TemplatesSummary {
	s := TemplatesSummary{Issue: "#4113", Provider: provider, Cluster: cluster}
	for _, tpl := range starterTemplates {
		phase := "A — starter-ai apps repo + both BYO charts"
		if tpl.Key == "apps" {
			phase = "B — the same environment redeployed with the apps repo re-pointed at starter-apps"
		}
		s.Templates = append(s.Templates, templateVerdict{
			Template: tpl.Key, Repo: tpl.Repo, Ref: templatesRef, Commit: commits[tpl.Repo],
			Phase: phase, Path: templatesPaths[tpl.Key], Verdict: templateNotRun,
		})
	}
	s.Verdict = s.overall()
	return s
}

// record folds one phase's results into the per-template verdicts. A template's verdict is PASS
// only when every Application attributed to it passed. phaseErr fails the touched templates ONLY
// when no row explains it (a listing that stopped answering, say): a failure that IS attributed to
// one template's Application must not fail the other template sharing the phase.
func (s *TemplatesSummary) record(results []templateAppResult, phaseErr error, at time.Time) {
	by := map[string][]templateAppResult{}
	attributed := false
	for _, r := range results {
		by[r.Template] = append(by[r.Template], r)
		if !r.OK {
			attributed = true
		}
	}
	for i := range s.Templates {
		v := &s.Templates[i]
		rs, touched := by[v.Template]
		if !touched {
			continue
		}
		v.Applications = rs
		v.AssertedAt = at.UTC().Format(time.RFC3339)
		v.Verdict = templatePass
		v.Why = ""
		var bad []string
		for _, r := range rs {
			if !r.OK {
				bad = append(bad, r.Application+": "+r.Why)
			}
		}
		if len(bad) > 0 {
			v.Verdict = templateFail
			v.Why = strings.Join(bad, " | ")
		} else if phaseErr != nil && !attributed {
			v.Verdict = templateFail
			v.Why = phaseErr.Error()
		}
	}
	s.UpdatedAt = at.UTC().Format(time.RFC3339)
	s.Verdict = s.overall()
}

// fail marks every still-NOT_RUN template among keys FAIL with why — a phase that died before it
// could observe anything must not leave its templates reading as never attempted. A template that
// already carries a verdict keeps it, and keeps its own reason.
func (s *TemplatesSummary) fail(keys []string, why string, at time.Time) {
	for i := range s.Templates {
		for _, k := range keys {
			if s.Templates[i].Template == k && s.Templates[i].Verdict == templateNotRun {
				s.Templates[i].Verdict = templateFail
				s.Templates[i].Why = why
				s.Templates[i].AssertedAt = at.UTC().Format(time.RFC3339)
			}
		}
	}
	s.UpdatedAt = at.UTC().Format(time.RFC3339)
	s.Verdict = s.overall()
}

// overall is PASS only when all three templates passed.
func (s TemplatesSummary) overall() string {
	if len(s.Templates) == 0 {
		return templateNotRun
	}
	all := templatePass
	for _, v := range s.Templates {
		switch v.Verdict {
		case templateFail:
			return templateFail
		case templateNotRun:
			all = templateNotRun
		}
	}
	return all
}

// template returns the verdict row for key (nil when absent).
func (s *TemplatesSummary) template(key string) *templateVerdict {
	for i := range s.Templates {
		if s.Templates[i].Template == key {
			return &s.Templates[i]
		}
	}
	return nil
}

// writeTemplatesSummary writes the summary atomically. An empty path is a no-op (a local run).
func writeTemplatesSummary(path string, s TemplatesSummary) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── The node shape ─────────────────────────────────────────────────────────────────────────────

// The requests the shape must hold, each with its source. The AI chart's are the four `requests`
// blocks in alethia-starter-ai's chart/values.yaml ("roughly 2.3 vCPU and 5 GiB", its README; the
// exact sum of the four blocks is 2.0 vCPU / 4.5 GiB). The platform's is a deliberate over-estimate
// of everything else a templates run schedules — ArgoCD, cert-manager, external-secrets,
// metrics-server, reloader, the hcloud CSI/CCM, CoreDNS, KServe's controller and Kueue's
// (500m/512Mi by its chart default) — because under-estimating it is the failure that costs a run.
const (
	templatesAIChartMilliCPU    = 2000
	templatesAIChartMemMiB      = 4608
	templatesLargestPodMilliCPU = 1000 // llama.cpp
	templatesLargestPodMemMiB   = 2048 // llama.cpp
	templatesPlatformMilliCPU   = 2000
	templatesPlatformMemMiB     = 3072
	// A Hetzner node keeps back roughly this much for the kubelet, Talos and the per-node
	// DaemonSets; again rounded against us.
	templatesNodeReserveMilliCPU = 300
	templatesNodeReserveMemMiB   = 1024
)

// templatesShapeWhy is the sizing argument for cluster_json.templates.hetzner.json, stated where
// its numbers live.
//
// cpx32 × 2 WORKERS (the control plane takes the same type on its own server): 8 vCPU / 16 GiB of
// workers for ~4 vCPU / ~7.5 GiB of requests. The cheaper candidates, and why each loses:
//
//   - the floor's cpx22 × 1 (2 vCPU / 4 GiB): the AI chart's requests alone exceed it.
//   - cpx32 × 1 (4 vCPU / 8 GiB): ~3.7 vCPU allocatable against ~4 vCPU of requests — Pending pods,
//     and a run that burns its whole window to learn a node size.
//   - cpx22 × 3: fits the requests on paper, but three 2-vCPU nodes leave llama.cpp (1 vCPU / 2 GiB
//     request, 6 GiB limit) and open-webui contending on a node already carrying the DaemonSets; it
//     buys one more server and one more boot for a saving of a few cents per run.
//   - cx33 (the issue's suggestion): the same 4 vCPU / 8 GiB, but Hetzner lists it AVAILABLE in no
//     datacenter (t2_preflight.go, #5069), and the spend cap admits only cpx22/cpx32.
//
// NOT a GPU, and not an ARM (cax*) type: the AI template is CPU-only by design, and an arm64 Talos
// image would CrashLoop the amd64-only images the chart pins.
const templatesShapeWhy = "cpx32 x2 workers: the AI chart requests 2.0 vCPU / 4.5 GiB and the platform + KServe + Kueue ~2 vCPU / ~3 GiB; one cpx32 cannot hold both, cx33 is available in no datacenter, and cpx22 x3 buys an extra server for cents"

// templatesShapeFits reports whether a cluster_json shape holds the templates' requests. PURE; the
// fixture test runs it over the committed file.
func templatesShapeFits(instanceType string, nodes int, nodeMilliCPU, nodeMemMiB int) error {
	if nodes < 1 {
		return fmt.Errorf("%d node(s)", nodes)
	}
	allocCPU := nodeMilliCPU - templatesNodeReserveMilliCPU
	allocMem := nodeMemMiB - templatesNodeReserveMemMiB
	if allocCPU < templatesLargestPodMilliCPU || allocMem < templatesLargestPodMemMiB {
		return fmt.Errorf("%s allocates ~%dm / %dMi per node, below the largest pod's request (%dm / %dMi)",
			instanceType, allocCPU, allocMem, templatesLargestPodMilliCPU, templatesLargestPodMemMiB)
	}
	needCPU := templatesAIChartMilliCPU + templatesPlatformMilliCPU
	needMem := templatesAIChartMemMiB + templatesPlatformMemMiB
	if nodes*allocCPU < needCPU || nodes*allocMem < needMem {
		return fmt.Errorf("%s x%d allocates ~%dm / %dMi, below the %dm / %dMi the templates request",
			instanceType, nodes, nodes*allocCPU, nodes*allocMem, needCPU, needMem)
	}
	return nil
}

// argoTimeoutFor is the base ArgoCD assertion's window: widened by templatesAIConverge on the
// templates dimension, whose derived set carries the AI chart (see templatesAIConverge).
func argoTimeoutFor(templatesOn bool) time.Duration {
	if templatesOn {
		return ArgoAssertTimeout() + templatesAIConverge
	}
	return ArgoAssertTimeout()
}
