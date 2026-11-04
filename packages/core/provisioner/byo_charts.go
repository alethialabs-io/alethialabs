// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoBindingState is what one deploy knows about its BYO chart binding ExternalSecrets, gathered by
// applyByoChartBindings and consumed by pruneByoChartBindings.
type byoBindingState struct {
	// Owner is the environment's owner-label value, stamped on every binding ExternalSecret and the
	// only owner the prune will delete for. Empty when the environment has no ID.
	Owner string
	// Declared is every binding ExternalSecret the configuration DECLARES — one per (chart namespace,
	// workload, bound target) with at least one credential facet — whether or not it rendered or
	// applied on this run. It is the prune's keep set.
	Declared []argocd.BindingSecretRef
	// Namespaces are the namespaces of every add-on that is a BYO chart or describes a workload —
	// where a binding lives or recently lived. The prune adds the namespaces carrying the owner label.
	Namespaces []string
	// Failures counts the binding ExternalSecrets that failed to render or apply on this run. Any
	// failure skips the prune for the whole deploy.
	Failures int
}

// byoBindingOwner is the environment's owner-label value: the same rendering of the environment ID
// that cloud.ClassificationLabels stamps on the BYO namespaces the runner creates, so the namespace
// lookup and the ExternalSecret selector agree by construction.
func byoBindingOwner(vc *types.ProjectConfig) string {
	return cloud.ClassificationLabels(vc)[argocd.ByoBindingOwnerLabel]
}

// keylessDBAuthEnabled is the keyless per-cloud DB auth flag (#722), dark by default. The service
// lane (generateAppManifests) and the BYO binding lane both read it here, so they cannot disagree.
func keylessDBAuthEnabled() bool {
	return os.Getenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED") == "true"
}

// serviceBindingSecretNames are the binding Secret names the first-class service lane renders into
// appNamespace: one per (service, bound target), the names writeBindingExternalSecrets and the
// workload's secretKeyRef use. Over-approximated on purpose (every bound target, credential facet or
// not), so a BYO binding can only be refused too often, never allowed onto a service's object.
func serviceBindingSecretNames(vc *types.ProjectConfig) map[string]bool {
	out := map[string]bool{}
	for _, s := range vc.Services {
		for _, b := range s.Bindings {
			out[manifests.BindingSecretName(s.Name, b.Target)] = true
		}
	}
	return out
}

// byoBindingPolicy is the resolver policy for one add-on in namespace ns (already defaulted).
func byoBindingPolicy(vc *types.ProjectConfig, ns, owner string, keylessOn bool) manifests.ChartBindingPolicy {
	p := manifests.ChartBindingPolicy{KeylessDBAuth: keylessOn}
	if owner == "" {
		p.CredentialRefusal = "the environment has no ID, so its binding ExternalSecret could not carry an owner label and could never be pruned — not applied"
	}
	if ns == appNamespace {
		p.TakenSecretNames = serviceBindingSecretNames(vc)
	}
	return p
}

// declaredByoBindings returns the binding ExternalSecrets vc declares and the namespaces the prune
// should look in, read from the configuration alone — no tofu output, render or apply result enters it, so a
// binding that failed on this run is still declared and still kept. A binding to a keyless database
// (keylessOn) declares no ExternalSecret: it gets no password secret, so any earlier one is not kept.
func declaredByoBindings(vc *types.ProjectConfig, keylessOn bool) ([]argocd.BindingSecretRef, []string) {
	var refs []argocd.BindingSecretRef
	var namespaces []string
	seenNS := map[string]bool{}
	for _, a := range vc.AddOns {
		if len(a.Workloads) == 0 && !a.IsGitSource() {
			continue
		}
		ns := a.Namespace
		if ns == "" {
			ns = "default" // the renderer's default, so the ref names the object it creates
		}
		// The namespace is looked in even when no binding is declared there any more: that is
		// exactly the case of a binding just removed from a chart that is still installed.
		if !seenNS[ns] {
			seenNS[ns] = true
			namespaces = append(namespaces, ns)
		}
		for _, w := range a.Workloads {
			for _, b := range w.Bindings {
				if len(manifests.CredentialFacetNames(b)) == 0 {
					continue
				}
				if keylessOn && manifests.KeylessDBTarget(b.Target, vc.Databases) {
					continue
				}
				refs = append(refs, argocd.BindingSecretRef{Namespace: ns, Name: manifests.BindingSecretName(w.Name, b.Target)})
			}
		}
	}
	return refs, namespaces
}

// applyByoChartBindings resolves each BYO chart workload's W3 bindings (W5 Lane 2b) against the
// provision's tofu `outputs` and writes them into the chart's Values BEFORE its Application renders:
// a non-secret facet (endpoint/port) becomes a literal at its value-path; a credential facet becomes
// a keyless `existingSecret` reference backed by a runner-seeded ExternalSecret applied pre-sync via
// direct kubectl apply (the hardened BYO AppProject forbids namespaced CRs through ArgoCD, so the
// same pattern as EnsureAddOnSecrets is used). Never inlines a plaintext credential; a facet that
// can't be resolved keylessly is logged and skipped, never referenced. Non-fatal — a bad binding
// must not fail an otherwise-healthy deploy. Mutates each addon's Values in place.
//
// Each ExternalSecret carries the binding marker and the environment's owner label. The returned
// state carries the DECLARED bindings (the prune's keep set) and how many failed on this run.
func applyByoChartBindings(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, stdout, stderr io.Writer) byoBindingState {
	return applyByoChartBindingsExcept(vc, outputs, provider, nil, stdout, stderr)
}

// applyByoChartBindingsExcept is applyByoChartBindings that writes NOTHING for the add-on ids in
// skip — the BYO charts configureByoCharts refused, whose namespace the runner must not write into.
// Their bindings stay DECLARED (the keep set is read from the whole configuration), so the prune
// leaves any binding an earlier deploy applied for them in place rather than deleting it.
func applyByoChartBindingsExcept(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, skip map[string]bool, stdout, stderr io.Writer) byoBindingState {
	keylessOn := keylessDBAuthEnabled()
	st := byoBindingState{Owner: byoBindingOwner(vc)}
	st.Declared, st.Namespaces = declaredByoBindings(vc, keylessOn)

	// The pure renderer resolves endpoints from string outputs (a database's endpoint, etc.).
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}
	for i := range vc.AddOns {
		a := &vc.AddOns[i]
		if len(a.Workloads) == 0 || (a.IsGitSource() && skip[a.ID]) {
			continue
		}
		if a.Values == nil {
			a.Values = map[string]interface{}{}
		}
		ns := a.Namespace
		if ns == "" {
			ns = "default" // the renderer's default
		}
		policy := byoBindingPolicy(vc, ns, st.Owner, keylessOn)
		for _, w := range a.Workloads {
			res := manifests.ResolveChartWorkloadBindings(
				w.Name, w.Bindings, w.ValuePaths, strOutputs, provider, a.Namespace, vc.Databases, policy,
			)
			for path, val := range res.Patches {
				manifests.SetByPath(a.Values, path, val)
			}
			for _, knob := range res.Unsatisfied {
				if reason := res.UnsatisfiedReasons[knob]; reason != "" {
					fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (%s) — not written.\n", a.ID, w.Name, knob, reason)
					continue
				}
				fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (no value-path or no keyless secret) — not written.\n", a.ID, w.Name, knob)
			}
			for _, es := range res.ExternalSecrets {
				// Mark it so PruneChartBindingSecrets can find + sweep it when the binding is removed
				// (it is applied outside ArgoCD, so nothing else prunes it), and name its owner so a
				// prune run by any OTHER environment on a shared host never selects it.
				// The owner is never empty here: an ownerless environment's credential facets are
				// refused by the policy, so no ExternalSecret is ever rendered without one.
				es.Labels = map[string]string{argocd.ByoBindingSecretLabel: "true", argocd.ByoBindingOwnerLabel: st.Owner}
				yaml, skipped, err := manifests.RenderExternalSecret(es)
				if err != nil {
					st.Failures++
					fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret render failed (%s/%s): %v\n", a.ID, w.Name, err)
					continue
				}
				for _, reason := range skipped {
					fmt.Fprintf(stdout, "BYO binding facet skipped (%s/%s): %s\n", a.ID, w.Name, reason)
				}
				if yaml == "" {
					continue
				}
				if err := argocd.ApplyManifest(yaml, stdout, stderr); err != nil {
					st.Failures++
					fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret apply failed (%s/%s): %v\n", a.ID, w.Name, err)
					continue
				}
			}
		}
	}
	return st
}

// pruneByoChartBindings sweeps the environment's binding ExternalSecrets that its configuration no
// longer declares. It is skipped outright when any binding failed to render or apply on this run:
// that deploy's view of the bindings is incomplete, and a live binding must never be removed
// because one run could not re-apply it. It is also skipped when the environment has no owner
// label to scope by.
func pruneByoChartBindings(st byoBindingState, stdout, stderr io.Writer) {
	if st.Failures > 0 {
		fmt.Fprintf(stderr, "Warning: skipping the BYO binding ExternalSecret prune: %d binding(s) failed to render or apply on this deploy\n", st.Failures)
		return
	}
	argocd.PruneChartBindingSecrets(st.Owner, st.Namespaces, st.Declared, stdout, stderr)
}

// byoRefusal is one BYO chart the runner declined to configure on this deploy, and why.
type byoRefusal struct {
	// ID is the add-on id; the chart's Application name is argocd.AddOnAppName(ID).
	ID string
	// Namespace is the destination the chart asked for ("" already defaulted to "default").
	Namespace string
	// Reason is the validator's refusal, naming the namespace.
	Reason string
}

// warning is the deploy warning the console's Deploy tab shows for this refusal: what was not
// deployed, why, and what the user changes. It carries no secret — an id, a namespace and the
// validator's text, which echoes only the namespace.
func (r byoRefusal) warning() string {
	return fmt.Sprintf("BYO chart %q was not deployed: %s. Its existing Application and workloads were left in place, "+
		"but they can no longer sync. Attach the chart again with a namespace of your own.", r.ID, r.Reason)
}

// byoRefusedIDs is the set of refused add-on ids, for the filters below.
func byoRefusedIDs(refused []byoRefusal) map[string]bool {
	out := make(map[string]bool, len(refused))
	for _, r := range refused {
		out[r.ID] = true
	}
	return out
}

// withoutByoRefusals returns the add-ons a deploy may RENDER, APPLY or seed into: every add-on
// except the refused BYO charts. It is deliberately NOT what the prune is given — see deploy.go: a
// refused chart stays in the prune's keep list, so its live Application is left alone rather than
// deleted (with the resources-finalizer cascade) as a "disabled" add-on.
func withoutByoRefusals(addons []types.AddOnInstall, refused []byoRefusal) []types.AddOnInstall {
	if len(refused) == 0 {
		return addons
	}
	skip := byoRefusedIDs(refused)
	out := make([]types.AddOnInstall, 0, len(addons))
	for _, a := range addons {
		if a.IsGitSource() && skip[a.ID] {
			continue
		}
		out = append(out, a)
	}
	return out
}

// prepareByoCharts is configureByoCharts for callers that only need to know whether any BYO chart
// was configured.
func prepareByoCharts(vc *types.ProjectConfig, token string, repoTokens map[string]string, commonLabels map[string]string, stdout, stderr io.Writer) bool {
	configured, _ := configureByoCharts(vc, token, repoTokens, commonLabels, stdout, stderr)
	return configured
}

// configureByoCharts sets up the trust boundary for bring-your-own (git-source) charts BEFORE the
// add-on renderer applies their ArgoCD Applications:
//  1. pins every BYO chart to a hardened, per-project "byo-<slug>" AppProject (mutating vc.AddOns
//     in place so RenderManagedAddOns places them there);
//  2. REFUSES, per chart, every chart whose namespace argocd.ValidateByoNamespace refuses — malformed,
//     or reserved for the platform (#6439) — and returns those refusals;
//  3. renders + applies that AppProject, locked to exactly the ACCEPTED charts' repos + namespaces
//     (default-deny cluster-scoped resources);
//  4. registers a per-repo ArgoCD repository credential for each accepted chart's repo (isolated
//     Secret names so no BYO Application can read the apps repo's — or another tenant's — token).
//
// # Why per chart, and why the AppProject is re-applied even when every chart is refused (#6439)
//
// A refusal used to abandon the whole stage, which had two defects. One legacy chart froze the
// AppProject for every other chart in the project. And the AppProject an EARLIER deploy applied —
// still listing the now-refused destination — was left exactly as it was, while the refused chart's
// Application was rendered and applied regardless, so it went on syncing into that namespace. Now
// the AppProject is always re-applied from the accepted charts alone (kubectl apply of a custom
// resource replaces the `destinations` list wholesale), which is what makes ArgoCD refuse any further
// sync into a refused namespace; and the caller drops each refused chart from the render. Nothing
// live is deleted: the refused chart stays in the prune's keep list.
//
// Marketplace (Helm-registry) add-ons are untouched: they keep Source=="" → the "infra" project.
// Best-effort like the rest of the add-on path — a failure here surfaces as an un-synced
// Application (fail-closed: no credential / no project ⇒ the chart simply doesn't deploy), never a
// failed cluster. Returns whether any BYO chart was configured, and the refusals. commonLabels are
// the classification/sweep labels stamped onto the AppProject (BYOC B1.4); the BYO chart
// Applications themselves are labelled by RenderManagedAddOns.
// repoTokens maps a chart repo URL → its git token (for BYO charts on a different provider than the
// apps-destination repo); token is the fallback used when a repo has no dedicated entry.
func configureByoCharts(vc *types.ProjectConfig, token string, repoTokens map[string]string, commonLabels map[string]string, stdout, stderr io.Writer) (bool, []byoRefusal) {
	projName := argocd.ByoProjectName(vc.ProjectName)

	var repos, namespaces []string
	var refused []byoRefusal
	hasByo := false
	for i := range vc.AddOns {
		if !vc.AddOns[i].IsGitSource() {
			continue
		}
		hasByo = true
		// Pin the Application to the hardened project (the console leaves Project empty). A refused
		// chart is pinned too: if anything ever did render it, it would land in the hardened project,
		// never the wide-open default one.
		vc.AddOns[i].Project = projName
		ns := vc.AddOns[i].Namespace
		if ns == "" {
			ns = "default"
		}
		if err := argocd.ValidateByoNamespace(ns); err != nil {
			fmt.Fprintf(stderr, "Error: refusing to configure BYO charts: chart %q: %v\n", vc.AddOns[i].ID, err)
			refused = append(refused, byoRefusal{ID: vc.AddOns[i].ID, Namespace: ns, Reason: err.Error()})
			continue
		}
		repos = append(repos, vc.AddOns[i].ChartRepo)
		namespaces = append(namespaces, ns)
	}
	if !hasByo {
		return false, nil
	}

	fmt.Fprintf(stdout, "Configuring %d bring-your-own chart(s) under hardened project %q (%d refused)\n", len(repos), projName, len(refused))

	// The destination namespaces, created by the RUNNER because the chart cannot create them.
	//
	// The Application carries `CreateNamespace=true`, but the hardened AppProject below has an empty
	// clusterResourceWhitelist and a Namespace is cluster-scoped — so ArgoCD is asked to create a
	// namespace it is forbidden to create, and the sync dies with `namespaces "<ns>" not found`,
	// health=Missing, forever. Creating them here (trusted runner, admin kubeconfig) is what makes
	// the hardening and the sync option coexist; it does not widen what the chart may do.
	//
	// Every namespace here has already passed the validator above, so a render error is not expected;
	// it is still not fail-soft (#2540): falling through would apply an AppProject built from a value
	// the renderer declined.
	if ns, err := argocd.RenderByoNamespaces(namespaces, commonLabels); err != nil {
		fmt.Fprintf(stderr, "Error: refusing to configure BYO charts: %v\n", err)
		return false, refused
	} else if ns != "" {
		if err := argocd.ApplyManifest(ns, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not create BYO namespace(s) %s — a chart targeting one will fail its sync with `namespaces not found`: %v\n",
				strings.Join(namespaces, ", "), err)
		}
	}

	// Hardened AppProject locked to the ACCEPTED repos + namespaces — applied even when that is none,
	// so a destination an earlier deploy granted is withdrawn (see the doc comment).
	if proj, err := argocd.RenderByoAppProject(projName, repos, namespaces, commonLabels); err != nil {
		fmt.Fprintf(stderr, "Warning: could not render BYO AppProject %s: %v\n", projName, err)
	} else if err := argocd.ApplyManifest(proj, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: could not apply BYO AppProject %s (charts will not sync until it exists): %v\n", projName, err)
	}

	// Every git token in play (shared + per-repo) — used to redact any of them from the credential
	// error text before it reaches the job log; the runner's metadata scrub is key-based and a
	// kubectl/git failure can echo a tokened URL (#948).
	allTokens := gitTokenValues(token, repoTokens)

	// Per-repo credentials. Each repo prefers its own token (repoTokens[repo], set when the chart
	// lives on a different provider than the apps-destination repo) and falls back to the shared
	// token. Without any token a private BYO Application can't clone — warn (public charts still
	// work) but don't fail the deploy.
	seen := map[string]bool{}
	for _, repo := range repos {
		if repo == "" || seen[repo] {
			continue
		}
		seen[repo] = true
		repoToken := repoTokens[repo]
		if repoToken == "" {
			repoToken = token
		}
		if repoToken == "" {
			fmt.Fprintf(stderr, "Warning: no git access token for BYO repo %s — a private chart there will fail to sync (reconnect the git provider)\n", repo)
			continue
		}
		if err := argocd.ConfigureRepoCredentialsNamed(repo, repoToken, argocd.ByoRepoSecretName(repo), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not configure credentials for BYO repo %s: %s\n", repo, argocd.RedactTokens(err.Error(), allTokens...))
		}
	}
	return len(repos) > 0, refused
}
