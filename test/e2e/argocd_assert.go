// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ArgoCD Application health/sync assertion — the shared "GitOps actually CONVERGED"
// half of the provisioning tiers (BYOC A0.2). RunDeployV2 installs ArgoCD and applies
// the rendered Applications on every cluster, but installed is not healthy: an app
// stuck Progressing / Degraded / OutOfSync passed T1 and T2 before this file existed.
// Both tiers now derive the set of Applications that MUST converge from the job's
// persisted execution_metadata and poll the cluster (via each tier's independent
// kubeconfig) until every one reports health "Healthy" AND sync "Synced" — the same
// fields packages/core/argocd/health.go (ReadAddOnHealth) reads, asserted instead of
// merely recorded.
//
// This file is deliberately UNTAGGED (like controlplane.go) so both build-tagged
// tiers compile it and `go mod tidy` sees its dependencies. Nothing here imports
// `testing`; the tagged tests drive it and own all failure handling.
//
// # How this assertion defends its own vacuity
//
//   - The expected set is DERIVED from the runner's persisted decisions — the
//     `infra_services` install/skip records plus the `addon_status` keys — never
//     hardcoded, so it cannot drift from what the deploy actually shipped.
//   - An EMPTY derived set is a hard error in BOTH DeriveExpectedArgoApps and
//     AssertArgoAppsHealthy: asserting over nothing proves nothing. The tiers seed a
//     tiny marketplace add-on (seedAddOns in controlplane.go) so the set is never
//     empty on the lean kind/hetzner paths, where every infra-service decision that
//     maps to an Application is honestly "skipped".
//   - The poll is BOUNDED (ALETHIA_E2E_ARGO_TIMEOUT, default 8m) and a timeout fails
//     with every expected app's health/sync/conditions plus a `kubectl describe` of
//     the losers, so a red merge-queue run or nightly is diagnosable from logs alone.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// argoPollInterval is how often AssertArgoAppsHealthy re-reads the Applications.
const argoPollInterval = 15 * time.Second

// argoAppState is one Application's observed status: the health/sync pair mirrors
// packages/core/argocd/health.go (AddOnHealth), plus the status conditions so a
// failure dump carries ArgoCD's own explanation (ComparisonError, SyncError, …).
type argoAppState struct {
	Health     string
	Sync       string
	Conditions []string
	// OutOfSyncResources names the individual resources ArgoCD reports as OutOfSync, as
	// `Kind/name`. Sorted and de-duplicated.
	//
	// WHY IT IS CARRIED. An Application that is Healthy AND OutOfSync is the most confusing
	// state this assertion can report: the workload is up, nothing in the cluster is wrong, and
	// the run still loses its verdict. On 2026-08-26 three add-ons sat there on BOTH hetzner and
	// aws — argo-rollouts, kyverno and tempo — and the report named the Applications without
	// naming what differed, so the only way to act on it was to reach for a live cluster.
	//
	// The answer was already in the payload: `.status.resources[]` carries a per-resource sync
	// status, and this assertion was fetching and discarding it. The Application template already
	// ignores two API-server-managed fields (`.status.terminatingReplicas`, the resourceFieldRef
	// divisor) for exactly this class; naming the resource is what tells you whether a third
	// belongs there.
	OutOfSyncResources []string
	// OutOfSyncRefs is the same set, structured, so the live objects can be fetched and dumped.
	// Naming the RESOURCE (#2738) answered "which object differs" and left "which FIELD differs"
	// to a guess — and a guessed ignoreDifferences entry can MASK REAL DRIFT rather than no-op.
	OutOfSyncRefs []outOfSyncRef
}

// anyProvider is the infraServiceArgoApps inner key meaning "the same Application on
// every cloud" — the common case, where the service is cloud-agnostic.
const anyProvider = ""

// infraServiceArgoApps maps an `infra_services` decision (see
// packages/core/argocd/decisions.go InfraServiceDecisions) to the ArgoCD Application
// that ships it when the decision is "installed". Together with infraServiceNoApp it
// must cover EVERY service decisions.go can record: an installed decision matching
// neither is a hard derivation error (fail-closed — a renamed or newly added service
// must WIDEN the assertion, never silently shrink it), and a unit test pins both
// maps against the real InfraServiceDecisions service list.
//
// The mapping is PROVIDER-KEYED, because one service can ship a DIFFERENT Application
// per cloud: "ingress" is the ALB controller on AWS and will be something else entirely
// on GCP/Azure/Alibaba as those lanes land. Outer key = service, inner key = provider,
// with anyProvider ("") meaning "the same on every cloud" — the same shape of per-cloud
// membership fact as metricsServerProviders below.
//
// The fail-closed contract is UNCHANGED and, if anything, tighter: an "installed"
// decision whose cloud has no entry resolves to nothing, and — absent an
// infraServiceNoApp entry — is the same hard derivation error as an unknown service.
// A lane that flips its cloud's ingress decision to "installed" without naming the
// Application it renders therefore breaks the derivation loudly, instead of the run
// waiting out the whole ArgoCD timeout for an app nobody rendered (the #1722 shape).
var infraServiceArgoApps = map[string]map[string]string{
	// infra/templates/argocd/external-dns.yaml
	"external-dns": {anyProvider: "external-dns"},
	// the ClusterSecretStore renders inside the operator's template — an installed
	// store implies the external-secrets-operator Application must be healthy.
	"external-secrets-store": {anyProvider: "external-secrets-operator"},
	// the cross-account (*-xacct) ClusterSecretStore is applied by the RUNNER
	// (argocd.EnsureExternalSecretsStore), not by an Application of its own — but it is a
	// CR whose CRD and admission webhook ship with the operator, so exactly like the
	// native store above, an installed one implies external-secrets-operator is healthy.
	"external-secrets-store-xacct": {anyProvider: "external-secrets-operator"},
	// infra/templates/argocd/cert-manager.yaml — the platform (Rail B) cert-manager. Cloud-agnostic
	// HERE on purpose: the decision itself is already per-cloud (certManagerDecision is "installed"
	// only where CertManagerSolver() resolves, i.e. aws/gcp/azure on native DNS), and where it does
	// install it is the same Application everywhere. The ClusterIssuer the runner applies afterwards
	// is a CR, not an Application, so it adds nothing to this set.
	"cert-manager": {anyProvider: "cert-manager"},
	// ingressDecision is "installed" only where argocd.ingressControllers has an entry.
	// ONE LINE PER CLOUD: add the cloud's controller Application here in the same PR that
	// adds its ingressControllers entry, and the two stay in step. A cloud whose ingress is
	// installed but ships NO Application — GKE's controller runs in the Google-managed control
	// plane, so there is nothing to sync — belongs under its provider key in infraServiceNoApp
	// instead, never here with an empty string: "" would enter the expected set and make the
	// poll wait out the full timeout for an Application with no name.
	//
	// azure DOES ship one, so it is here rather than there: its Application name is the AGIC chart
	// name, pinned by `fullnameOverride: ingress-azure` in the template — the same string the
	// federated identity credential's KSA subject depends on.
	"ingress": {"aws": "aws-load-balancer-controller", "azure": "ingress-azure"},
	// appsRepoDecision is "installed" when the project wired an apps-destination repo: the
	// runner credentials ArgoCD to it (the shared "repo-apps" repository Secret) and renders
	// the credentialed "apps" app-of-apps that syncs the customer's repo (user-apps.yaml). This
	// is the repo-apps half of the ArgoCD-WITH-REPOS proof (BYOC A0.6) — deriving it here (never
	// hardcoding it) keeps the expected set honest with what the deploy actually shipped. The BYO
	// (repo-byo-*) half rides the addon_status keys: a bring-your-own git-source chart is a
	// managed add-on, so its "addon-<id>" Application is already in the derived set.
	"apps-repo": {anyProvider: "apps"},
}

// argoAppForInfraService resolves the Application an installed decision implies on this
// cloud: the cloud's own entry if there is one, else the cloud-agnostic anyProvider entry.
// ok=false means "this service ships no Application ON THIS CLOUD" — the caller must then
// find it in infraServiceNoApp or fail the derivation.
func argoAppForInfraService(provider, service string) (app string, ok bool) {
	byProvider, known := infraServiceArgoApps[service]
	if !known {
		return "", false
	}
	if app, ok := byProvider[provider]; ok {
		return app, true
	}
	app, ok = byProvider[anyProvider]
	return app, ok
}

// infraServiceNoApp whitelists the decisions that genuinely ship NO ArgoCD Application of their
// own: "storage-class" is a StorageClass object, "argocd-url" is an ingress on the ArgoCD install
// itself, and "waf" is an annotation or a small CR on that same ingress
// (alb.ingress.kubernetes.io/wafv2-acl-arn on AWS, a BackendConfig on GCP) — none has app health
// of its own.
//
// PROVIDER-KEYED, exactly like infraServiceArgoApps above and for the same reason one dimension
// over: whether a service ships an Application can differ per cloud. "ingress" is the case that
// forced it — the ALB controller is a real Application on AWS, while on GKE the Ingress controller
// runs in the Google-managed control plane and Alethia installs nothing. A service-level whitelist
// could not express that without whitelisting "ingress" on EVERY cloud, which would silently
// forgive the Azure and Alibaba lanes landing beside this one for shipping a controller whose
// Application the assertion never checks — the fail-closed contract this file is built on.
//
// anyProvider ("") means "ships no Application on any cloud" — the common case.
// Add an entry ONLY when the install truly has no Application to assert.
var infraServiceNoApp = map[string]map[string]struct{}{
	"storage-class": {anyProvider: {}},
	"argocd-url":    {anyProvider: {}},
	"waf":           {anyProvider: {}},
	// GKE Ingress: built into the managed control plane (see argocd.ingressControllers["gcp"]).
	// Deliberately NOT anyProvider — AWS resolves via infraServiceArgoApps first, but a cloud
	// that later installs a controller must still be forced to name it.
	"ingress": {"gcp": {}},
}

// infraServiceShipsNoApp reports whether an installed decision for `service` genuinely renders no
// ArgoCD Application ON THIS CLOUD — the cloud's own entry if there is one, else the cloud-agnostic
// anyProvider entry. False means the derivation must have found an Application for it, or fail.
func infraServiceShipsNoApp(provider, service string) bool {
	byProvider, known := infraServiceNoApp[service]
	if !known {
		return false
	}
	if _, ok := byProvider[provider]; ok {
		return true
	}
	_, ok := byProvider[anyProvider]
	return ok
}

// alwaysRenderedArgoApps are the Applications infra/templates/argocd renders
// UNCONDITIONALLY — no template render gate, no InfraServiceDecision records them,
// and CleanupSkippedInfraServices never deletes them — so EVERY successful deploy
// that ran the GitOps bootstrap (the tiers assert cluster_name, which gates that
// whole block) must have them converged, regardless of provider or configuration:
//   - external-secrets-operator: the operator Application in
//     external-secrets-operator.yaml is ungated (only the per-cloud
//     ClusterSecretStores inside the same template are conditional).
//
// A template gaining a render gate must move its app out of here and into the
// decision-derived mapping above — metrics-server did exactly that in #1722; see
// metricsServerProviders.
var alwaysRenderedArgoApps = []string{"external-secrets-operator"}

// metricsServerProviders are the clouds whose metrics-server.yaml actually renders:
// the ones whose managed control plane does NOT already ship a metrics-server.
// gcp (GKE addon-manager), azure (AKS-managed, with a VPA sidecar) and alibaba (ACK
// system component) each install their own into kube-system, so Alethia installing a
// second one is the #1722 ownership collision — there, no Application exists and
// waiting for one would hang the assertion until timeout on a cluster that is fine.
//
// This MUST mirror the `if` in infra/templates/argocd/metrics-server.yaml.
// TestMetricsServerGateMatchesTemplate pins the two together by parsing the template,
// so the pair cannot drift silently.
var metricsServerProviders = map[string]bool{"aws": true, "hetzner": true}

// DeriveExpectedArgoApps derives the ArgoCD Application names a successful deploy is
// REQUIRED to have converged: the always-rendered platform apps
// (alwaysRenderedArgoApps), plus metrics-server on the clouds that render it
// (metricsServerProviders), plus — from the job's persisted execution_metadata —
// every `infra_services` decision with status "installed" that ships an Application,
// plus every `addon_status` key (the runner records one per enabled add-on, named
// `addon-<id>` — see packages/core/argocd/addons.go AllAddOnNames). Returns the names
// sorted + de-duplicated.
//
// FAIL-CLOSED in both directions:
//   - an "installed" service that is in NEITHER infraServiceArgoApps NOR
//     infraServiceNoApp is an error — a renamed/new decision must widen the
//     assertion, never silently shrink it;
//   - an unknown `provider` is an error rather than a silent "no metrics-server";
//   - an empty derived set is an error, not an empty assertion (defense-in-depth;
//     structurally unreachable while alwaysRenderedArgoApps is non-empty). The tiers
//     additionally seed an add-on (seedAddOns) so the ADD-ON pipeline is always
//     exercised too, not just the platform apps.
func DeriveExpectedArgoApps(provider string, metaRaw []byte) ([]string, error) {
	if len(metaRaw) == 0 {
		return nil, errors.New("execution_metadata is empty — cannot derive the expected ArgoCD Application set")
	}
	// The provider decides one membership question (metrics-server), so an empty or
	// unknown one must NOT quietly answer it. Refuse instead: a typo'd provider would
	// otherwise silently drop metrics-server from the expected set on aws/hetzner and
	// turn a real regression into a pass.
	if _, known := t2LookupProvider(provider); !known {
		return nil, fmt.Errorf("unknown provider %q — cannot derive the expected ArgoCD Application set (known: %s)", provider, t2SupportedProviders())
	}
	var meta struct {
		InfraServices []struct {
			Service string `json:"service"`
			Status  string `json:"status"`
		} `json:"infra_services"`
		AddOnStatus map[string]json.RawMessage `json:"addon_status"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, fmt.Errorf("decode execution_metadata: %w", err)
	}

	set := map[string]struct{}{}
	for _, app := range alwaysRenderedArgoApps {
		set[app] = struct{}{}
	}
	if metricsServerProviders[provider] {
		set["metrics-server"] = struct{}{}
	}
	for _, d := range meta.InfraServices {
		if d.Status != "installed" {
			continue
		}
		if app, ok := argoAppForInfraService(provider, d.Service); ok {
			set[app] = struct{}{}
			continue
		}
		if infraServiceShipsNoApp(provider, d.Service) {
			continue
		}
		return nil, fmt.Errorf("unrecognized installed infra service %q on provider %q in execution_metadata — add it to infraServiceArgoApps (it ships an Application) or infraServiceNoApp (it genuinely ships none) in argocd_assert.go — BOTH maps are per-cloud, so the entry may be for this provider alone — and the assertion widens instead of silently shrinking", d.Service, provider)
	}
	for name := range meta.AddOnStatus {
		set[name] = struct{}{}
	}

	if len(set) == 0 {
		return nil, errors.New("derived ArgoCD Application set is EMPTY (no installed infra service ships an Application and no add-on was enabled) — the health assertion would be vacuous; seed at least one managed add-on in the job's config snapshot")
	}
	names := make([]string, 0, len(set))
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

// RequireAllAddOnsExpected refuses a full-surface run whose ASSERTION set lost the add-ons.
//
// WHY, measured. hetzner/addons run 32883521925 reported
//
//	--- PASS: TestT2RealCloudProvisioning (1053.09s)
//
// having asserted FOUR Applications — `[addon-byo-e2e apps external-secrets-operator
// metrics-server]` — on the dimension whose own banner calls it "the 18-chart sweep to
// Healthy+Synced". No harbor, no kube-prometheus-stack, no loki, no vault. The 2026-08-24 run of
// the same dimension asserted twenty. `ALETHIA_E2E_ALL_ADDONS=1` was set and reached the harness.
//
// The add-on half of the expected set comes from `execution_metadata.addon_status`, and the same
// run logged why it was missing:
//
//	A0.5 WARN: reloader add-on health row absent/empty — finalizeDeployment.recordAddonHealth
//	did not persist real ArgoCD health
//
// So the assertion derives its own SCOPE from a source that can silently shrink. DeriveExpectedArgoApps
// guards `len(set) == 0` — "never empty" — and four is not zero, so a full-surface run reported
// green having proven the floor. That is precisely the vacuous proof `AllCatalogAddOns` already
// refuses on the SEEDING side ("a full-surface run that quietly installed 1 add-on and reported
// green would be the exact vacuous proof the FULLY-TESTED bar exists to prevent"); the same
// argument had never been applied to the ASSERTING side.
//
// The harness already knew the right number: `argoAddOnCount` sizes the convergence BUDGET from
// the catalog, so the budget expected eighteen while the assertion expected four. A decision that
// reports on an emitter must mirror every field the emitter set.
//
// A no-op unless ALETHIA_E2E_ALL_ADDONS is on — the lean tier genuinely seeds a small set.
func RequireAllAddOnsExpected(expected []string) error {
	if !AllAddOnsEnabled() {
		return nil
	}
	catalog, err := AllCatalogAddOns()
	if err != nil {
		// Fail-closed: unable to read the catalog is not "nothing to check".
		return fmt.Errorf("full add-on surface requested but the catalog fixture is unreadable, so the assertion set cannot be checked for completeness: %w", err)
	}
	have := make(map[string]struct{}, len(expected))
	for _, e := range expected {
		have[e] = struct{}{}
	}
	var missing []string
	for _, a := range catalog {
		if a.Mode != "managed" || a.IsManifestSource() {
			// Only ArgoCD-rendered add-ons produce an Application to assert on. A manifest
			// add-on is kubectl-applied and has none, so requiring one would red every run.
			continue
		}
		name := argocd.AddOnAppName(a.ID)
		if _, ok := have[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf(
		"ALETHIA_E2E_ALL_ADDONS=1 but %d of the catalog's Application-bearing add-ons are ABSENT from the expected set, so this run would assert the floor and report the 18-chart sweep: %s\n"+
			"  the set is derived from execution_metadata.addon_status; an empty/short one means finalizeDeployment.recordAddonHealth did not persist add-on health (look for the A0.5 WARN in this run)\n"+
			"  asserted instead: %v",
		len(missing), strings.Join(missing, ", "), expected)
}

// AssertArgoAppsHealthy polls `kubectl get applications.argoproj.io -n argocd -o json`
// via the given kubeconfig until EVERY expected Application reports health "Healthy"
// AND sync "Synced", or the timeout elapses. A bounded poll (argoPollInterval), so a
// never-converging app fails loudly instead of blocking forever. On timeout the error
// carries the full per-app state (health/sync/conditions for every expected app, plus
// every Application actually present) and a `kubectl describe` of each loser — enough
// to diagnose a red run from logs alone. An empty expected set is refused outright
// (see DeriveExpectedArgoApps).
func AssertArgoAppsHealthy(ctx context.Context, kubeconfigPath string, expected []string, timeout time.Duration) error {
	if len(expected) == 0 {
		return errors.New("refusing a VACUOUS ArgoCD health assertion: the expected Application set is empty")
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	var lastLosers []string
	var lastRefs []outOfSyncRef
	for {
		raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
		if err != nil {
			// A read hiccup (apiserver blip, CRD not yet registered) is retried until the
			// deadline — unlike ReadAddOnHealth's best-effort Unknown, a persistent failure
			// here must FAIL, not soften.
			lastErr = fmt.Errorf("listing ArgoCD Applications failed: %w", err)
			lastLosers, lastRefs = nil, nil
		} else if observed, perr := parseArgoApps(raw); perr != nil {
			lastErr = fmt.Errorf("parsing ArgoCD Applications failed: %w", perr)
			lastLosers, lastRefs = nil, nil
		} else {
			losers, everr := evaluateArgoApps(observed, expected)
			if everr == nil {
				return nil
			}
			lastErr, lastLosers = everr, losers
			lastRefs = refsForLosers(observed, losers)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ArgoCD Applications did not all reach Healthy+Synced within %s:\n%v%s",
				timeout, lastErr, describeArgoApps(ctx, kubeconfigPath, lastLosers)+dumpOutOfSyncResources(ctx, kubeconfigPath, lastRefs))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for ArgoCD Applications (%v); last state:\n%v", ctx.Err(), lastErr)
		case <-time.After(argoPollInterval):
		}
	}
}

// Budget shape for ArgoAssertTimeout. The flat 8m these replace was set for the LEAN surface and
// then inherited, unchanged, by the full 18-chart one — which is what killed the first real hetzner
// run of the 18-add-on set (#2062) with velero still `Missing`. The surface is knowable at runtime,
// so derive from it rather than picking a bigger constant and hoping.
const (
	// argoBudgetBase covers ArgoCD itself: repo-server clone, the first reconcile loop, and the
	// app-of-apps landing before any add-on chart is pulled.
	argoBudgetBase = 6 * time.Minute
	// argoBudgetPerAddOn is per chart in the surface. Sub-minute because ArgoCD syncs applications
	// in PARALLEL — this buys headroom for pull + CRD establish contending on a small node, not a
	// serial install. At the lean tier it lands the total on ~8m, i.e. exactly today's behaviour.
	argoBudgetPerAddOn = 45 * time.Second
	// argoBudgetFloor never lets a derived value come out SHORTER than the constant it replaced,
	// so no existing scenario gets tighter as a side effect of this change.
	argoBudgetFloor = 8 * time.Minute
	// argoBudgetCeiling stays under the smallest parent bound in t2_providers.go (hetzner's 25m
	// waitTimeout). Budgeting past the timeout that CANCELS you buys nothing — the run dies at the
	// parent instead, with a less useful message. That parent is the real ceiling, not the go-test
	// cap, which is why this is pinned by a test rather than left as a comment.
	argoBudgetCeiling = 20 * time.Minute
)

// ArgoAssertTimeout is the bound for AssertArgoAppsHealthy: ALETHIA_E2E_ARGO_TIMEOUT when set,
// else a budget DERIVED from the add-on surface this run actually seeds. The poll returns the
// moment everything is green, so a larger budget only costs time on a genuinely broken cluster —
// but a budget smaller than the surface needs costs a real run its verdict, which is worse.
//
// Fail-soft on the fixture, deliberately: if the catalog cannot be read, fall back to the full
// surface's budget rather than the lean one. Guessing SMALL here would reintroduce the exact
// failure this derivation exists to remove.
func ArgoAssertTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_ARGO_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return argoBudgetFor(argoAddOnCount())
}

// argoAddOnCount is how many add-on charts this run expects ArgoCD to converge.
func argoAddOnCount() int {
	if !AllAddOnsEnabled() {
		// The lean tier seeds a small fixed set; the base + floor already cover it.
		return 0
	}
	addons, err := AllCatalogAddOns()
	if err != nil {
		return expectedCatalogSize
	}
	return len(addons)
}

// argoBudgetFor turns an add-on count into a wait budget, clamped at both ends.
func argoBudgetFor(addOns int) time.Duration {
	d := argoBudgetBase + time.Duration(addOns)*argoBudgetPerAddOn
	if d < argoBudgetFloor {
		d = argoBudgetFloor
	}
	if d > argoBudgetCeiling {
		d = argoBudgetCeiling
	}
	return d
}

// parseArgoApps parses `kubectl get applications.argoproj.io -o json` output into a
// name → state map, mirroring packages/core/argocd/health.go's trimmed shape (an empty
// health/sync string normalises to "Unknown") and additionally keeping the status
// conditions for the failure dump.
func parseArgoApps(raw []byte) (map[string]argoAppState, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Health struct {
					Status string `json:"status"`
				} `json:"health"`
				Sync struct {
					Status string `json:"status"`
				} `json:"sync"`
				Conditions []struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"conditions"`
				Resources []struct {
					Group     string `json:"group"`
					Kind      string `json:"kind"`
					Name      string `json:"name"`
					Namespace string `json:"namespace"`
					Status    string `json:"status"`
				} `json:"resources"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := make(map[string]argoAppState, len(list.Items))
	for _, item := range list.Items {
		st := argoAppState{
			Health: orUnknown(item.Status.Health.Status),
			Sync:   orUnknown(item.Status.Sync.Status),
		}
		for _, c := range item.Status.Conditions {
			st.Conditions = append(st.Conditions, c.Type+": "+c.Message)
		}
		// Only the OutOfSync ones. A Synced resource in a Synced app is noise, and in an
		// OutOfSync app it is the part that is fine.
		seenRes := map[string]struct{}{}
		for _, r := range item.Status.Resources {
			if r.Status != "OutOfSync" {
				continue
			}
			label := r.Kind + "/" + r.Name
			if r.Group != "" {
				label = r.Group + "/" + r.Kind + "/" + r.Name
			}
			if _, dup := seenRes[label]; dup {
				continue
			}
			seenRes[label] = struct{}{}
			st.OutOfSyncResources = append(st.OutOfSyncResources, label)
			st.OutOfSyncRefs = append(st.OutOfSyncRefs, outOfSyncRef{
				Group: r.Group, Kind: r.Kind, Name: r.Name, Namespace: r.Namespace,
			})
		}
		sort.Strings(st.OutOfSyncResources)
		out[item.Metadata.Name] = st
	}
	return out, nil
}

// evaluateArgoApps is the PURE decision over one observation: nil error iff every
// expected Application is present with health "Healthy" AND sync "Synced" (exact
// match — "Progressing", "Degraded", "OutOfSync", "Unknown" and a missing app all
// fail). Returns the failing names plus an error that reports each expected app's
// state and the full observed Application list, so the poll wrapper needs no cluster
// to be unit-tested.
func evaluateArgoApps(observed map[string]argoAppState, expected []string) (losers []string, err error) {
	if len(expected) == 0 {
		return nil, errors.New("refusing a VACUOUS ArgoCD health assertion: the expected Application set is empty")
	}
	var report strings.Builder
	for _, name := range expected {
		st, ok := observed[name]
		if !ok {
			losers = append(losers, name)
			fmt.Fprintf(&report, "  - %s: MISSING (no such Application in the argocd namespace)\n", name)
			continue
		}
		if st.Health == "Healthy" && st.Sync == "Synced" {
			continue
		}
		losers = append(losers, name)
		fmt.Fprintf(&report, "  - %s: health=%s sync=%s", name, st.Health, st.Sync)
		if len(st.Conditions) > 0 {
			fmt.Fprintf(&report, " [%s]", strings.Join(st.Conditions, "; "))
		}
		// Name WHAT differs, not just that something does. For a Healthy-but-OutOfSync app this
		// is the whole diagnosis: the workload is up, so the resource named here is a
		// spurious-diff candidate for the template's ignoreDifferences.
		if len(st.OutOfSyncResources) > 0 {
			fmt.Fprintf(&report, "\n      OutOfSync: %s", strings.Join(st.OutOfSyncResources, ", "))
		} else if st.Sync == "OutOfSync" {
			// EMPTY IS NOT "nothing differs". ArgoCD can report an app OutOfSync with an empty
			// or not-yet-populated resource list, and silence there would read as a clean diff.
			report.WriteString("\n      OutOfSync: (no per-resource detail reported by ArgoCD)")
		}
		report.WriteString("\n")
	}
	if len(losers) == 0 {
		return nil, nil
	}
	fmt.Fprintf(&report, "all Applications observed in the argocd namespace:\n")
	for _, name := range sortedAppNames(observed) {
		st := observed[name]
		fmt.Fprintf(&report, "  - %s: health=%s sync=%s\n", name, st.Health, st.Sync)
	}
	return losers, fmt.Errorf("%d/%d expected ArgoCD Applications are not Healthy+Synced:\n%s",
		len(losers), len(expected), strings.TrimRight(report.String(), "\n"))
}

// sortedAppNames returns the observed Application names sorted, for stable reports.
func sortedAppNames(observed map[string]argoAppState) []string {
	names := make([]string, 0, len(observed))
	for n := range observed {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// orUnknown normalises an empty status string to "Unknown" (mirrors
// packages/core/argocd/health.go).
func orUnknown(s string) string {
	if s == "" {
		return "Unknown"
	}
	return s
}

// kubectlGetArgoApps lists the Applications in the argocd namespace as JSON via an
// explicit kubeconfig (each tier's INDEPENDENT path to the cluster — never the
// runner's side-effect env). Bounded by its own short timeout under ctx.
func kubectlGetArgoApps(ctx context.Context, kubeconfigPath string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	return out, nil
}

// describeArgoApps returns `kubectl describe` output for each losing Application
// (best-effort, truncated per app, capped at 5 apps) formatted for appending to the
// timeout error — the "full dump" that makes a red nightly diagnosable from logs.
func describeArgoApps(ctx context.Context, kubeconfigPath string, losers []string) string {
	const maxApps = 5
	const maxPerApp = 4000
	var b strings.Builder
	for i, name := range losers {
		if i == maxApps {
			fmt.Fprintf(&b, "\n… %d more failing Applications not described", len(losers)-maxApps)
			break
		}
		fmt.Fprintf(&b, "\n──── kubectl describe application %s ────\n", name)
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
			"describe", "applications.argoproj.io", "-n", "argocd", name)
		out, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			fmt.Fprintf(&b, "(describe failed: %v)\n%s", err, out)
			continue
		}
		s := string(out)
		if len(s) > maxPerApp {
			s = s[:maxPerApp] + "…(truncated)"
		}
		b.WriteString(s)
		// `describe application` shows the DESIRED spec and the sync status. It says nothing about
		// the workload, so a Degraded app — which ArgoCD derives from the underlying Deployment —
		// reports a verdict with no cause attached. See dumpUnhealthyPods.
		b.WriteString(dumpUnhealthyPods(ctx, kubeconfigPath, name))
	}
	return b.String()
}

// dumpUnhealthyPods reports the pods behind an Application that are not Running, with their recent
// events and container logs.
//
// WHY. ArgoCD's `Degraded` comes from the workload, and `kubectl describe application` shows only
// the desired spec and the sync status — no restart count, no container status, no events. gcp
// `maxconfig` run 32951789725 spent 52 minutes and ~EUR 1.50 to end at
// `external-dns: health=Degraded sync=Synced`, with the rendered Application visibly CORRECT
// (`provider: google`, the right workload-identity annotation) and nothing in the dump able to say
// what the pod was actually doing. A verdict nobody can act on costs the next run too.
//
// This is the `Degraded` counterpart to dumpOutOfSyncResources, and the same shape
// applyStoreAwaitingOperator already uses on its deadline branch — for the same stated reason: a
// slow install and a crash-looping pod are indistinguishable from the outer error alone.
//
// The events are usually the whole answer. `CreateContainerConfigError`, `CrashLoopBackOff` and an
// image-pull failure all look identical at the Application level and need three different fixes.
//
// Best-effort and hard-capped: this runs on an ALREADY-FAILING path and must never be why a run
// hangs or an error is lost. A pod dump that fails says so — "could not read it" and "nothing was
// wrong" must not look the same.
func dumpUnhealthyPods(ctx context.Context, kubeconfigPath, app string) string {
	const (
		maxPods     = 3
		maxLogLines = "40"
	)
	// ArgoCD labels every resource it manages with the Application's name. That is how the pods are
	// found without knowing which namespace the chart chose.
	selector := "app.kubernetes.io/instance=" + app
	run := func(timeout time.Duration, args ...string) (string, error) {
		cctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
		out, err := exec.CommandContext(cctx, "kubectl", full...).CombinedOutput()
		return string(out), err
	}

	// `-o custom-columns` rather than JSON: this is read by a human in a log, and the whole point is
	// that the restart count and the waiting reason are visible at a glance.
	out, err := run(30*time.Second, "get", "pods", "-A", "-l", selector, "--no-headers",
		"-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,"+
			"READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,"+
			"REASON:.status.containerStatuses[*].state.waiting.reason")
	if err != nil {
		return fmt.Sprintf("\n──── pods for %s: could not list (%v) ────\n", app, err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) == 1 && lines[0] == "" {
		// NO PODS. That is a DIFFERENT fact from "they are all fine" — but on its own it is ALSO
		// ambiguous, and the first run to hit it proved so.
		//
		// hetzner/addons 32959867406 reported `addon-falco: NONE match … — the workload was never
		// created`, and that read as a finding. It is not one: it conflates
		//
		//     the Application manages a workload that has produced no pods   (a real fault)
		//     the Application manages no workload at all                     (a different fault)
		//     the pods exist under a label this selector does not match      (NOT a fault — a bug HERE)
		//
		// The third would have this dump confidently blame a chart for something the harness got
		// wrong. So ask ArgoCD what it thinks it manages: the Application's own `.status.resources`
		// is the authority, and it distinguishes all three.
		return fmt.Sprintf("\n──── pods for %s: NONE match %s ────%s\n", app, selector,
			describeManagedWorkloads(ctx, kubeconfigPath, app))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "\n──── pods for %s (%s) ────\n%s\n", app, selector, strings.Join(lines, "\n"))

	shown := 0
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		ns, pod, phase := fields[0], fields[1], fields[2]
		// Only the pods that are actually unhappy. A Running pod's logs are not why the Application
		// is Degraded, and dumping them would bury the one that is.
		if phase == "Running" && !strings.Contains(line, "false") {
			continue
		}
		if shown >= maxPods {
			fmt.Fprintf(&b, "… more unhealthy pods not dumped\n")
			break
		}
		shown++
		if ev, err := run(30*time.Second, "describe", "pod", "-n", ns, pod); err == nil {
			// Only the Events block: a full describe is mostly the spec, which the Application
			// already showed.
			if i := strings.Index(ev, "Events:"); i >= 0 {
				fmt.Fprintf(&b, "\n  events for %s/%s:\n%s\n", ns, pod, ev[i:])
			}
		}
		if logs, err := run(30*time.Second, "logs", "-n", ns, pod, "--all-containers", "--tail", maxLogLines); err == nil && strings.TrimSpace(logs) != "" {
			fmt.Fprintf(&b, "\n  last %s log lines for %s/%s:\n%s\n", maxLogLines, ns, pod, logs)
		}
	}
	if shown == 0 {
		// Every pod is Running and ready, yet ArgoCD calls the Application Degraded. That is a real
		// and quite different finding — the health is coming from something other than pod
		// readiness — and saying so is more useful than printing nothing.
		fmt.Fprintf(&b, "  every pod is Running and ready — the Degraded health is NOT pod readiness\n")
	}
	return b.String()
}

// outOfSyncRef identifies one OutOfSync resource well enough to fetch it from the cluster.
type outOfSyncRef struct {
	Group     string
	Kind      string
	Name      string
	Namespace string
}

// kubectlTarget renders the ref as a `kubectl get` argument. The group is included when present so
// a CustomResourceDefinition is not confused with some other Kind of the same name.
func (r outOfSyncRef) kubectlTarget() string {
	if r.Group == "" {
		return strings.ToLower(r.Kind) + "/" + r.Name
	}
	return strings.ToLower(r.Kind) + "." + r.Group + "/" + r.Name
}

// dumpOutOfSyncResources fetches each OutOfSync resource and names the FIELDS the chart did not
// author, by reading server-side-apply FIELD OWNERSHIP rather than dumping the object.
//
// WHY OWNERSHIP AND NOT THE OBJECT. The previous version printed the live object, on the reasoning
// that an API-server-defaulted field would be visible in it. It is — but only to a reader who
// already knows which field to look for, and the objects are large: hetzner/addons run 32949217522
// dumped five CustomResourceDefinitions, each truncated at 3000 bytes inside its `spec.versions`
// openAPIV3Schema, and named no field on any of them. It cost a real run and answered nothing.
//
// Every Application here syncs with ServerSideApply=true, and that is what makes ownership readable:
// the apiserver records, per field, WHICH MANAGER set it. A field ArgoCD applied is owned by the
// ArgoCD controller. A field ArgoCD did NOT apply — a defaulted value, or one a controller wrote
// back — is owned by somebody else, and those are exactly the candidates for an ignoreDifferences
// entry. So the question "which field did the chart not author?" has a direct answer in
// `.metadata.managedFields`, and it needs only kubectl: no ArgoCD API, no session token, no
// port-forward, none of which the harness has.
//
// It NARROWS the candidates; it does not prove the diff. A field ArgoCD does not own is not
// automatically the one ArgoCD is complaining about. That is why the output is labelled as
// candidates, and why an ignore is still a deliberate decision — an ignore guessed onto a kind can
// hide genuine drift, which is the one thing this class must not do.
//
// Best-effort and hard-capped: this runs on an ALREADY-FAILING path, so it must never be the reason
// a run hangs or an error is lost.
func dumpOutOfSyncResources(ctx context.Context, kubeconfigPath string, refs []outOfSyncRef) string {
	const (
		maxResources = 8
		maxPathsPer  = 12
	)
	if len(refs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n  fields the chart did NOT author, by server-side-apply ownership")
	b.WriteString("\n  (candidates for an ignoreDifferences entry — narrowing, not proof):")
	shown := 0
	for _, r := range refs {
		if shown >= maxResources {
			fmt.Fprintf(&b, "\n    … %d more not shown", len(refs)-shown)
			break
		}
		shown++
		args := []string{"--kubeconfig", kubeconfigPath, "get", r.kubectlTarget(), "-o", "json"}
		if r.Namespace != "" {
			args = append(args, "-n", r.Namespace)
		}
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		out, err := exec.CommandContext(cctx, "kubectl", args...).Output()
		cancel()
		if err != nil {
			// Naming the failure matters as much as the dump: "could not read it" and "it had
			// nothing interesting" must not look the same.
			fmt.Fprintf(&b, "\n    - %s: could not fetch (%v)", r.kubectlTarget(), err)
			continue
		}
		byManager, perr := foreignFieldOwners(out)
		if perr != nil {
			fmt.Fprintf(&b, "\n    - %s: could not read managedFields (%v)", r.kubectlTarget(), perr)
			continue
		}
		if len(byManager) == 0 {
			// A DIFFERENT fact from "we could not tell", and it must read differently: every field
			// on this object belongs to ArgoCD, so an apiserver default is not the explanation here
			// and the cause is elsewhere.
			fmt.Fprintf(&b, "\n    - %s: every field is ArgoCD-owned — no foreign default to blame", r.kubectlTarget())
			continue
		}
		fmt.Fprintf(&b, "\n    - %s:", r.kubectlTarget())
		for _, m := range sortedManagers(byManager) {
			paths := byManager[m]
			sort.Strings(paths)
			if len(paths) > maxPathsPer {
				paths = append(paths[:maxPathsPer:maxPathsPer], fmt.Sprintf("…%d more", len(byManager[m])-maxPathsPer))
			}
			fmt.Fprintf(&b, "\n        owned by %q: %s", m, strings.Join(paths, ", "))
		}
	}
	return b.String()
}

// argoFieldManagers are the manager names ArgoCD applies under. A field owned by one of these was
// authored by the chart, so it is NOT a candidate.
//
// Matched as a SUBSTRING, deliberately: ArgoCD's manager name has varied across versions
// (`argocd-controller`, `argocd-application-controller`, and a `argocd-controller-ssa` variant on
// the server-side-apply path), and this runs on a failing path where a missed match would print a
// misleading candidate rather than fail loudly.
var argoFieldManagers = []string{"argocd"}

// foreignFieldOwners returns manager → the field paths that manager owns, for every manager that is
// NOT ArgoCD. Paths are rendered dotted, from the apiserver's `f:`-prefixed fieldsV1 tree.
func foreignFieldOwners(objJSON []byte) (map[string][]string, error) {
	var obj struct {
		Metadata struct {
			ManagedFields []struct {
				Manager  string          `json:"manager"`
				FieldsV1 json.RawMessage `json:"fieldsV1"`
			} `json:"managedFields"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, mf := range obj.Metadata.ManagedFields {
		if isArgoManager(mf.Manager) {
			continue
		}
		var tree map[string]json.RawMessage
		if err := json.Unmarshal(mf.FieldsV1, &tree); err != nil {
			continue
		}
		paths := flattenFieldsV1(tree, "")
		if len(paths) > 0 {
			out[mf.Manager] = append(out[mf.Manager], paths...)
		}
	}
	return out, nil
}

// isArgoManager reports whether a field manager is ArgoCD's.
func isArgoManager(name string) bool {
	lower := strings.ToLower(name)
	for _, m := range argoFieldManagers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

// flattenFieldsV1 turns the apiserver's fieldsV1 tree into dotted paths.
//
// The encoding: a key is `f:<field>` for a field, `k:{...}` / `i:<n>` / `v:<x>` for a list entry,
// and the bare `.` marks "this node itself is owned". Leaf `.` keys are dropped rather than rendered
// as a trailing dot, because `.spec.replicas.` is not a path anyone can act on.
func flattenFieldsV1(tree map[string]json.RawMessage, prefix string) []string {
	var paths []string
	for key, raw := range tree {
		// `.` means the node at `prefix` is itself owned; it adds no new path.
		if key == "." {
			continue
		}
		var seg string
		switch {
		case strings.HasPrefix(key, "f:"):
			seg = prefix + "." + strings.TrimPrefix(key, "f:")
		default:
			// A list-entry selector (k:/i:/v:). Keep it verbatim inside brackets: which ELEMENT
			// differs is often the whole answer on a containers[] or versions[] list.
			seg = prefix + "[" + key + "]"
		}
		var child map[string]json.RawMessage
		if err := json.Unmarshal(raw, &child); err != nil || len(child) == 0 {
			paths = append(paths, seg)
			continue
		}
		sub := flattenFieldsV1(child, seg)
		if len(sub) == 0 {
			paths = append(paths, seg)
			continue
		}
		paths = append(paths, sub...)
	}
	return paths
}

// sortedManagers returns the manager names in order, so the dump is stable run to run — an unstable
// dump makes two runs look different when nothing changed.
func sortedManagers(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// refsForLosers collects the OutOfSync resource refs belonging to the failing Applications, so the
// dump covers exactly the losers and not the whole cluster.
//
// DEDUPLICATED, and it matters more than it looks. Cluster-scoped objects — a CustomResourceDefinition
// most of all — can be reported OutOfSync under MORE THAN ONE Application, and the dump is capped at
// maxResources. hetzner/addons run 32949217522 had exactly 8 losers against a cap of 8, five of them
// argo-rollouts CRDs: a single duplicate would have pushed a genuine object behind
// "… 1 more not shown" and cost that run an answer, which is the same way the previous dump failed.
//
// Order is preserved (first occurrence wins) so the output still follows the loser order a reader
// sees above it, rather than an arbitrary map order.
func refsForLosers(observed map[string]argoAppState, losers []string) []outOfSyncRef {
	var refs []outOfSyncRef
	seen := map[outOfSyncRef]bool{}
	for _, name := range losers {
		for _, r := range observed[name].OutOfSyncRefs {
			if seen[r] {
				continue
			}
			seen[r] = true
			refs = append(refs, r)
		}
	}
	return refs
}

// describeManagedWorkloads reports the workload-bearing resources an Application says it manages,
// so "no pods" can be read correctly rather than assumed.
//
// It exists because "no pods matched my selector" is a statement about the SELECTOR as much as about
// the cluster, and a dump that cannot tell those apart will eventually blame a chart for a harness
// bug. ArgoCD's `.status.resources` is what it believes it created, so:
//
//	a DaemonSet/Deployment IS listed, and no pods    → the workload exists and produced none. Real.
//	nothing workload-bearing is listed               → the chart rendered none. Also real, different.
//	resources listed but the selector found nothing  → suspect the SELECTOR, not the chart.
//
// Best-effort on an already-failing path: an error is reported as an inability to check, never as an
// absence.
func describeManagedWorkloads(ctx context.Context, kubeconfigPath, app string) string {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", app,
		"-o", "jsonpath={range .status.resources[*]}{.kind}/{.name} {.health.status}{\"\\n\"}{end}",
	).Output()
	if err != nil {
		return fmt.Sprintf("\n  (could not read what %s manages: %v — so whether the workload exists is UNKNOWN)", app, err)
	}

	var workloads []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// The kinds that produce pods. A ConfigMap telling us nothing is noise on a failing path.
		for _, kind := range []string{"DaemonSet/", "Deployment/", "StatefulSet/", "Job/", "CronJob/", "ReplicaSet/"} {
			if strings.HasPrefix(line, kind) {
				workloads = append(workloads, line)
				break
			}
		}
	}

	if len(workloads) == 0 {
		return "\n  ArgoCD lists NO workload-bearing resource for this Application — the chart rendered none," +
			"\n  so there is nothing to produce a pod. Not a scheduling problem."
	}
	sort.Strings(workloads)
	return fmt.Sprintf("\n  but ArgoCD says it manages %d workload(s), so either they produced no pods or this"+
		"\n  selector is wrong — check the label before blaming the chart:\n    %s",
		len(workloads), strings.Join(workloads, "\n    "))
}
