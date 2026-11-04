// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/selfimage"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// addOnStageInput is what the add-on stage reads from RunDeployV2.
type addOnStageInput struct {
	VC                *types.ProjectConfig
	Facts             *argocd.InfraFacts
	Outputs           map[string]interface{}
	Provider          string
	GitAccessToken    string
	GitRepoTokens     map[string]string
	AddOnSecretValues map[string]map[string]string
	// Refresh re-mints the cluster credential before a long wait (deployKubeRefresher.refresh). It is
	// called before the wave apply and before the health wait, the two long waits in this stage.
	Refresh func(ctx context.Context, step string) error
}

// addOnStageResult is what the add-on stage hands back to RunDeployV2.
type addOnStageResult struct {
	// Bindings is the BYO binding state the prune that follows the stage needs.
	Bindings byoBindingState
	// Refused are the BYO charts this deploy refused (#6439).
	Refused []byoRefusal
	// Warnings are the deploy warnings the console's Deploy tab shows — one per refusal.
	Warnings []string
	// Health is ArgoCD's health/sync for every add-on this deploy applied.
	Health map[string]argocd.AddOnHealth
}

// runAddOnStage is the add-on stage of a dedicated deploy, from configuring the BYO charts to the
// health wait, in the order the cluster needs:
//
//	configure BYO charts → seed add-on secrets → BYO bindings → cloud identity → render → wave
//	apply → GitOps-mode write → one-shot bootstraps → health wait
//
// # Why it is one function (#6439)
//
// A BYO chart refused for its namespace must be left out of EVERY step that renders, applies,
// seeds or waits — and a single unfiltered call site is enough to reopen the defect: the chart's
// Application applied again, syncing into a namespace the platform owns. While these steps lived
// inline in RunDeployV2, a test could only replay them, and reverting one call site to the
// unfiltered list passed the whole suite. As one function, the test drives the real sequence.
//
// What is NOT filtered, deliberately: writeAddOnGitOps (gitops-mode add-ons only; a BYO chart is
// always attached `managed`) and EnsureAddOnBootstraps (catalogue add-ons only). The prunes that
// follow this stage in RunDeployV2 read the FULL vc.AddOns, so a refused chart's live Application
// stays in their keep list and is not deleted.
//
// Only an error RunDeployV2 must fail on is returned — a credential re-mint or the cloud-identity
// resolution. Everything else is best-effort and logged, as it was inline.
func runAddOnStage(ctx context.Context, in addOnStageInput, stdout, stderr io.Writer) (addOnStageResult, error) {
	vc := in.VC
	var out addOnStageResult

	// Bring-your-own (git-source) charts: pin them to a hardened per-project AppProject and register
	// their per-repo credentials BEFORE rendering the Applications, so the renderer places them in
	// "byo-<slug>" (not the wide-open "infra" project). A chart whose namespace is refused (malformed,
	// or reserved for the platform — #6439) is refused PER CHART.
	_, out.Refused = configureByoCharts(vc, in.GitAccessToken, in.GitRepoTokens, in.Facts.Labels, stdout, stderr)
	for _, r := range out.Refused {
		out.Warnings = append(out.Warnings, r.warning())
	}

	// Seed each add-on's secret-knob Secret (W4.5 #640) BEFORE any Application syncs — managed or
	// gitops mode. The values were fetched by the runner over the authenticated job channel and exist
	// nowhere else: not in the snapshot, not in the rendered manifest, not in the customer's repo. The
	// chart consumes them via the SecretKeyRef wiring the console resolved into helm.values.
	argocd.EnsureAddOnSecrets(withoutByoRefusals(vc.AddOns, out.Refused), in.AddOnSecretValues, stdout, stderr)

	// W5 Lane 2b: resolve each BYO chart workload's W3 bindings into its chart Values now (runtime,
	// against the tofu outputs) + seed their keyless binding ExternalSecrets — BEFORE the
	// Applications render, so the write-back rides the same helm.values block.
	out.Bindings = applyByoChartBindingsExcept(vc, in.Outputs, in.Provider, out.Refused, stdout, stderr)

	// Resolve the platform-provisioned cloud identity into the add-on's values BEFORE the
	// Applications render — the same seam, and the same reason, as the bindings above: the value
	// exists only in this run's tofu outputs, and the console that stored the knob could not have
	// known it. Mutating vc.AddOns rather than the rendered output also means writeAddOnGitOps below
	// writes the resolved value into the customer's repo, which is correct and free.
	if err := argocd.ResolveAddOnCloudIdentity(vc.AddOns, in.Facts, stdout, stderr); err != nil {
		return out, fmt.Errorf("external-dns identity resolution failed: %w", err)
	}

	// Computed AFTER the mutations above (bindings, cloud identity), so it carries their values.
	deployable := withoutByoRefusals(vc.AddOns, out.Refused)
	addonDir, addonErr := argocd.RenderManagedAddOns(deployable, in.Facts.Labels)
	if addonErr != nil {
		fmt.Fprintf(stderr, "Warning: marketplace add-ons skipped: %v\n", addonErr)
	} else {
		defer os.RemoveAll(addonDir)
		// Apply the Applications in ascending sync-wave order, waiting after each wave for the CRDs it
		// establishes. ArgoCD's sync-wave annotation does NOT order separate top-level Applications,
		// so a Helm operator (CloudNativePG) and an Application carrying a CR that needs its schema (a
		// CNPG Cluster) would otherwise race — the CR's first sync failing with `no matches for kind`.
		if err := in.Refresh(ctx, "the add-on Applications"); err != nil {
			return out, err
		}
		if applyErr := argocd.ApplyAddOnsInWaves(deployable, addonDir, stdout, stderr); applyErr != nil {
			fmt.Fprintf(stderr, "Warning: marketplace add-ons apply failed: %v\n", applyErr)
		}
	}
	// GitOps-mode add-ons → seed/prune into the customer's apps repo.
	if gitErr := writeAddOnGitOps(ctx, vc, in.GitAccessToken, in.Facts.Labels, stdout, stderr); gitErr != nil {
		fmt.Fprintf(stderr, "Warning: GitOps add-on sync skipped: %v\n", gitErr)
	}
	// One-shot in-cluster bootstraps for the add-ons that ask for one — today, initialising and
	// unsealing a marketplace Vault (#2717).
	//
	// HERE, and the position is load-bearing in both directions. AFTER the Applications are applied,
	// because the Job talks to a Service that does not exist until then. BEFORE WaitAddOnsHealthy
	// below, because a sealed Vault never becomes Healthy — waiting first would burn the whole add-on
	// budget and then unseal it too late to be observed. The apply does not block on the Job
	// finishing; the wait that follows is what sees the result.
	argocd.EnsureAddOnBootstraps(vc.AddOns, selfimage.Ref(), stdout, stderr)

	// Read ArgoCD health/sync for every add-on this deploy applied (managed + gitops) so the console
	// shows real status (best-effort — a read failure just leaves status Unknown).
	//
	// WAIT for convergence first. The read used to run the instant after `kubectl apply`, when every
	// Application is still Progressing/Missing — so a database that was about to come up perfectly
	// was persisted as "Creating"… and nothing ever refreshed it (the day-2 refresh only updates
	// project_addons rows, and the synthesized Hetzner data-service specs have none). The wait is
	// bounded and best-effort: an add-on that never converges is reported honestly rather than
	// failing an otherwise-healthy cluster. A refused BYO chart is not waited on: this deploy did not
	// apply it, and its Application can no longer sync.
	if err := in.Refresh(ctx, "the add-on health wait"); err != nil {
		return out, err
	}
	out.Health = argocd.WaitAddOnsHealthy(ctx, argocd.AllAddOnNames(deployable), addonConvergeTimeout(), stdout, stderr)
	return out, nil
}
