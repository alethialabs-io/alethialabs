// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

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
func prepareByoCharts(vc *types.ProjectConfig, token string, commonLabels map[string]string, stdout, stderr io.Writer) bool {
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

	// Per-repo credentials. Without a token, BYO Applications can't clone private repos — warn
	// (public charts still work) but don't fail the deploy.
	if token == "" {
		fmt.Fprintln(stderr, "Warning: no git access token — private BYO chart repos will fail to sync (reconnect the git provider)")
		return true
	}
	seen := map[string]bool{}
	for _, repo := range repos {
		if repo == "" || seen[repo] {
			continue
		}
		seen[repo] = true
		if err := argocd.ConfigureRepoCredentialsNamed(repo, token, argocd.ByoRepoSecretName(repo), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not configure credentials for BYO repo %s: %v\n", repo, err)
		}
	}
	return true
}
