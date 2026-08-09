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
	for {
		raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
		if err != nil {
			// A read hiccup (apiserver blip, CRD not yet registered) is retried until the
			// deadline — unlike ReadAddOnHealth's best-effort Unknown, a persistent failure
			// here must FAIL, not soften.
			lastErr = fmt.Errorf("listing ArgoCD Applications failed: %w", err)
			lastLosers = nil
		} else if observed, perr := parseArgoApps(raw); perr != nil {
			lastErr = fmt.Errorf("parsing ArgoCD Applications failed: %w", perr)
			lastLosers = nil
		} else {
			losers, everr := evaluateArgoApps(observed, expected)
			if everr == nil {
				return nil
			}
			lastErr, lastLosers = everr, losers
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ArgoCD Applications did not all reach Healthy+Synced within %s:\n%v%s",
				timeout, lastErr, describeArgoApps(ctx, kubeconfigPath, lastLosers))
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
	}
	return b.String()
}
