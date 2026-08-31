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
	"strings"
	"time"

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

	// BEFORE the destroy: remove the in-cluster objects that own cloud load balancers.
	//
	// A LoadBalancer Service and an ALB Ingress create cloud resources that are not in the state
	// file, and `tofu destroy` then fails on the network they are attached to — measured on
	// aws/addons run 33262881462 as seven subnet DependencyViolations, an Internet Gateway that
	// would not detach, and an ACM certificate "in use". See destroy_loadbalancers.go.
	//
	// BEST EFFORT, and deliberately so. Every failure here is reported and none of them stops the
	// teardown: the usual reason to be unable to reach the cluster is that it is already gone, and
	// a destroy that refuses to start because it could not tidy up first would be a worse bug than
	// the one this fixes.
	//
	// ⚠️ Best effort is NOT "someone else will catch it". The scope-locked sweepers are the e2e
	// workflow's (`scripts/e2e/*-cleanup.sh`); nothing here sweeps cloud load balancers after a
	// failed destroy, so on a customer's teardown the warning below is the only signal that
	// something is still billing.
	rel := releaseLoadBalancersBeforeDestroy(ctx, provider, vc, wd, out)

	fmt.Fprintln(out, "   Destroying Cloud Resources (this may take 10-15 mins)...")
	err = wd.tf.Destroy(ctx, wd.varFile)

	// ONE RETRY, AND ONLY AFTER THE BLOCKER WAS ACTUALLY CLEARED.
	//
	// A destroy that failed with cloud-backed objects still held has almost certainly failed ON
	// them — the network they are attached to cannot be deleted while they exist. The cluster is
	// still up, because the destroy did not finish, so the release can be tried again with a fresh
	// window.
	//
	// WHEN it retries is `shouldRetryRelease`, and the argument lives there rather than being
	// restated here. This block used to carry its own copy, which went on arguing for
	// `len(rel.Remaining) > 0` after the condition had been widened past it — a signed rationale at
	// the call site for undoing the change the function had just made.
	rel, err = retryReleaseAndDestroy(ctx, out, rel, err,
		func() releaseOutcome { return releaseLoadBalancersBeforeDestroy(ctx, provider, vc, wd, out) },
		func() error { return wd.tf.Destroy(ctx, wd.varFile) })
	if err != nil {
		return fmt.Errorf("tofu destroy failed: %w%s", err, rel.billingWarning())
	}

	for _, line := range destroySuccessLines(rel) {
		fmt.Fprintln(out, line)
	}
	return nil
}

// retryReleaseAndDestroy is the whole retry policy: whether to try again, which release outcome to
// keep, what to tell the operator, and whether to re-run the destroy.
//
// It takes its two collaborators as closures rather than reaching for the workdir, so the policy can
// be driven without a tofu binary or a cluster. That is not decoration — reaching this branch for
// real needs a `tofu destroy` that fails AND a cluster that answers with LoadBalancer Services, and
// because it could not be reached it shipped in #3433 with no test at all, erasing the object list
// it existed to preserve. A retry nobody can exercise is a retry nobody has checked.
func retryReleaseAndDestroy(
	ctx context.Context,
	out io.Writer,
	rel releaseOutcome,
	destroyErr error,
	release func() releaseOutcome,
	destroy func() error,
) (releaseOutcome, error) {
	if !shouldRetryRelease(destroyErr, rel, ctx.Err()) {
		return rel, destroyErr
	}
	// The banner says what was ACTUALLY established, because the retry now fires on three states
	// and only one of them observed anything. Announcing "objects still held" over a Skipped —
	// where the release never ran and nothing was ever listed — is the same defect this PR fixes
	// in adoptRetryOutcome: a sentence about objects nobody saw.
	fmt.Fprintln(out, retryBanner(rel))
	second := release()
	adopted, note := adoptRetryOutcome(rel, second)
	fmt.Fprintln(out, note)
	// `second.Released > 0`, not `second.Clean` alone. Clean is also what a cluster with zero
	// LoadBalancer Services returns, so on a Skipped/Unknown first attempt whose destroy failed for
	// an unrelated reason, a bare Clean bought a second full `tofu destroy` — 10-15 minutes — that
	// changed nothing. This function's own rationale is "the second release positively removed what
	// the first could not"; Released is that fact, and Clean was only ever a proxy for it.
	if second.Clean && second.Released > 0 {
		return adopted, destroy()
	}
	return adopted, destroyErr
}

// retryBanner names the state the retry is actually reacting to. Three states reach it and they
// are not interchangeable: objects were seen still holding load balancers, the cluster stopped
// answering so we do not know what it held, or the release never ran at all.
func retryBanner(rel releaseOutcome) string {
	switch {
	case len(rel.Remaining) > 0:
		return "   Destroy failed with cloud-backed objects still held — releasing again " +
			"and retrying the destroy ONCE."
	case rel.Unknown:
		return "   Destroy failed and the cluster stopped answering, so what it still held is " +
			"unknown — releasing again and retrying the destroy ONCE."
	default:
		return "   Destroy failed and the pre-destroy release never ran (" + rel.Skipped +
			") — releasing again and retrying the destroy ONCE."
	}
}

// shouldRetryRelease decides whether a FAILED destroy is worth a second release plus a second
// destroy. Split out as a pure function because the branch it guards cannot otherwise be tested:
// reaching it for real needs a tofu that fails and a cluster that answers, and an untested retry is
// how the first version of this shipped erasing the list it existed to preserve.
//
// The condition is NOT `len(rel.Remaining) > 0`, and NOT `!rel.Clean` either — both are wrong in
// opposite directions.
//
// `!rel.Clean` retries a repeat teardown of an already-gone environment, paying for a full
// Output + reachability + ConfigureKubeconfig round to learn nothing. That is the common case and
// it is why the condition was narrowed.
//
// But narrowing it to `Remaining` removed the retry from the two states where it was doing REAL
// WORK, not just re-reporting. On a `Skipped` the release deleted NOTHING — `wd.tf.Output` blipped
// against the state proxy, or `clusterReachable` answered false once (a throttled apiserver, an
// exec-credential refresh, the ambient-KUBECONFIG mismatch documented at
// releaseLoadBalancersBeforeDestroy) — so the ingress-nginx ELB is still live and `tofu destroy`
// then fails on exactly the subnet DependencyViolation this file exists for. The retry re-ran the
// release, reached the cluster that time, deleted the Service and re-ran the destroy, and the
// teardown SUCCEEDED. Returning immediately leaves it red with the ELB billing and no remedy but a
// human in the console. `Unknown` from the opening list is the same shape: "we could not look" is
// precisely the state in which the objects are most likely still there and still deletable.
//
// So the skip is gated on whether the first release could ever have reached a cluster, which is
// what NoCluster records — a permanent fact about the state file, not a transient failure.
func shouldRetryRelease(destroyErr error, rel releaseOutcome, ctxErr error) bool {
	// A cancelled teardown must stop, not start another wait.
	if destroyErr == nil || ctxErr != nil || rel.Clean {
		return false
	}
	// Nothing to reach, so nothing a second attempt could do differently.
	if rel.NoCluster {
		return false
	}
	return len(rel.Remaining) > 0 || rel.Unknown || rel.Skipped != ""
}

// adoptRetryOutcome picks which release outcome the billing warning speaks from after a retry.
//
// ⚠️ THE SECOND ATTEMPT CAN ESTABLISH LESS THAN THE FIRST, and in the motivating scenario it
// usually does: by the time a teardown fails on subnet DependencyViolations the control plane is
// often already gone, so the second release returns Skipped, carrying no Remaining. Taking it
// unconditionally makes the error read "the pre-destroy release did not run: the cluster could not
// be reached" and name ZERO objects — discarding the only list anyone has, which is strictly worse
// than never having retried at all.
// It returns the operator-facing line with the outcome, rather than leaving the caller to re-derive
// which case it is: the note and the adoption are one decision, and splitting them is how they come
// to disagree — the shipped bug printed "the second release did not clear them either" about
// objects nobody had ever observed.
func adoptRetryOutcome(first, second releaseOutcome) (releaseOutcome, string) {
	switch {
	case second.Clean:
		return second, "   The second release cleared them — retrying the destroy."
	case len(second.Remaining) > 0:
		// The second attempt also observed objects: it established at least as much as the first,
		// so its list is the fresher one.
		return second, "   The second release did not clear them either — not retrying the " +
			"destroy, which would fail the same way."
	default:
		// Keep the first outcome's LIST, but not its CONFIDENCE. A second attempt that could not
		// read the cluster has established that the list is no longer known to be complete, and
		// Unknown is the single field that keeps "there may be more" apart from "this is all of
		// it". Dropping it renders the definitive branch — "Still holding one when the destroy
		// ran: A." — over a list nobody can now vouch for.
		first.Unknown = first.Unknown || second.Unknown
		return first, "   The second release established nothing new — keeping what the first one " +
			"saw, and not retrying the destroy."
	}
}

// postDestroySuccessNotice renders what a destroy that SUCCEEDED must still say about cloud load
// balancers, or "" when there is nothing to say.
//
// ⚠️ A GREEN TEARDOWN CAN LEAVE A LOAD BALANCER BILLING, and until this existed it said nothing.
// tofu deletes what is in the state file; a Service of type LoadBalancer or an Ingress is not in it.
// AWS is merely where that SHOWS — a subnet refuses to delete under an attached ENI, so the destroy
// fails and the error path's warning fires. Other clouds release faster or tolerate more, so there
// the release can time out, the state-file resources delete cleanly, the job goes green, and the
// cloud load balancer keeps charging with no signal anywhere. That is the exact failure class this
// whole path exists for, and attaching the warning only to a FAILED destroy left it uncovered.
//
// The full alarm needs POSITIVE evidence — objects observed, or a cluster that stopped answering.
// A bare Skipped gets the quieter line: on a repeat teardown of an environment that is already gone
// the step cannot run at all, and an alarm on every one of those teaches the reader to scroll past
// the alarm that matters. Not silence either — it still says what did not happen.
//
// It is ONE CALL into the same renderer the failure path uses, differing only in tone — the earlier
// version claimed that ("they cannot drift into disagreeing about what is still held") while
// hand-writing its own sentence for the Skipped arm, which is the arm most likely to be edited and
// the one a test pinned to differ.
//
// An environment whose state names no API endpoint gets NOTHING: it never had a control plane, so
// it never had a cloud load balancer, and a note about checking the console for one is the alarm
// fatigue the paragraph above argues against.
func postDestroySuccessNotice(rel releaseOutcome) string {
	return rel.warning(toneNote)
}

// destroySuccessLines is everything a SUCCEEDED destroy prints, in order.
//
// ⚠️ THE LAST LINE IS THE ONE THAT GETS READ. Job summaries, `--tail` views and the runner's console
// excerpt all keep the NEWEST lines, and a human scanning a green job reads the bottom. Printing the
// ⚠️ block and then an unqualified "Environment destroyed successfully!" left the final word of a
// teardown that stranded a billing load balancer saying it went fine — which is half of the defect
// the notice was added to fix, and the visible half.
//
// A slice rather than two writes at the call site, because "which line comes last" is the entire
// decision and reaching RunDestroy for real needs a tofu binary and a cloud. The function this file
// keeps splitting out is the one whose branch nobody could otherwise exercise.
func destroySuccessLines(rel releaseOutcome) []string {
	if notice := postDestroySuccessNotice(rel); notice != "" {
		return []string{notice, "Environment destroyed — but see the note above."}
	}
	return []string{"Environment destroyed successfully!"}
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
		tfDir, tfvars, restore, err = prepareByoIacWorkdir(ctx, vc, token, cloneDir, out, stderr)
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

// releaseLoadBalancersBeforeDestroy resolves cluster access from the state's outputs and releases
// the cloud-backed objects. Every path reports and returns; nothing here can fail a teardown.
//
// The kubeconfig comes from the SAME place the deploy's did — `tofu output` plus the provider's
// ConfigureKubeconfig — so this needs no new cloud SDK, no new credential, and no new parameter on
// DestroyParams. A cluster whose state has no outputs (already destroyed, or never provisioned) has
// no name, and the step says so and returns.
func releaseLoadBalancersBeforeDestroy(
	ctx context.Context,
	provider cloud.CloudProvider,
	vc *types.ProjectConfig,
	wd *destroyWorkdir,
	out io.Writer,
) releaseOutcome {
	// ⚠️ A WORKING KUBECONFIG IS NOT OVERWRITTEN, and that is not a micro-optimisation.
	//
	// `awsProvider.ConfigureKubeconfig` writes an EXEC-PLUGIN kubeconfig whose command is
	// `os.Args[0] kube-token …` — the running binary as its own credential helper. That is correct
	// in production, where RunDestroy runs inside the runner and the runner implements `kube-token`.
	// It is broken anywhere else: aws/addons run 33271997812 called this from the e2e TEST process,
	// so the plugin became `/tmp/go-build…/e2e.test kube-token …`, which exits 1, and every kubectl
	// died with
	//
	//	getting credentials: exec: executable …/e2e.test failed with exit code 1
	//
	// — clobbering the perfectly good kubeconfig the runner had already written during the deploy.
	// So: ask the cluster first. But ask WHICH cluster answered, because "something answered" is
	// not "the cluster in this state file answered" — and this step then runs
	// `kubectl delete applications --all-namespaces --all`, whose Applications carry
	// `resources-finalizer.argocd.argoproj.io` and therefore cascade-delete everything ArgoCD
	// manages wherever the answer came from.
	//
	// The ambient KUBECONFIG is durable and cross-job, so the wrong answer is the ORDINARY case
	// rather than a corner: ConfigureKubeconfig does `os.Setenv("KUBECONFIG", …)` process-wide
	// (cloud/kubeconfig.go:39,118) and nothing unsets it; `workerHome` is a STABLE per-slot path
	// (agent/supervisor.go:176); and the default isolation backend is the in-process Passthrough
	// (agent/runner.go:44). So worker 0 deploying env A and later claiming the destroy for env B
	// hands `/version` to cluster A, skips the reconfigure, and deletes A.
	//
	// Reading the outputs first costs one call and is what makes the probe mean something. It is
	// the same correction #3408 made for the managed-fields probe, on a path that DELETES.
	outputs, err := wd.tf.Output(ctx)
	if err != nil {
		fmt.Fprintf(out, "   Skipping load-balancer release: could not read state outputs (%v).\n", err)
		return releaseOutcome{Skipped: fmt.Sprintf("the state outputs could not be read (%v)", err)}
	}
	endpoint := cloud.ExtractClusterEndpoint(outputs)
	reachable, why := clusterReachable(ctx, endpoint)
	fmt.Fprint(out, kubeconfigDecisionLine(reachable, why))
	if !reachable {
		// An empty endpoint is not a failure to reach a cluster — it is the absence of one in this
		// state. Carried on the outcome so the retry and the operator notice can both branch on the
		// FACT rather than on the wording of the sentence below.
		noCluster := endpoint == ""
		// NO cluster-name gate. `ExtractClusterName` was the obvious pre-check and it is narrower
		// than what ConfigureKubeconfig accepts: awsProvider handles a BYO-IaC module that emits a
		// generic `kubeconfig` output for a self-managed, non-EKS cluster — checked BEFORE any
		// cluster-name lookup — and such an environment has LoadBalancer Services like any other.
		//
		// ⚠️ SIDE EFFECT: ConfigureKubeconfig writes ~/.kube/kubeconfig and sets the process's
		// KUBECONFIG (cloud/kubeconfig.go:39). The destroy that follows therefore runs with
		// KUBECONFIG pointing at the cluster it is about to destroy — the correct cluster for any
		// template provider that falls back to it, and the same state the DEPLOY path leaves behind.
		if err := provider.ConfigureKubeconfig(ctx, vc, outputs, out); err != nil {
			fmt.Fprintf(out, "   Skipping load-balancer release: the cluster is not reachable (%v).\n", err)
			return releaseOutcome{Skipped: fmt.Sprintf("the cluster could not be reached (%v)", err), NoCluster: noCluster}
		}
		if ok, why2 := clusterReachable(ctx, endpoint); !ok {
			// CHECKED AFTER CONFIGURING, not assumed. ConfigureKubeconfig succeeding means it WROTE
			// a kubeconfig, not that the kubeconfig works — the exec-plugin case above writes
			// happily and then fails on every call.
			//
			// NOT NoCluster, whatever the endpoint said. Reaching here means ConfigureKubeconfig
			// SUCCEEDED, so something in this state describes a cluster. The documented
			// self-managed BYO-IaC shape is exactly that and has no `cluster_endpoint`: awsProvider
			// short-circuits on a generic `kubeconfig` output before any cluster-name lookup, and
			// clusterReachable then fails a second time on the still-empty endpoint — its own doc
			// calls that "the identity check cannot be made", not "there is no cluster". Carrying
			// noCluster through suppressed the billing Note on a green teardown of an environment
			// that can hold a LoadBalancer Service like any other, which is the one case the Note
			// exists for.
			fmt.Fprint(out, postConfigureFailureLine(why2))
			return releaseOutcome{Skipped: "a kubeconfig was written but the cluster did not answer with it (" + why2 + ")"}
		}
	}
	rel, err := releaseCloudLoadBalancers(ctx, out)
	if err != nil {
		fmt.Fprintf(out, "   WARNING — cloud load balancers may still exist and still bill: %v\n", err)
	}
	return rel
}

// clusterReachable asks the API server one cheap question with whatever credential is in scope.
//
// `/version` rather than a list: it is unauthenticated-readable on every distribution, so a 200
// means the endpoint and the transport work, and a failure is about reaching the cluster rather
// than about what this identity may read. Bounded well under the destroy's own budget — a cluster
// being torn down is allowed to be slow, but not to hold the teardown open.
// clusterReachable reports whether the kubeconfig in hand answers for the cluster this state
// file describes — and, when it does not, WHY.
//
// Two questions, not one. "/version answers" only proves an apiserver is on the other end of
// whatever KUBECONFIG the process carries; the caller is about to issue cluster-wide deletes, so
// it also has to know the answer came from the right cluster. `wantEndpoint` is the API server
// this state's outputs name. When it is empty — a BYO-IaC module that emits only a generic
// kubeconfig, and has no endpoint output — the identity check cannot be made, so this reports
// NOT reachable and the caller configures the credential it can vouch for. Failing toward the
// known-good path is the only safe direction on a deleting step.
//
// The reason is returned rather than discarded: a credential-plugin failure, a DNS failure, a 401
// and a timeout are different problems, and collapsing them to a bool is what made run
// 33271997812 take a human to diagnose.
func clusterReachable(ctx context.Context, wantEndpoint string) (bool, string) {
	if wantEndpoint == "" {
		return false, "this state names no API endpoint to check the kubeconfig against"
	}
	if _, err := runKubectlBounded(ctx, 20*time.Second, "get", "--raw", "/version"); err != nil {
		return false, err.Error()
	}
	got, err := runKubectlBounded(ctx, 20*time.Second, "config", "view", "--minify",
		"-o", "jsonpath={.clusters[0].cluster.server}")
	if err != nil {
		return false, "could not read which server the kubeconfig points at: " + err.Error()
	}
	if !sameAPIServer(strings.TrimSpace(got), wantEndpoint) {
		// NOT a soft skip. The kubeconfig works, against something else.
		return false, fmt.Sprintf("the kubeconfig points at %q but this state's cluster is %q",
			strings.TrimSpace(got), wantEndpoint)
	}
	return true, ""
}

// sameAPIServer compares two API server references tolerantly enough for the forms providers
// actually emit: with or without a scheme, with or without a trailing slash, case-insensitive
// host. It deliberately does NOT ignore the host — that is the whole comparison.
func sameAPIServer(a, b string) bool {
	norm := func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.TrimSuffix(s, "/")
		s = strings.TrimPrefix(s, "https://")
		s = strings.TrimPrefix(s, "http://")
		return strings.ToLower(s)
	}
	na, nb := norm(a), norm(b)
	return na != "" && na == nb
}

// kubeconfigDecisionLine renders what the probe decided and WHY, so the log says which of the two
// paths was taken rather than leaving the reader to infer it from what happens next.
//
// Pure, and separated from the caller deliberately: the caller holds a *tofu.TofuCLI, which cannot
// be faked, so every branch of the decision would otherwise be reachable only from a real destroy
// against a real cluster. That is precisely how "reachable" came to mean "something answered".
func kubeconfigDecisionLine(reachable bool, why string) string {
	if reachable {
		return "   Cluster already reachable with the kubeconfig in hand — not reconfiguring it.\n"
	}
	if strings.TrimSpace(why) == "" {
		return "   Reconfiguring the kubeconfig.\n"
	}
	return "   Reconfiguring the kubeconfig: " + why + "\n"
}

// postConfigureFailureLine renders the case where a kubeconfig was WRITTEN and still does not
// answer for this cluster.
//
// It is a billing warning, not a skip notice. #3413 replaced the warning with a neutral "the
// cluster does not answer with it", which reads as "already gone" — and this is the only signal a
// customer gets that something is still costing money, because nothing outside CI sweeps cloud
// load balancers after a failed destroy (destroy_loadbalancers.go).
func postConfigureFailureLine(why string) string {
	reason := strings.TrimSpace(why)
	if reason == "" {
		// An empty tail reads like a sentence that got cut off.
		reason = "the cluster does not answer with it"
	}
	return "   WARNING — cloud load balancers may still exist and still bill: a kubeconfig was " +
		"written but " + reason + "\n"
}
