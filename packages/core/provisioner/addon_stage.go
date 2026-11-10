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
	// called before the wave apply, the long wait in this stage.
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
	// Deployable is every add-on this deploy rendered and applied — vc.AddOns without the refused BYO
	// charts. The health wait RunDeployV2 runs after the prunes reads exactly this list.
	Deployable []types.AddOnInstall
}

// runAddOnStage is the add-on stage of a dedicated deploy, up to — NOT including — the health wait,
// in the order the cluster needs:
//
//	configure BYO charts → seed add-on secrets → BYO users Job → BYO bindings → cloud identity →
//	render → wave apply → GitOps-mode write → one-shot bootstraps
//
// It returns the add-ons this deploy applied (`Deployable`). RunDeployV2 then runs the prunes and
// only then the refresh and the health wait over `Deployable`, the order it always had: a disabled
// add-on's Application must be gone before the wait measures the one replacing it, and a failed
// re-mint before the wait must not skip the prunes.
//
// # Why it is a function (#6439)
//
// A BYO chart refused for its namespace must be left out of every step that renders, applies, seeds
// or waits. While these steps lived inline in RunDeployV2, a test could only replay them, and
// reverting a call site to the unfiltered list passed the whole suite. Now the test drives this
// function, and it pins each filter: EnsureAddOnSecrets, the binding apply, and the returned
// `Deployable` the health wait reads. Render and wave apply are pinned TOGETHER, not separately: the
// wave apply only applies files the render wrote, so unfiltering either one alone changes nothing on
// the cluster — unfiltering both reopens the defect, and the test fails.
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

	// Bring-your-own charts (git or OCI): pin them to a hardened per-project AppProject and register
	// their per-repo credentials BEFORE rendering the Applications, so the renderer places them in
	// "byo-<slug>" (not the wide-open "infra" project). A chart whose namespace is refused (malformed,
	// or reserved for the platform — #6439) is refused PER CHART.
	byo := configureByoCharts(vc, in.GitAccessToken, in.GitRepoTokens, in.Facts.Labels, stdout, stderr)
	out.Refused = byo.Refused
	moved := byo.Moved
	refusedIDs := byoRefusedIDs(out.Refused)
	for _, c := range byo.ProjectChanges {
		out.Warnings = append(out.Warnings, c.warning())
	}
	for _, m := range moved {
		// A chart refused after its move is not deployed anywhere: its refusal is the warning, and a
		// second one naming a namespace it does not run in would be false.
		if !refusedIDs[m.ID] {
			out.Warnings = append(out.Warnings, m.warning())
		}
	}
	for _, r := range out.Refused {
		out.Warnings = append(out.Warnings, r.warning())
	}
	for _, o := range byo.PreviewOverlaps {
		out.Warnings = append(out.Warnings, o.warning())
	}
	for _, a := range byo.Admission {
		out.Warnings = append(out.Warnings, a.warning())
	}

	// Seed each add-on's secret-knob Secret (W4.5 #640) BEFORE any Application syncs — managed or
	// gitops mode. The values were fetched by the runner over the authenticated job channel and exist
	// nowhere else: not in the snapshot, not in the rendered manifest, not in the customer's repo. The
	// chart consumes them via the SecretKeyRef wiring the console resolved into helm.values.
	argocd.EnsureAddOnSecrets(withoutByoRefusals(vc.AddOns, out.Refused), in.AddOnSecretValues, stdout, stderr)

	// The BYO users Job (docs/adr/byo-binding-db-users.md §3): with the per-binding flag on, it
	// provisions each declared binding's own database user BEFORE the bindings resolve, because a
	// binding is satisfiable only once its user exists. After configureByoCharts, so its declared set
	// leaves out the refused charts and sees the moved ones in their new namespaces. A no-op with the
	// flag off.
	if byoDBUsersEnabled() {
		if err := in.Refresh(ctx, "the BYO users Job"); err != nil {
			return out, err
		}
	}
	dbUsers := runByoDBUsers(ctx, byoDBUsersInput{VC: vc, Outputs: in.Outputs, Provider: in.Provider, Refused: out.Refused, Refresh: in.Refresh}, stdout, stderr)
	out.Warnings = append(out.Warnings, dbUsers.Warnings...)

	// W5 Lane 2b: resolve each BYO chart workload's W3 bindings into its chart Values now (runtime,
	// against the tofu outputs) + seed their keyless binding ExternalSecrets — BEFORE the
	// Applications render, so the write-back rides the same helm.values block.
	out.Bindings = applyByoChartBindingsExcept(vc, in.Outputs, in.Provider, out.Refused, dbUsers, stdout, stderr)
	// A moved chart's bindings are declared in its NEW namespace (configureByoCharts rewrote it), so
	// the ones an earlier deploy applied in "default" are no longer kept. The prune finds namespaces by
	// this environment's owner label; an earlier runner did stamp that label on "default" when a chart
	// deployed there, but configureByoCharts has just removed it (ReleaseLegacyByoNamespaceLabels), and
	// a cluster where that removal failed must not decide the outcome either — so "default" is named
	// here explicitly. The prune deletes only ExternalSecrets carrying the binding marker AND this
	// environment's owner label, so nothing of the platform's in "default" is a candidate.
	out.Bindings.Namespaces = withByoMoveSources(out.Bindings.Namespaces, moved)

	// Remove the secret-sync objects an earlier sync of a BYO chart left in its namespace: the
	// AppProject now denies those kinds, so ArgoCD no longer manages them and nothing else would
	// (argocd.SweepByoSecretSyncObjects). The keep set is the declared bindings, so the sweep is
	// skipped outright when any binding failed: the set is then incomplete, and an object it would
	// miss could be one the runner applied. A kept binding must be exactly the runner's own object: the
	// sweep holds each one's live spec to the document the binding apply rendered and applied for it
	// (out.Bindings.Rendered), restoring it in place when it differs.
	out.Warnings = append(out.Warnings, sweepByoSecretSync(out.Bindings, out.Bindings.Rendered, stdout, stderr)...)

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
	// because the Job talks to a Service that does not exist until then. BEFORE the health wait
	// RunDeployV2 runs after this stage, because a sealed Vault never becomes Healthy — waiting first would burn the whole add-on
	// budget and then unseal it too late to be observed. The apply does not block on the Job
	// finishing; the wait that follows is what sees the result.
	argocd.EnsureAddOnBootstraps(vc.AddOns, selfimage.Ref(), stdout, stderr)

	out.Deployable = deployable
	return out, nil
}

// sweepByoSecretSyncSkipped is the Deploy-tab warning for a deploy that did not run the sweep.
const sweepByoSecretSyncSkipped = "The runner did not check this environment's bring-your-own chart namespaces " +
	"for secret-sync objects on this deploy, because a binding failed to render or apply. It checks again on the next deploy."

// sweepByoSecretSync runs the BYO secret-sync sweep over this deploy's declared bindings and the
// documents rendered for them, or skips it when any binding failed. Returns the Deploy-tab warnings.
func sweepByoSecretSync(st byoBindingState, rendered map[argocd.BindingSecretRef]string, stdout, stderr io.Writer) []string {
	if st.Failures > 0 {
		fmt.Fprintf(stderr, "Warning: skipping the BYO secret-sync sweep: %d binding(s) failed to render or apply on this deploy\n", st.Failures)
		return []string{sweepByoSecretSyncSkipped}
	}
	return sweepByoSecretSyncObjects(st.Owner, st.Declared, rendered, stdout, stderr)
}

// sweepByoSecretSyncObjects is the cluster call, a variable so the stage test can observe it.
var sweepByoSecretSyncObjects = argocd.SweepByoSecretSyncObjects
