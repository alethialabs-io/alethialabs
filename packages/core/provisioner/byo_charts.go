// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
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

// declaredByoBindings returns the binding ExternalSecrets vc declares and the namespaces the prune
// should look in, read from the configuration alone — no tofu output, render or apply result enters it, so a
// binding that failed on this run is still declared and still kept.
func declaredByoBindings(vc *types.ProjectConfig) ([]argocd.BindingSecretRef, []string) {
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
	st := byoBindingState{Owner: byoBindingOwner(vc)}
	st.Declared, st.Namespaces = declaredByoBindings(vc)

	// The pure renderer resolves endpoints from string outputs (a database's endpoint, etc.).
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}
	for i := range vc.AddOns {
		a := &vc.AddOns[i]
		if len(a.Workloads) == 0 {
			continue
		}
		if a.Values == nil {
			a.Values = map[string]interface{}{}
		}
		for _, w := range a.Workloads {
			res := manifests.ResolveChartWorkloadBindings(
				w.Name, w.Bindings, w.ValuePaths, strOutputs, provider, a.Namespace, vc.Databases,
			)
			for path, val := range res.Patches {
				manifests.SetByPath(a.Values, path, val)
			}
			for _, knob := range res.Unsatisfied {
				fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (no value-path or no keyless secret) — not written.\n", a.ID, w.Name, knob)
			}
			for _, es := range res.ExternalSecrets {
				// Mark it so PruneChartBindingSecrets can find + sweep it when the binding is removed
				// (it is applied outside ArgoCD, so nothing else prunes it), and name its owner so a
				// prune run by any OTHER environment on a shared host never selects it.
				es.Labels = map[string]string{argocd.ByoBindingSecretLabel: "true"}
				if st.Owner != "" {
					es.Labels[argocd.ByoBindingOwnerLabel] = st.Owner
				}
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

// prepareByoCharts sets up the trust boundary for bring-your-own (git-source) charts BEFORE the
// add-on renderer applies their ArgoCD Applications:
//  1. pins every BYO chart to a hardened, per-project "byo-<slug>" AppProject (mutating vc.AddOns
//     in place so RenderManagedAddOns places them there);
//  2. renders + applies that AppProject, locked to exactly the BYO chart repos + namespaces
//     (default-deny cluster-scoped resources);
//  3. registers a per-repo ArgoCD repository credential for each BYO repo (isolated Secret names
//     so no BYO Application can read the apps repo's — or another tenant's — token).
//
// Marketplace (Helm-registry) add-ons are untouched: they keep Source=="" → the "infra" project.
// Best-effort like the rest of the add-on path — a failure here surfaces as an un-synced
// Application (fail-closed: no credential / no project ⇒ the chart simply doesn't deploy), never a
// failed cluster. Returns whether any BYO charts were present (for logging). commonLabels are the
// classification/sweep labels stamped onto the AppProject (BYOC B1.4); the BYO chart Applications
// themselves are labelled by RenderManagedAddOns.
// repoTokens maps a chart repo URL → its git token (for BYO charts on a different provider than the
// apps-destination repo); token is the fallback used when a repo has no dedicated entry.
func prepareByoCharts(vc *types.ProjectConfig, token string, repoTokens map[string]string, commonLabels map[string]string, stdout, stderr io.Writer) bool {
	projName := argocd.ByoProjectName(vc.ProjectName)

	var repos, namespaces []string
	hasByo := false
	for i := range vc.AddOns {
		if !vc.AddOns[i].IsGitSource() {
			continue
		}
		hasByo = true
		// Pin the Application to the hardened project (the console leaves Project empty).
		vc.AddOns[i].Project = projName
		repos = append(repos, vc.AddOns[i].ChartRepo)
		ns := vc.AddOns[i].Namespace
		if ns == "" {
			ns = "default"
		}
		namespaces = append(namespaces, ns)
	}
	if !hasByo {
		return false
	}

	fmt.Fprintf(stdout, "Configuring %d bring-your-own chart(s) under hardened project %q\n", len(repos), projName)

	// The destination namespaces, created by the RUNNER because the chart cannot create them.
	//
	// The Application carries `CreateNamespace=true`, but the hardened AppProject below has an empty
	// clusterResourceWhitelist and a Namespace is cluster-scoped — so ArgoCD is asked to create a
	// namespace it is forbidden to create, and the sync dies with `namespaces "<ns>" not found`,
	// health=Missing, forever. Creating them here (trusted runner, admin kubeconfig) is what makes
	// the hardening and the sync option coexist; it does not widen what the chart may do.
	//
	// Fail-soft like everything else in this stage: a namespace we could not create surfaces as an
	// unhealthy Application in the console, which is honest, rather than failing a good cluster.
	// NOT fail-soft, unlike everything else in this stage (#2540). A namespace we could not CREATE
	// still leaves a legible unhealthy Application, so warning is right there. A namespace the
	// renderer REFUSES is a different thing: the configuration itself is rejected, and falling
	// through applied the hardened AppProject built from the very value we just declined — which is
	// how the validator added in #2576 came to gate nothing. Refuse the stage instead.
	if ns, err := argocd.RenderByoNamespaces(namespaces, commonLabels); err != nil {
		fmt.Fprintf(stderr, "Error: refusing to configure BYO charts: %v\n", err)
		return false
	} else if ns != "" {
		if err := argocd.ApplyManifest(ns, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not create BYO namespace(s) %s — a chart targeting one will fail its sync with `namespaces not found`: %v\n",
				strings.Join(namespaces, ", "), err)
		}
	}

	// Hardened AppProject locked to the BYO repos + namespaces.
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
	return true
}
