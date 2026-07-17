// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// applyByoChartBindings resolves each BYO chart workload's W3 bindings (W5 Lane 2b) against the
// provision's tofu `outputs` and writes them into the chart's Values BEFORE its Application renders:
// a non-secret facet (endpoint/port) becomes a literal at its value-path; a credential facet becomes
// a keyless `existingSecret` reference backed by a runner-seeded ExternalSecret applied pre-sync via
// direct kubectl apply (the hardened BYO AppProject forbids namespaced CRs through ArgoCD, so the
// same pattern as EnsureAddOnSecrets is used). Never inlines a plaintext credential; a facet that
// can't be resolved keylessly is logged and skipped, never referenced. Non-fatal — a bad binding
// must not fail an otherwise-healthy deploy. Mutates each addon's Values in place.
// Returns the names of the binding ExternalSecrets it successfully applied — the desired set the
// caller passes to argocd.PruneChartBindingSecrets so a removed binding's Secret is swept.
func applyByoChartBindings(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, stdout, stderr io.Writer) []string {
	// The pure renderer resolves endpoints from string outputs (a database's endpoint, etc.).
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}
	var applied []string
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
				w.Name, w.Bindings, w.ValuePaths, strOutputs, provider, a.Namespace,
			)
			for path, val := range res.Patches {
				manifests.SetByPath(a.Values, path, val)
			}
			for _, knob := range res.Unsatisfied {
				fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (no value-path or no keyless secret) — not written.\n", a.ID, w.Name, knob)
			}
			for _, es := range res.ExternalSecrets {
				// Mark it so PruneChartBindingSecrets can find + sweep it when the binding is removed
				// (it is applied outside ArgoCD, so nothing else prunes it).
				es.Labels = map[string]string{argocd.ByoBindingSecretLabel: "true"}
				yaml, skipped, err := manifests.RenderExternalSecret(es)
				if err != nil {
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
					fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret apply failed (%s/%s): %v\n", a.ID, w.Name, err)
					continue
				}
				applied = append(applied, manifests.BindingSecretName(es.ServiceName, es.Target))
			}
		}
	}
	return applied
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

	// Hardened AppProject locked to the BYO repos + namespaces.
	if proj, err := argocd.RenderByoAppProject(projName, repos, namespaces, commonLabels); err != nil {
		fmt.Fprintf(stderr, "Warning: could not render BYO AppProject %s: %v\n", projName, err)
	} else if err := argocd.ApplyManifest(proj, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: could not apply BYO AppProject %s (charts will not sync until it exists): %v\n", projName, err)
	}

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
			fmt.Fprintf(stderr, "Warning: could not configure credentials for BYO repo %s: %v\n", repo, err)
		}
	}
	return true
}
