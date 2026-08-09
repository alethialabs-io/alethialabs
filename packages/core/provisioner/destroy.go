// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	tfjson "github.com/hashicorp/terraform-json"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// DestroyParams configures a project teardown. Unlike the old local-workspace
// model, DESTROY now reconstructs the workdir from the templates + config and
// pulls remote state from the console http proxy — a managed runner's VM is
// disposable, so there is never a pre-existing `~/.alethia/workspaces/<name>`.
type DestroyParams struct {
	ProjectConfig *types.ProjectConfig
	Provider      string
	TemplatesDir  string
	CategoriesDir string
	// StateBackend points at the console's per-job http state proxy (the same
	// backend the deploy wrote). Required.
	StateBackend *cloud.HTTPBackendConfig
	Stdout       io.Writer
	Stderr       io.Writer
	// ApiClient, when set, unregisters the cluster from Alethia before teardown.
	ApiClient *api.Client
	// GitAccessToken authorizes the BYO IaC clone (only used when ProjectConfig
	// carries an IacSource; falls back to ProjectConfig.GitAccessToken when empty).
	GitAccessToken string
	// KubeConn resolves an existing shared-Fabric cluster's endpoint + CA OUTPUT-FREE for a
	// vcluster teardown that must reach the HOST to deregister the virtual cluster (same seam as
	// DeployParams.KubeConn — runner-injected, keeps the gcp/azure auth SDKs out of packages/core).
	// Nil for aws (resolved in-core from the name) and for dedicated destroys.
	KubeConn KubeConnResolver
	// NamespaceIdentity DEPROVISIONS the per-namespace tenant cloud identity a namespace-placement
	// deploy minted (#957/#2016) — the teardown counterpart of DeployParams.NamespaceIdentity, and
	// runner-injected for the same reason (deleting a GSA/UAMI is a keyless IAM-write whose auth SDK
	// stays out of packages/core). Nil for aws and alibaba (deprovisioned in-core, mirroring how they
	// provision), for hetzner (no cloud IAM), and for every dedicated/vcluster destroy.
	NamespaceIdentity NamespaceIdentityDeprovisioner
	// TalosKubeconfig mints a kubeconfig from a hetzner-talos Fabric's persisted talosconfig for a
	// vcluster teardown that must reach the HOST to deregister the virtual cluster (same seam as
	// DeployParams.TalosKubeconfig — runner-injected). Nil for every non-hetzner cloud and dedicated destroys.
	TalosKubeconfig TalosKubeconfigMinter
	// DryRun asks for the teardown to be PLANNED and never applied — the read-only form
	// destroy otherwise lacks (see tofu.PlanDestroy). It is honored by RunDestroyPlan and
	// REJECTED by RunDestroy: a flag whose whole purpose is "do not touch anything" must
	// never be silently ignored by the call that tears real infrastructure down.
	DryRun bool
}

// ErrDestroyPlanNoTofu reports that this environment owns no OpenTofu state, so there is no
// teardown to plan. A vcluster placement is an app on a shared Fabric — its destroy deregisters
// the virtual cluster rather than running tofu. Returned as a typed error rather than an empty
// plan because "nothing to tear down" and "a teardown that changes nothing" are opposite
// findings, and a day-2 gate that confuses them passes vacuously.
var ErrDestroyPlanNoTofu = errors.New("this environment owns no OpenTofu state — there is no teardown to plan")

// RunDestroy tears down a project environment. It rebuilds the tofu workdir from
// the bundled templates, initializes the http state backend (pulling the recorded
// state), and runs `tofu destroy`. It mirrors RunDeployV2's workdir setup so the
// destroy plan matches what was applied.
func RunDestroy(ctx context.Context, params DestroyParams) error {
	// Fail closed. DryRun means "plan it, never apply it", and the caller that sets it is
	// asking a question, not requesting a teardown. Honoring it here as a no-op would be
	// worse than rejecting it (a teardown that silently did not happen), and ignoring it
	// would destroy real infrastructure on a call that asked for a dry run.
	if params.DryRun {
		return fmt.Errorf("RunDestroy was called with DryRun set — use RunDestroyPlan to plan a teardown; RunDestroy always applies")
	}
	vc := params.ProjectConfig
	if vc == nil {
		return fmt.Errorf("ProjectConfig is required for RunDestroy")
	}
	if params.StateBackend == nil {
		return fmt.Errorf("StateBackend config is required for state access")
	}
	// Checked HERE, not left to prepareDestroyWorkdir, because the unregister below runs first:
	// deferring this validation would let a call with bad params unregister the cluster from
	// Alethia and only then fail, leaving the control plane out of step with the live cloud.
	if vc.IacSource == nil && params.TemplatesDir == "" {
		return fmt.Errorf("TemplatesDir is required")
	}

	out := params.Stdout
	if out == nil {
		out = os.Stdout
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return err
	}

	// A PLACED env (vcluster or namespace) owns NO tofu — it is an app on a shared Fabric, and its
	// deploy path ran none. Its teardown is deleting what that deploy created on the Fabric, so route
	// it before the tofu path (#1231 vcluster, #2016 namespace).
	//
	// Falling through to `tofu destroy` is not merely useless here: the state is empty, so the destroy
	// changes nothing and RunDestroy prints "Environment destroyed successfully!" over a namespace, a
	// guardrail bundle, an ArgoCD Application and a live per-namespace cloud identity that are all
	// still there. A teardown that reports success without tearing anything down is worse than one
	// that fails.
	switch vc.PlacementMode {
	case types.PlacementModeVcluster:
		return runVClusterDestroy(ctx, provider, params)
	case types.PlacementModeNamespace:
		return runNamespaceDestroy(ctx, provider, params)
	case types.PlacementModeDedicated:
		// A dedicated env OWNS its Fabric and its OpenTofu state, so it falls through to the tofu
		// teardown below — as does an EMPTY PlacementMode, which is the legacy env=cluster spelling
		// of dedicated and reaches no case here. Spelled out rather than left to a default arm so
		// that adding a fourth placement mode is a compile-time decision, not a silent tofu destroy.
	}

	workspaceName := fmt.Sprintf("%s-%s", vc.ProjectName, vc.EnvironmentStage)
	fmt.Fprintf(out, "Destroying environment %s...\n", workspaceName)

	if params.ApiClient != nil {
		fmt.Fprintln(out, "   Unregistering cluster from Alethia...")
		clusterName := fmt.Sprintf("%s-cluster", workspaceName)
		if err := params.ApiClient.UnregisterCluster("", clusterName); err != nil {
			fmt.Fprintf(out, "   Warning: Failed to unregister cluster: %v\n", err)
			fmt.Fprintln(out, "   Continuing with resource destruction...")
		} else {
			fmt.Fprintln(out, "   Cluster unregistered successfully.")
		}
	}

	wd, err := prepareDestroyWorkdir(ctx, params)
	if err != nil {
		return err
	}
	defer wd.cleanup()

	fmt.Fprintln(out, "   Destroying Cloud Resources (this may take 10-15 mins)...")
	if err := wd.tf.Destroy(ctx, wd.varFile); err != nil {
		return fmt.Errorf("tofu destroy failed: %w", err)
	}

	fmt.Fprintln(out, "Environment destroyed successfully!")
	return nil
}

// RunDestroyPlan PLANS a project teardown and returns the plan JSON without applying
// anything. It is the read-only counterpart to RunDestroy and shares its entire workdir
// setup (prepareDestroyWorkdir), so the plan describes the same teardown RunDestroy would
// perform — the invariant "the destroy plan matches what was applied" only holds because
// both paths build the workdir from one place.
//
// Requires DestroyParams.DryRun. Unlike RunDestroy it never unregisters the cluster from
// Alethia and never touches the ApiClient: planning a teardown must leave the control plane
// exactly as it found it.
func RunDestroyPlan(ctx context.Context, params DestroyParams) (*tfjson.Plan, error) {
	if !params.DryRun {
		return nil, fmt.Errorf("RunDestroyPlan requires DestroyParams.DryRun — set it to state explicitly that this teardown is only being planned")
	}
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunDestroyPlan")
	}
	// Both PLACED modes own no OpenTofu state, so there is no teardown to plan for either. Returning a
	// real (empty) plan for a namespace env would be the vacuous pass ErrDestroyPlanNoTofu's own doc
	// warns about: a day-2 gate reading "0 resources to destroy" cannot tell "this env has nothing to
	// tear down" from "this teardown would change nothing", and the second is a finding.
	if vc.PlacementMode == types.PlacementModeVcluster || vc.PlacementMode == types.PlacementModeNamespace {
		return nil, ErrDestroyPlanNoTofu
	}

	wd, err := prepareDestroyWorkdir(ctx, params)
	if err != nil {
		return nil, err
	}
	defer wd.cleanup()

	planFile := filepath.Join(wd.dir, "tofu.destroy.plan")
	if _, err := wd.tf.PlanDestroy(ctx, wd.varFile, planFile); err != nil {
		return nil, fmt.Errorf("tofu plan -destroy failed: %w", err)
	}
	plan, err := wd.tf.ShowPlanJSON(ctx, planFile)
	if err != nil {
		return nil, fmt.Errorf("tofu show -json of the destroy plan failed: %w", err)
	}
	// A nil plan is not an empty teardown — it is a plan we could not read. Returning it
	// would hand the caller something indistinguishable from "nothing to destroy".
	if plan == nil {
		return nil, fmt.Errorf("tofu show -json produced no destroy plan")
	}
	return plan, nil
}

// destroyWorkdir is an initialized OpenTofu workdir for a teardown: templates (or the BYO
// IaC clone at its pinned commit) laid down, tfvars written, remote state backend wired and
// pulled. cleanup MUST be deferred by the caller — it releases the state auth env, restores
// the BYO IaC workdir, and removes the temp tree, in that order.
type destroyWorkdir struct {
	tf      *tofu.TofuCLI
	dir     string
	varFile string
	cleanup func()
}

// prepareDestroyWorkdir rebuilds the tofu workdir a teardown runs in, mirroring RunDeployV2's
// setup so a destroy resolves the same variables the apply did. Shared verbatim by RunDestroy
// and RunDestroyPlan: a second copy is exactly how "the destroy plan matches what was applied"
// would quietly stop being true.
func prepareDestroyWorkdir(ctx context.Context, params DestroyParams) (*destroyWorkdir, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required")
	}
	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state access")
	}
	byoIac := vc.IacSource != nil
	if !byoIac && params.TemplatesDir == "" {
		return nil, fmt.Errorf("TemplatesDir is required")
	}

	out := params.Stdout
	if out == nil {
		out = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	tmpRoot, err := os.MkdirTemp("", "alethia-destroy-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	// Every failure past this point must undo what has already been set up; `cleanups` is
	// unwound in reverse (defer order) by both the error paths here and the returned cleanup.
	cleanups := []func(){func() { os.RemoveAll(tmpRoot) }}
	unwind := func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}

	var tfDir string
	var tfvars map[string]interface{}
	if byoIac {
		// BYO IaC: destroy MUST run the customer's module at the SAME pinned commit
		// (destroying with drifted HCL orphans resources). Clone-at-pinned-SHA +
		// inline fail-closed gate + backend override, exactly like the deploy.
		token := params.GitAccessToken
		if token == "" {
			token = vc.GitAccessToken
		}
		cloneDir := filepath.Join(tmpRoot, "clone")
		var restore func()
		tfDir, tfvars, restore, err = prepareByoIacWorkdir(vc, token, cloneDir, out, stderr)
		if err != nil {
			unwind()
			return nil, err
		}
		cleanups = append(cleanups, restore)
	} else {
		tfDir = filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, tfDir); err != nil {
			unwind()
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		// Reconstruct the same tfvars the apply used so the destroy plan resolves the
		// same variables (greenfield/provisioned-network is the common case; brownfield
		// subnet re-resolution is a follow-up).
		tfvars = provider.ProviderTfvars(vc)
		if _, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, out); composeErr != nil {
			unwind()
			return nil, fmt.Errorf("connector composition failed: %w", composeErr)
		}
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, out, stderr)
	if err != nil {
		unwind()
		return nil, fmt.Errorf("failed to initialize OpenTofu CLI: %w", err)
	}

	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		unwind()
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		unwind()
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}
	cleanups = append(cleanups, params.StateBackend.SetAuthEnv())
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		unwind()
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	return &destroyWorkdir{tf: tf, dir: tfDir, varFile: varFile, cleanup: unwind}, nil
}
