// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/accessanalyzer"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	alethiaAws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/telemetry"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/aws/aws-sdk-go-v2/config"
	tfjson "github.com/hashicorp/terraform-json"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type DeployParams struct {
	ProjectConfig  *types.ProjectConfig
	Provider       string
	PlanFile       string
	DryRun         bool
	UpdateInfra    bool
	InfracostToken string
	GitAccessToken string
	// GitRepoTokens maps a BYO chart repo URL → its git token, for charts whose repo lives on a
	// different provider than the apps-destination repo (GitAccessToken). Empty/missing entries
	// fall back to GitAccessToken. Only the BYO-chart credential path consults this.
	GitRepoTokens map[string]string
	// AddOnSecretValues maps add-on id → secret field key → plaintext, fetched by the RUNNER
	// at execution time over the authenticated job channel (W4.5 #640 — the git-token
	// pattern; never present in the config snapshot or the stage payload). Consumed once, by
	// EnsureAddOnSecrets, to seed each add-on's in-cluster Secret before its Application
	// syncs. Nil when no enabled add-on has a stored secret knob.
	AddOnSecretValues map[string]map[string]string
	TemplatesDir      string
	// CategoriesDir is the root of the composable per-category modules
	// (infra/templates/categories). When set, pluggable providers selected on the
	// Project resources are composed into the plan; native resources are guarded off via tfvars.
	CategoriesDir string
	// StateBackend points project tofu state at the console's per-job http proxy
	// (no storage master key in the workdir). Required for RunDeployV2.
	StateBackend *cloud.HTTPBackendConfig
	// PhaseFile, when set, is an absolute path RunDeployV2 writes the current provisioning
	// phase to ("apply" is written immediately before `tofu apply`). The runner reads it
	// after a mid-flight cancel to decide whether the killed work had reached the apply
	// (state-mutating) phase — i.e. whether orphaned cloud resources may exist. It lives
	// under the per-job workdir so it is visible across the container-sandbox boundary
	// (the child writes it into the RW-mounted workdir; the parent reads it after exit).
	PhaseFile    string
	Stdout       io.Writer
	Stderr       io.Writer
	ApiClient    *api.Client
	DeploymentID string
	// VerifyOverride, when set, waives specific failing verification controls so
	// a fail-closed apply can proceed deliberately. Nil means no waiver (the
	// default — any hard control failure blocks apply).
	VerifyOverride *verify.Override
	// CostCeilingMonthlyUSD, when > 0, fail-closes a real apply whose Infracost
	// estimated monthly cost exceeds it (or that could not be priced at all). 0 (the
	// default) disables the guard, so existing callers are unaffected. Opt-in cost
	// safety for the real-cloud e2e nightly; see costCeilingBlock.
	CostCeilingMonthlyUSD float64
}

// PlanResult holds structured output from a deployment (dry-run or full apply).
type PlanResult struct {
	PlanJSON        map[string]interface{}
	CostBreakdown   *infracost.CostBreakdown
	PlanFileBytes   []byte
	Outputs         map[string]interface{}
	ClusterName     string
	ClusterEndpoint string
	// ClusterReady reports that after a real apply the cluster's API server answered and
	// its nodes reached Ready within the probe timeout. A deploy that can't reach the
	// cluster is FAILED (not SUCCESS) — "tofu apply exited 0" is not a working cluster.
	ClusterReady bool
	ArgocdURL    string
	// The ArgoCD admin password is deliberately NOT a field here. It lives in the cluster's
	// `argocd-initial-admin-secret` Secret and is retrieved on-demand; keeping it out of
	// PlanResult stops it from crossing the sandbox boundary (result.json) or landing in the
	// console's execution_metadata (Postgres) as plaintext. See installArgoCD + buildDeployMetadata.
	// VerifyReport is the deterministic verification gate's result for this plan
	// (nil if the plan JSON could not be produced). On a real apply a blocking
	// verdict stops the apply before any infrastructure changes.
	VerifyReport *verify.Report
	// VerifyReceipt is the per-apply evidence receipt sealing the report to the
	// plan hash + tool versions. Signed when a signing key is configured
	// (Algorithm "ed25519"); otherwise attached unsigned (Algorithm "none").
	VerifyReceipt *verify.SignedReceipt
	// AddOnStatus is the post-apply ArgoCD health/sync per managed marketplace add-on
	// (keyed by ArgoCD Application name). Empty when no add-ons were installed or the
	// health read failed; the runner forwards it so the console can show real status.
	AddOnStatus map[string]argocd.AddOnHealth
	// DataEndpoints is the connection endpoint + credential REFERENCE for each in-cluster data
	// service (Hetzner's database/cache/queue deploy as ArgoCD Applications, not managed cloud
	// resources), keyed by add-on id (`db-primary`, `cache-main`, …). READ BACK from the cluster —
	// chart Service names are never derived. Carries secret_ref ("<ns>/<name>"), never a credential
	// value (the #427 precedent: no plaintext secrets in execution_metadata).
	DataEndpoints map[string]argocd.DataEndpoint
	// SecurityPosture is the cluster's aggregated Trivy-Operator vulnerability posture
	// (nil when the read wasn't attempted). `Scanned=false` when Trivy isn't installed.
	SecurityPosture *argocd.SecurityPosture
	// InfraServices is the machine-readable per-service install/skip decision set for the
	// post-apply infra services (external-dns, external-secrets store, ingress, storage
	// class, ArgoCD URL). Each carries an honest reason — a skip records WHY plus the
	// alternative (like verify's not_evaluable). Non-sensitive; the runner forwards it.
	InfraServices []argocd.InfraServiceDecision
	// GitopsStatus is the GitOps wiring outcome + apps-Application health snapshot
	// (issue #574): mode (gitops/direct), apps repo, synced revision, per-service
	// health from the `apps` Application's resources — and, when the deploy died
	// INSIDE the wiring, the failed step + sanitized error. Populated after every
	// real apply; also set on the FAILURE path (RunDeployV2 then returns a partial
	// result alongside the error) so the console can show WHY GitOps isn't wired
	// instead of a bare failed job. Nil on dry-runs and cluster-less deploys.
	GitopsStatus *argocd.GitopsStatus
}

// gitopsFailure builds the GitopsStatus for a GitOps-wiring hard-fail: which step died
// plus a token-SANITIZED error message (the metadata scrub is key-based, so a tokened
// git URL inside the value must be redacted here, before it crosses result.json).
func gitopsFailure(requested bool, appsRepo, step string, err error, token string) *argocd.GitopsStatus {
	mode := "direct"
	if requested {
		mode = "gitops"
	}
	return &argocd.GitopsStatus{
		Mode:       mode,
		AppsRepo:   appsRepo,
		ArgocdApp:  argocd.UserAppsApplicationName,
		FailedStep: step,
		Error:      argocd.SanitizeGitopsError(err, token),
	}
}

// readGitopsSnapshot records the post-wiring GitOps state: direct mode is just the mode
// marker; gitops mode additionally reads the `apps` Application's aggregate health/sync,
// synced revision, and per-workload service health (one kubectl read, best-effort).
func readGitopsSnapshot(requested bool, appsRepo string, stdout, stderr io.Writer) *argocd.GitopsStatus {
	if !requested {
		return &argocd.GitopsStatus{Mode: "direct"}
	}
	agg, revision, services := argocd.ReadAppsStatus(argocd.UserAppsApplicationName, stdout, stderr)
	return &argocd.GitopsStatus{
		Mode:      "gitops",
		AppsRepo:  appsRepo,
		ArgocdApp: argocd.UserAppsApplicationName,
		Revision:  revision,
		AppHealth: &agg,
		Services:  services,
	}
}

// enabledAddonIDs lists the ids of every add-on in the desired set — the keep-set for
// pruning runner-seeded add-on secrets (W4.5).
func enabledAddonIDs(addons []types.AddOnInstall) []string {
	ids := make([]string, 0, len(addons))
	for i := range addons {
		ids = append(ids, addons[i].ID)
	}
	return ids
}

// writePhase records the current provisioning phase to the job's phase file (best-effort;
// a no-op when path is empty). The runner reads it after a mid-flight cancel to decide
// whether apply had started (→ possible orphaned cloud resources). See DeployParams.PhaseFile.
func writePhase(path, phase string) {
	if path == "" {
		return
	}
	_ = os.WriteFile(path, []byte(phase), 0o600)
}

// applyBootstrapManifests applies a self-managed cluster's CNI + cloud-integration
// manifests — the `bootstrap_manifests` tofu output (Talos/Hetzner emits it; managed
// EKS/GKE/AKS don't, so this is a no-op there). Talos ships CNI=none, so nodes stay
// NotReady until these are applied. The template renders them offline and emits them as
// an output (rather than applying them in-tofu via a cluster-wired kubectl provider), so
// `tofu plan -out` stays resolvable and the machine config stays under Hetzner's 32 KiB
// user_data limit. Retries a few times for CRD-before-CR ordering / API warm-up.
func applyBootstrapManifests(ctx context.Context, outputs map[string]interface{}, stdout, stderr io.Writer) error {
	raw, _ := outputs["bootstrap_manifests"].(string)
	if strings.TrimSpace(raw) == "" {
		return nil // managed cluster — CNI comes from the cloud
	}
	dir, err := os.MkdirTemp("", "alethia-bootstrap-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "bootstrap.yaml")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "Bootstrapping cluster CNI + cloud integration (self-managed)...")
	// Server-side apply handles CRDs + their CRs in one pass more gracefully than a plain apply.
	cmd := fmt.Sprintf("kubectl apply --server-side --force-conflicts -f %s", path)
	var lastErr error
	for attempt := 1; attempt <= 4; attempt++ {
		if lastErr = utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); lastErr == nil {
			return nil
		}
		fmt.Fprintf(stderr, "CNI bootstrap attempt %d/4 failed (API/CRD not ready yet): %v\n", attempt, lastErr)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(15 * time.Second):
		}
	}
	return fmt.Errorf("kubectl apply of bootstrap manifests failed after retries: %w", lastErr)
}

// clusterReadyTimeout is how long the reachability gate waits for the cluster (default 15m;
// override ALETHIA_CLUSTER_READY_TIMEOUT with a Go duration, e.g. "20m", for slow node joins).
func clusterReadyTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 15 * time.Minute
}

// addonConvergeTimeout bounds how long the deploy waits for the add-on Applications to reach
// Healthy+Synced before reading their status for the console. Generous by default: a data service
// (CNPG Cluster, Valkey, RabbitMQ) has to pull images, bind a PVC (hcloud CSI attach is ~30-60s)
// and elect a primary. Best-effort — a timeout records the honest last-known status, it does not
// fail the deploy. Tunable via ALETHIA_ADDON_CONVERGE_TIMEOUT (e.g. "5m"; "0" disables the wait).
func addonConvergeTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_ADDON_CONVERGE_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= 0 {
			return d
		}
	}
	return 10 * time.Minute
}

// clusterReadyRequireNode controls whether the gate waits for >=1 Ready node. Default true
// (node-group clusters); set ALETHIA_CLUSTER_READY_REQUIRE_NODE=false for on-demand-node
// clusters (e.g. Karpenter-only), where API-reachability alone is the bar.
func clusterReadyRequireNode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE"))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// gateRequiresReport is the fail-closed backstop for the real-apply path: a real
// apply must never proceed without a conclusive verification verdict. It returns
// nil (apply may proceed) when this is a dry-run/plan job (nothing is applied), or
// a verification report was produced (the report's own fail-closed enforcement runs
// separately, below), or an authorized override waives the ControlPlanUnavailable
// sentinel. Otherwise — a real apply whose plan JSON could not be produced, so the
// gate could not evaluate anything — it returns an error refusing the apply rather
// than silently skipping enforcement. Kept pure so the decision is unit-testable
// without real tofu. showErr (if any) is threaded through for the operator message.
func gateRequiresReport(dryRun bool, report *verify.Report, ov *verify.Override, showErr error) error {
	if dryRun || report != nil {
		return nil
	}
	if ov.Covers(verify.ControlPlanUnavailable) {
		return nil
	}
	// report==nil is broader than "no plan JSON": the report is also nil when the plan JSON
	// existed but verify.Evaluate errored. Both are "the gate produced no verdict" → refuse
	// (fail-closed) — but report the actual cause honestly so the operator fixes the right thing.
	cause := "the verifier could not evaluate the plan"
	if showErr != nil {
		cause = fmt.Sprintf("the plan JSON could not be produced (tofu show error: %v)", showErr)
	}
	return fmt.Errorf(
		"verification gate produced no verdict (%s) — refusing apply; fix the underlying error or supply an authorized, time-boxed override waiving %s",
		cause, verify.ControlPlanUnavailable)
}

// RunDeployV2 executes a deployment using the provider-agnostic ProjectConfig and CloudProvider interface.
//
// Error contract: a GitOps-wiring failure returns a PARTIAL non-nil result alongside the
// error — carrying GitopsStatus (failed step + sanitized message) so the wiring failure
// reaches execution_metadata (the sandbox writes result.json even on error). Callers must
// therefore branch on err, not on result != nil.
func RunDeployV2(ctx context.Context, params DeployParams) (_ *PlanResult, retErr error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunDeployV2")
	}

	// Provisioning-stage spans (plan → verify_gate → apply → kube_configure → argocd →
	// addons). The stages run strictly sequentially, so a single "current stage" span
	// walks the sequence: setStage ends the previous span and opens the next, and the
	// deferred close ends the last one — stamping the function's error onto whichever
	// stage failed. All are children of ctx's span (the runner's per-job span, anchored
	// to the job's traceparent), so console + runner spans share ONE trace. No-op spans
	// when no OTLP endpoint is configured (telemetry reads the global no-op tracer).
	var curSpan trace.Span
	setStage := func(name string) {
		if curSpan != nil {
			curSpan.End()
		}
		_, curSpan = telemetry.StartStage(ctx, name)
	}
	defer func() {
		if curSpan != nil {
			if retErr != nil {
				curSpan.RecordError(retErr)
				curSpan.SetStatus(codes.Error, retErr.Error())
			}
			curSpan.End()
		}
	}()

	byoIac := vc.IacSource != nil

	// Enforce placement discipline before anything else: a CORE resource on a
	// foreign cloud is a hot cross-cloud edge we can't provision yet. Fires on
	// dry-run (plan) too, so the user never reaches apply. SKIPPED for BYO IaC —
	// placement is a template/catalog-model concept; a customer's own module owns
	// its resource graph.
	if !byoIac {
		if err := ValidatePlacement(vc); err != nil {
			return nil, err
		}
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	fmt.Fprintf(stdout, "Starting deployment for project: %s (provider: %s)\n", vc.ProjectName, provider.Name())

	if !params.DryRun {
		if err := utils.CheckDependencies(provider.RequiredCLIs()...); err != nil {
			return nil, fmt.Errorf("preflight check failed: %w", err)
		}
	}

	if params.DryRun {
		fmt.Fprintln(stdout, "Running in dry-run (plan) mode")
	}

	tmpRoot, err := os.MkdirTemp("", "alethia-deploy-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	var tfDir string
	// byoTfvars holds the customer's coerced var_values on the BYO path (nil otherwise).
	var byoTfvars map[string]interface{}
	switch {
	case byoIac:
		// BRING-YOUR-OWN IaC: clone the customer's module at its pinned commit, run
		// the fail-closed static gate inline, write the backend override, and publish
		// the frozen TF_VAR_alethia_* context. No bundled template, no provider
		// tfvars, no brownfield injection, no connector composition — the module is
		// self-contained.
		cloneDir := filepath.Join(tmpRoot, "clone")
		var restore func()
		tfDir, byoTfvars, restore, err = prepareByoIacWorkdir(vc, params.GitAccessToken, cloneDir, stdout, stderr)
		if err != nil {
			return nil, err
		}
		defer restore()
	case params.TemplatesDir != "":
		fmt.Fprintf(stdout, "Using bundled templates from %s\n", params.TemplatesDir)
		workDir := filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, workDir); err != nil {
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfDir = workDir
	default:
		return nil, fmt.Errorf("no IaC source: set ProjectConfig.IacSource (BYO) or DeployParams.TemplatesDir")
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	var tfvars map[string]interface{}
	if byoIac {
		// Only the customer's coerced var_values — the platform context rides on
		// TF_VAR_alethia_* env (set by prepareByoIacWorkdir).
		tfvars = byoTfvars
	} else {
		tfvars = provider.ProviderTfvars(vc)

		// Brownfield: attach to an EXISTING network instead of creating one. AWS resolves the VPC's subnets
		// here (EC2 API); GCP/Azure pass the network id and the tofu template data-sources the network + a
		// subnet in-region (keeps the per-cloud subnet nuance in HCL). See infra/templates/project/*.
		if !vc.Network.ProvisionNetwork && vc.Network.NetworkID != "" {
			switch provider.Name() {
			case "aws":
				tfvars["vpc_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VPC %s — looking up subnets...\n", vc.Network.NetworkID)
				ec2Client, ec2Err := alethiaAws.NewEC2Client(ctx, alethiaAws.AWSOptions{Region: vc.Region})
				if ec2Err != nil {
					fmt.Fprintf(stderr, "Warning: failed to create EC2 client for subnet lookup: %v\n", ec2Err)
				} else {
					subnets, subErr := ec2Client.ListSubnets(ctx, vc.Network.NetworkID)
					if subErr != nil {
						fmt.Fprintf(stderr, "Warning: failed to list subnets: %v\n", subErr)
					} else {
						privateIDs := make([]string, 0)
						publicIDs := make([]string, 0)
						for _, s := range subnets {
							if s.MapPublicIpOnLaunch {
								publicIDs = append(publicIDs, s.ID)
							} else {
								privateIDs = append(privateIDs, s.ID)
							}
						}
						if len(publicIDs) == 0 {
							publicIDs = privateIDs
						}
						if len(privateIDs) == 0 {
							privateIDs = publicIDs
						}
						tfvars["vpc_private_subnet_ids"] = privateIDs
						tfvars["vpc_public_subnet_ids"] = publicIDs
						fmt.Fprintf(stdout, "Found %d private and %d public subnets\n", len(privateIDs), len(publicIDs))
					}
				}
			case "gcp":
				// Self-link (projects/…/global/networks/…). The template data-sources the network + a
				// subnetwork in var.region (with its pod/service secondary ranges).
				tfvars["network_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VPC network %s — the template resolves a subnet in %s.\n", vc.Network.NetworkID, vc.Region)
			case "azure":
				// VNet resource id. The template data-sources the VNet + a subnet for AKS.
				tfvars["vnet_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VNet %s — the template resolves an AKS subnet.\n", vc.Network.NetworkID)
			}
		}
	}

	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state storage")
	}
	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}
	// Publish the per-job state token to the child tofu via TF_HTTP_PASSWORD for
	// the whole run (init reads/locks, plan reads, apply reads+locks+writes) —
	// never into a workdir file. Restored on return.
	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	fmt.Fprintln(stdout, "State backend: console HTTP proxy (per-job token)")

	fmt.Fprintf(stdout, "DEBUG provider=%s, project=%v, region=%v, provision_network=%v, network_id=%q, cidr=%q\n",
		provider.Name(), tfvars["project_name"], vc.Region, vc.Network.ProvisionNetwork, vc.Network.NetworkID, vc.Network.CIDRBlock)

	// Compose pluggable per-category connector modules (Cloudflare DNS, Vault,
	// Docker Hub, observability). This merges their tfvars (including decrypted
	// secrets resolved at claim time), copies the modules into the work dir, and
	// sets the native-guard vars so the cluster cloud skips its native resource.
	// SKIPPED for BYO IaC — a customer's own module owns its full resource graph;
	// the platform composes nothing into it.
	if !byoIac {
		if composed, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
			return nil, fmt.Errorf("connector composition failed: %w", composeErr)
		} else if composed > 0 {
			fmt.Fprintf(stdout, "Composed %d pluggable connector module(s).\n", composed)
		}
	}

	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "tofu.plan.out"))
	if err != nil {
		return nil, err
	}

	// The http backend authenticates via TF_HTTP_PASSWORD (set above) — no cloud
	// creds are involved in state I/O, so the old s3 suspend/restore dance is gone.
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	setStage("plan")
	if params.PlanFile != "" {
		fmt.Fprintf(stdout, "Using pre-approved plan file (skipping re-plan)\n")
		planFile = params.PlanFile
	} else {
		if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
			return nil, fmt.Errorf("tofu plan failed: %w", err)
		}
	}

	var result PlanResult

	planJSON, showErr := tf.ShowPlanJSON(ctx, planFile)
	planJSONFile := ""
	if showErr != nil {
		fmt.Fprintf(stdout, "Warning: tofu show -json failed: %v\n", showErr)
	}
	if planJSON != nil {
		planJSONFile = filepath.Join(tmpRoot, "tofu.plan.json")
		if jsonBytes, marshalErr := json.Marshal(planJSON); marshalErr == nil {
			_ = os.WriteFile(planJSONFile, jsonBytes, 0644)
			var parsed map[string]interface{}
			if json.Unmarshal(jsonBytes, &parsed) == nil {
				result.PlanJSON = parsed
			}
		}
	}

	// Verification gate (elench Phase 0). Evaluate the plan against the authored
	// security controls. The report is always attached to the result so the
	// console can surface it on both plan and apply jobs; the fail-closed
	// ENFORCEMENT happens just before apply, below. If the plan JSON could not be
	// produced we log a coverage gap rather than block (the experiment is about
	// control correctness, not tooling failures).
	setStage("verify_gate")
	if planJSON != nil {
		// Opt-in AWS IAM Access Analyzer corroboration: provable, automated-reasoning
		// checks that the planned policies don't grant a sensitive-action denylist.
		// Off by default (no AWS calls) so existing behaviour is unchanged.
		vopts := verify.Options{}
		if provider.Name() == "aws" && os.Getenv("ALETHIA_VERIFY_ACCESS_ANALYZER") == "1" {
			if cfg, cfgErr := config.LoadDefaultConfig(ctx); cfgErr == nil {
				vopts.PolicyChecker = accessanalyzer.NewFromConfig(cfg)
				fmt.Fprintln(stdout, "Verification: IAM Access Analyzer corroboration enabled")
			} else {
				fmt.Fprintf(stderr, "Warning: Access Analyzer disabled (AWS config load failed: %v)\n", cfgErr)
			}
		}
		if vrep, vErr := verify.EvaluateWithOptions(ctx, planJSON, vopts); vErr != nil {
			fmt.Fprintf(stderr, "Warning: verification gate failed to run: %v\n", vErr)
		} else {
			result.VerifyReport = vrep
			fmt.Fprintf(stdout, "Verification gate: verdict=%s (pass=%d fail=%d warn=%d not_evaluable=%d, catalog %s)\n",
				vrep.Verdict, vrep.Summary.Pass, vrep.Summary.Fail, vrep.Summary.Warn, vrep.Summary.NotEvaluable, vrep.CatalogVersion)
			for _, c := range vrep.Controls {
				if c.Status == verify.StatusFail || c.Status == verify.StatusWarn {
					for _, f := range c.Findings {
						fmt.Fprintf(stdout, "  [%s/%s] %s: %s\n", c.ID, c.Status, f.Address, f.Message)
					}
				}
				if c.Coverage != "" {
					fmt.Fprintf(stdout, "  [%s] coverage: %s\n", c.ID, c.Coverage)
				}
			}
		}
	} else {
		fmt.Fprintln(stdout, "Verification gate: SKIPPED (no plan JSON) — coverage gap, not a pass")
	}

	if params.InfracostToken != "" {
		infracostEnv := []string{"INFRACOST_API_KEY=" + params.InfracostToken}
		infracostCLI := infracost.NewInfracostCLI("v0.10.39", params.InfracostToken)
		infracostInput := planFile
		if planJSONFile != "" {
			infracostInput = planJSONFile
		}
		costBreakdown, err := infracostCLI.RunInfracost(infracostInput, infracostEnv)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: Infracost analysis failed: %v\n", err)
		} else if costBreakdown != nil {
			result.CostBreakdown = costBreakdown
		}
	}

	if params.DryRun {
		if planBytes, readErr := os.ReadFile(planFile); readErr == nil {
			result.PlanFileBytes = planBytes
		}
		// Plan jobs get an (advisory) evidence receipt too, so the console can show
		// the verdict + signed receipt before any apply is approved.
		attachReceipt(&result, planFile, planJSON, nil, stdout)
		fmt.Fprintln(stdout, "Dry-run complete. Plan and cost analysis finished.")
		return &result, nil
	}

	// Fail-closed cost guard (opt-in; e2e cost safety). When a monthly-USD ceiling is
	// configured, a real apply must not proceed if the Infracost estimate exceeds it — or if
	// no estimate could be produced at all (a ceiling was asked for but the plan couldn't be
	// priced). A zero ceiling (the default) is a no-op, so every existing caller is unchanged;
	// enabling it requires a working INFRACOST_API_KEY. Runs only on the real-apply path
	// (dry-run/plan jobs already returned above and never block on cost).
	if blocked, msg := costCeilingBlock(result.CostBreakdown, params.CostCeilingMonthlyUSD); blocked {
		telemetry.GateBlocked(ctx, provider.Name())
		return nil, fmt.Errorf("%s", msg)
	}

	// Fail-closed backstop: a real apply must never proceed without a conclusive
	// verification verdict. If the plan JSON could not be produced (ShowPlanJSON
	// errored, or tofu emitted no JSON) the gate could not evaluate the plan at
	// all, so we REFUSE the apply rather than silently skipping enforcement — a
	// missing report must never read as an implicit pass. An authorized operator
	// may still proceed by waiving the ControlPlanUnavailable sentinel in
	// VerifyOverride (per-apply, audited, expiry-bounded); disabling the gate
	// wholesale remains impossible. No-op when a report exists (the report's own
	// enforcement runs just below) and on dry-run (already returned above).
	if err := gateRequiresReport(params.DryRun, result.VerifyReport, params.VerifyOverride, showErr); err != nil {
		telemetry.GateBlocked(ctx, provider.Name())
		return nil, err
	}
	if result.VerifyReport == nil && params.VerifyOverride.Covers(verify.ControlPlanUnavailable) {
		fmt.Fprintf(stdout, "Verification override applied by %q: proceeding without a plan-JSON verdict (control %s, reason: %s)\n",
			params.VerifyOverride.By, verify.ControlPlanUnavailable, params.VerifyOverride.Reason)
	}

	// Fail-closed enforcement: a real apply must not proceed while any hard
	// verification control is failing and unwaived. An authorized override may
	// waive specific controls (recorded for the evidence receipt in Phase 1);
	// disabling the gate wholesale is deliberately not an option here.
	if result.VerifyReport != nil {
		if unresolved := result.VerifyReport.Unwaived(params.VerifyOverride); len(unresolved) > 0 {
			// Metric: a fail-closed gate block (low-cardinality provider label only).
			telemetry.GateBlocked(ctx, provider.Name())
			return nil, fmt.Errorf("verification gate BLOCKED apply: failing controls %v (catalog %s) — fix the plan or supply an authorized override to proceed",
				unresolved, result.VerifyReport.CatalogVersion)
		}
		if params.VerifyOverride != nil && len(params.VerifyOverride.Controls) > 0 {
			fmt.Fprintf(stdout, "Verification override applied by %q for controls %v (reason: %s)\n",
				params.VerifyOverride.By, params.VerifyOverride.Controls, params.VerifyOverride.Reason)
		}
	}

	// Seal the evidence receipt for this apply (records any applied override as an
	// exception) before mutating any infrastructure.
	attachReceipt(&result, planFile, planJSON, params.VerifyOverride, stdout)

	// Mark the apply phase BEFORE mutating any infrastructure. A mid-flight cancel from
	// here on may leave cloud resources not yet recorded in state, so the runner reads
	// this marker to flag orphan risk on the cancelled job. Best-effort — a write failure
	// only loses precision (the runner defaults to "no orphan risk"), never blocks apply.
	writePhase(params.PhaseFile, "apply")

	setStage("apply")
	fmt.Fprintln(stdout, "Applying OpenTofu changes...")
	if err := tf.Apply(ctx, planFile); err != nil {
		// A FAILED apply can leave a real cloud resource OUTSIDE tofu state (issue #526): the cloud
		// accepts the create, then fails it asynchronously (capacity/quota/policy), so tofu's create
		// errors and NEVER records it. The environment is then PERMANENTLY WEDGED — every later apply
		// dies with `already exists ... needs to be imported`. Until now that was silent: orphan_risk
		// fired only on an INTERRUPTED apply, so we reported orphan_risk=false on precisely the
		// failure that bricked the customer.
		//
		// Classify on POSITIVE EVIDENCE only (ClassifyApplyError, orphan.go). An ordinary failure —
		// a validation error, a quota rejection BEFORE create — yields OrphanNone and is NOT flagged,
		// which preserves the "normal failures do not over-alert" property the original design was
		// right to protect. Diagnosing this here (rather than leaving the customer to hit an
		// inscrutable "already exists" on their next deploy) is the whole point.
		if f := ClassifyApplyError(err, ""); f.Orphaned() {
			fmt.Fprintf(stderr, "\nORPHAN RISK (%s): %s\n", f.Evidence, f.Reason)
			return nil, &ApplyOrphanError{Err: err, Finding: f}
		}
		return nil, fmt.Errorf("tofu apply failed: %w", err)
	}
	// Apply returned cleanly ⇒ tofu state is fully persisted, so nothing is orphaned OUTSIDE
	// state. Reset the phase marker: without this it stays "apply" through every post-apply
	// stage (kubeconfig, CNI bootstrap, the reachability gate, argocd, addons), and an
	// interruption there (2h deadline, drain) would FALSELY flag orphan_risk on a deploy whose
	// resources are all tracked. "apply" must mean strictly "apply in-flight / state maybe not
	// yet persisted" — the true orphan window.
	writePhase(params.PhaseFile, "applied")

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tofu outputs: %w", err)
	}

	result.Outputs = outputs
	result.ClusterName = cloud.ExtractClusterName(outputs)
	result.ClusterEndpoint = cloud.ExtractClusterEndpoint(outputs)

	if result.ClusterName != "" {
		setStage("kube_configure")
		// Kubeconfig is mandatory: without it the cluster is unreachable, ArgoCD can't
		// install, and "SUCCESS" would be a lie. Fail the deploy loudly.
		if err := provider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
			return nil, fmt.Errorf("kubeconfig configuration failed — the cluster was provisioned but is unreachable: %w", err)
		}
		if !params.DryRun {
			// Bootstrap CNI + cloud integration for SELF-MANAGED clusters (Talos ships
			// CNI=none, so nodes stay NotReady until this is applied). The template emits
			// these as the `bootstrap_manifests` output — rendered offline, applied here via
			// kubectl rather than in-tofu, which keeps `tofu plan -out` resolvable (no
			// cluster-wired provider) AND stays under Hetzner's 32 KiB cloud-init user_data
			// limit (Cilium alone busts it as a Talos inlineManifest). No-op for managed
			// clusters, which get CNI from the cloud and emit no such output.
			if err := applyBootstrapManifests(ctx, outputs, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to bootstrap cluster CNI/cloud integration: %w", err)
			}
			// Reachability gate: prove the API server answers and nodes reach Ready before we
			// call this a working cluster (was: SUCCESS meant only that `tofu apply` exited 0).
			if err := k8s.WaitClusterReady(ctx, clusterReadyTimeout(), clusterReadyRequireNode(), stdout); err != nil {
				return nil, fmt.Errorf("cluster provisioned but not reachable: %w", err)
			}
			// Datapath gate: WaitClusterReady probes the API from the RUNNER (node public IP) and
			// counts Ready nodes — it cannot see whether an ordinary POD can reach the apiserver
			// across the cluster network. A broken pod datapath (e.g. cross-node pod->apiserver)
			// passes the checks above yet breaks every real workload. Only meaningful with a node
			// to schedule on (skip Karpenter-only / node-less clusters).
			if clusterReadyRequireNode() {
				if err := k8s.WaitPodToAPIServer(ctx, clusterReadyTimeout(), stdout); err != nil {
					return nil, fmt.Errorf("cluster provisioned but its pod network is broken: %w", err)
				}
			}
			result.ClusterReady = true
		}
	}

	if !params.DryRun && result.ClusterName != "" {
		// GitOps bootstrap. The cluster is provisioned; ArgoCD + the infra-services
		// (external-dns, karpenter, ALB controller, …) and the user's apps-repo
		// connection are the "GitOps, wired — not just installed" promise. These steps
		// FAIL the job rather than logging a buried warning: a half-wired cluster that
		// reports success is worse than an honest failure the operator can act on.
		gitopsRequested := vc.Repositories.AppsDestinationRepo != ""
		// On any wiring hard-fail below, record WHICH step died (+ a token-sanitized
		// message) on the partial result — the sandbox writes result.json even on error,
		// so the console can show an actionable GitOps failure, not just a failed job.
		gitopsFailed := func(step string, err error) *argocd.GitopsStatus {
			return gitopsFailure(gitopsRequested, vc.Repositories.AppsDestinationRepo, step, err, params.GitAccessToken)
		}

		setStage("argocd")
		if err := installArgoCD(ctx, vc, result.Outputs, &result, stdout, stderr); err != nil {
			if gitopsRequested {
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepArgocdInstall, err)
				return &result, fmt.Errorf("ArgoCD install failed (GitOps requested for repo %s): %w", vc.Repositories.AppsDestinationRepo, err)
			}
			fmt.Fprintf(stderr, "Warning: ArgoCD installation failed: %v\n", err)
		}

		if gitopsRequested {
			if params.GitAccessToken == "" {
				err := fmt.Errorf("GitOps requested (apps repo %s) but no git access token is available — reconnect the git provider for this project", vc.Repositories.AppsDestinationRepo)
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepGitToken, err)
				return &result, err
			}
			if err := argocd.ConfigureRepoCredentials(vc.Repositories.AppsDestinationRepo, params.GitAccessToken, stdout, stderr); err != nil {
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepRepoCredentials, err)
				return &result, fmt.Errorf("failed to connect ArgoCD to apps repo %s: %w", vc.Repositories.AppsDestinationRepo, err)
			}
		}

		argoTemplatesDir := resolveArgoTemplatesDir()
		if argoTemplatesDir == "" {
			// Templates are baked into the runner image; their absence is a build defect,
			// not a user error. Silently skipping infra-services left clusters half-wired.
			err := fmt.Errorf("ArgoCD application templates not found (looked in /home/runner/argocd-templates, argocd-templates, ../../infra/templates/argocd) — the runner image is missing its baked templates")
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepTemplatesMissing, err)
			return &result, err
		}
		facts := argocd.BuildFromOutputs(result.Outputs, vc)
		// Record the honest per-service install/skip decisions from the SAME gates the
		// render below uses, so the console/CLI can show what shipped (and why a service
		// was skipped) instead of guessing from output presence.
		result.InfraServices = argocd.InfraServiceDecisions(facts)
		// Connector-backed external-dns providers read a token Secret that must exist
		// before the Application's first sync (mirrors ensureArgoRedisSecret's pre-seed).
		switch facts.DNSProvider() {
		case "cloudflare":
			token := vc.ConnectorCredentialFor("dns", "cloudflare")["api_token"]
			if err := argocd.EnsureExternalDNSSecret("external-dns-cloudflare", "apiToken", token, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to seed the cloudflare external-dns secret: %w", err)
			}
		case "webhook":
			if err := argocd.EnsureExternalDNSSecret("external-dns-hetzner", "token", os.Getenv("HCLOUD_TOKEN"), stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to seed the hetzner external-dns secret: %w", err)
			}
		}
		renderedDir, renderErr := argocd.RenderApplications(argoTemplatesDir, facts)
		if renderErr != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepRender, renderErr)
			return &result, fmt.Errorf("failed to render ArgoCD applications: %w", renderErr)
		}
		defer os.RemoveAll(renderedDir)
		if applyErr := argocd.ApplyApplications(renderedDir, stdout, stderr); applyErr != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, applyErr)
			return &result, fmt.Errorf("failed to apply ArgoCD infrastructure applications: %w", applyErr)
		}
		// Post-apply Karpenter node class (AWS + enable_karpenter only). Karpenter launches EC2
		// via its OWN AWS API calls, so the OpenTofu provider default_tags never reach them — the
		// EC2NodeClass spec.tags (from the karpenter_node_tags output) is the ONLY lever that
		// stamps the classification + sweep-handle tags onto launched instances/volumes (gap G2).
		// Non-fatal like the add-on path: a node-class hiccup must not fail an otherwise-healthy
		// cluster — the operator sees the warning and Karpenter still runs (it just can't scale
		// until the CR lands). The apply retries because the CRDs sync in asynchronously.
		setStage("karpenter")
		if kErr := applyKarpenterNodeClass(ctx, result.Outputs, facts, stdout, stderr); kErr != nil {
			fmt.Fprintf(stderr, "Warning: Karpenter EC2NodeClass/NodePool setup skipped: %v\n", kErr)
		}
		// Remove infra-service objects earlier deploys applied but this render skipped
		// (pre-parity clusters carry a broken external-dns / a foreign-cloud secret store).
		argocd.CleanupSkippedInfraServices(facts, stdout, stderr)

		// Generate app manifests for detected services into an EMPTY apps repo (never
		// clobbers a bring-your-own repo). Non-fatal: a git edge case must not fail an
		// otherwise-healthy cluster — the operator can add manifests later.
		if genErr := generateAppManifests(vc, result.Outputs, params.GitAccessToken, stdout, stderr); genErr != nil {
			fmt.Fprintf(stderr, "Warning: app manifest generation skipped: %v\n", genErr)
		}

		setStage("addons")
		// Marketplace add-ons — MANAGED mode: render the customer's enabled OSS charts as
		// ArgoCD Helm Applications and apply them; GITOPS mode: seed the manifests into the
		// customer's apps repo (they own + edit them). Then prune disabled managed add-ons and
		// read health back for the console. Non-fatal (like app-manifest generation): a bad
		// add-on must not fail an otherwise-healthy cluster; status surfaces on the add-ons page.
		if len(vc.AddOns) > 0 {
			// Operator wave FIRST (the manifest rail): Kubernetes operators ship as a plain
			// `kubectl apply` release manifest, which an ArgoCD Application cannot source. The
			// runner applies them server-side and waits for the CRDs they own to become
			// Established — so a CR Application synced below (a RabbitmqCluster, a CNPG Cluster)
			// can never race the operator that owns its schema. ArgoCD sync-waves do NOT order
			// across separate top-level Applications, so this ordering must happen here.
			if mErr := argocd.ApplyManifestAddOns(ctx, vc.AddOns, stdout, stderr); mErr != nil {
				fmt.Fprintf(stderr, "Warning: operator manifest add-ons failed: %v\n", mErr)
			}

			// Bring-your-own (git-source) charts: pin them to a hardened per-project AppProject
			// and register their per-repo credentials BEFORE rendering the Applications, so the
			// renderer places them in "byo-<slug>" (not the wide-open "infra" project).
			prepareByoCharts(vc, params.GitAccessToken, params.GitRepoTokens, facts.Labels, stdout, stderr)

			// Seed each add-on's secret-knob Secret (W4.5 #640) BEFORE any Application syncs —
			// managed or gitops mode. The values were fetched by the runner over the
			// authenticated job channel and exist nowhere else: not in the snapshot, not in the
			// rendered manifest, not in the customer's repo. The chart consumes them via the
			// SecretKeyRef wiring the console resolved into helm.values.
			argocd.EnsureAddOnSecrets(vc.AddOns, params.AddOnSecretValues, stdout, stderr)

			addonDir, addonErr := argocd.RenderManagedAddOns(vc.AddOns, facts.Labels)
			if addonErr != nil {
				fmt.Fprintf(stderr, "Warning: marketplace add-ons skipped: %v\n", addonErr)
			} else {
				defer os.RemoveAll(addonDir)
				// Apply the Applications in ascending sync-wave order, waiting after each wave for
				// the CRDs it establishes. ArgoCD's sync-wave annotation does NOT order separate
				// top-level Applications, so a Helm operator (CloudNativePG) and an Application
				// carrying a CR that needs its schema (a CNPG Cluster) would otherwise race — the
				// CR's first sync failing with `no matches for kind`.
				if applyErr := argocd.ApplyAddOnsInWaves(vc.AddOns, addonDir, stdout, stderr); applyErr != nil {
					fmt.Fprintf(stderr, "Warning: marketplace add-ons apply failed: %v\n", applyErr)
				}
			}
			// GitOps-mode add-ons → seed/prune into the customer's apps repo.
			if gitErr := writeAddOnGitOps(vc, params.GitAccessToken, facts.Labels, stdout, stderr); gitErr != nil {
				fmt.Fprintf(stderr, "Warning: GitOps add-on sync skipped: %v\n", gitErr)
			}
		}
		// Prune managed add-ons the user disabled (removed from the desired set). Runs even
		// when vc.AddOns is empty, so disabling the last add-on still cleans it up.
		if pruneErr := argocd.PruneManagedAddOns(argocd.ManagedAddOnNames(vc.AddOns), stdout, stderr); pruneErr != nil {
			fmt.Fprintf(stderr, "Warning: add-on prune failed: %v\n", pruneErr)
		}
		// And the runner-seeded secret of any disabled add-on (W4.5) — no Application owns
		// those Secrets (deliberately: no ArgoCD tracking metadata), so ArgoCD will never
		// prune them; this is their only GC.
		argocd.PruneAddOnSecrets(enabledAddonIDs(vc.AddOns), stdout, stderr)
		// Read ArgoCD health/sync for every enabled add-on (managed + gitops) so the console
		// shows real status (best-effort — a read failure just leaves status Unknown).
		//
		// WAIT for convergence first. The read used to run the instant after `kubectl apply`, when
		// every Application is still Progressing/Missing — so a database that was about to come up
		// perfectly was persisted as "Creating"… and nothing ever refreshed it (the day-2 refresh
		// only updates project_addons rows, and the synthesized Hetzner data-service specs have
		// none). The wait is bounded and best-effort: an add-on that never converges is reported
		// honestly rather than failing an otherwise-healthy cluster.
		if len(vc.AddOns) > 0 {
			result.AddOnStatus = argocd.WaitAddOnsHealthy(
				ctx,
				argocd.AllAddOnNames(vc.AddOns),
				addonConvergeTimeout(),
				stdout,
				stderr,
			)
			// In-cluster data services (Hetzner database/cache/queue) are ArgoCD Applications, so
			// they have no tofu output carrying a connection string — the console showed NO endpoint
			// at all ("endpoint discovery is chart-specific and deferred"). Now that they've
			// converged, read their Service endpoint + credential REFERENCE back FROM THE CLUSTER.
			// Never derived from a chart's fullname template: a wrong endpoint is worse than none.
			if eps := argocd.ReadDataEndpoints(vc.AddOns, stdout, stderr); len(eps) > 0 {
				fmt.Fprintf(stdout, "Read %d in-cluster data-service endpoint(s).\n", len(eps))
				result.DataEndpoints = eps
			}
		}
		// Read the cluster's Trivy-Operator vulnerability posture (L9). Best-effort +
		// unconditional: `Scanned=false` when Trivy isn't installed, so the Evidence Security
		// tab shows an honest "not scanned" rather than a misleading all-clear. Refreshed on
		// every deploy (Trivy scans asynchronously after it's installed).
		sec := argocd.ReadSecurityPosture(stdout, stderr)
		result.SecurityPosture = &sec
		// GitOps wiring surfaced honestly (issue #574): the wiring succeeded to here, so
		// record mode + (in gitops mode) the apps Application's synced revision and
		// per-workload health. Best-effort read — an unreadable status reports Unknown,
		// never a fabricated pass. Always non-nil after a real apply so the console can
		// tell "direct mode" from "pre-#574 job with no data".
		result.GitopsStatus = readGitopsSnapshot(gitopsRequested, vc.Repositories.AppsDestinationRepo, stdout, stderr)
	}

	fmt.Fprintln(stdout, "Deployment completed successfully.")
	return &result, nil
}

// runnerIdentity is a best-effort identifier for the executor, recorded in the
// evidence receipt.
func runnerIdentity() string {
	if id := os.Getenv("ALETHIA_RUNNER_INSTANCE_ID"); id != "" {
		return id
	}
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return "unknown-runner"
}

// attachReceipt builds, signs (if a key is configured), and attaches the per-apply
// evidence receipt to the result. It is a no-op when there is no verification
// report (e.g. the plan JSON could not be produced). `override` is the waiver that
// was applied on the apply path (nil on dry-run / plan jobs), recorded in the
// receipt as an exception.
func attachReceipt(result *PlanResult, planFile string, planJSON *tfjson.Plan, override *verify.Override, stdout io.Writer) {
	if result.VerifyReport == nil {
		return
	}
	planBytes, _ := os.ReadFile(planFile)
	tofuVer := ""
	if planJSON != nil {
		tofuVer = planJSON.TerraformVersion
	}
	receipt := verify.BuildReceipt(verify.BuildReceiptParams{
		Report:      result.VerifyReport,
		PlanBytes:   planBytes,
		TofuVersion: tofuVer,
		Override:    override,
		Runner:      runnerIdentity(),
		EvaluatedAt: time.Now().UTC().Format(time.RFC3339),
	})

	priv, keyID, ok, err := verify.SigningKeyFromEnv()
	if err != nil {
		fmt.Fprintf(stdout, "Warning: receipt signing key invalid: %v — attaching unsigned receipt\n", err)
	}
	if ok {
		if signed, sErr := verify.Sign(receipt, priv, keyID); sErr != nil {
			fmt.Fprintf(stdout, "Warning: receipt signing failed: %v — attaching unsigned receipt\n", sErr)
			result.VerifyReceipt = &verify.SignedReceipt{Receipt: receipt, Algorithm: "none"}
		} else {
			result.VerifyReceipt = signed
			fmt.Fprintf(stdout, "Evidence receipt signed (key %s, plan sha256 %s)\n", keyID, shortHash(receipt.PlanSHA256))
		}
		return
	}
	result.VerifyReceipt = &verify.SignedReceipt{Receipt: receipt, Algorithm: "none"}
	fmt.Fprintf(stdout, "Evidence receipt built (unsigned — set %s to sign)\n", verify.SigningKeyEnv)
}

func shortHash(h string) string {
	if len(h) <= 12 {
		return h
	}
	return h[:12] + "…"
}

func resolveArgoTemplatesDir() string {
	candidates := []string{
		// Explicit override — a runner image with a non-default layout, or an
		// in-process E2E driving the real spine from an arbitrary CWD, can point
		// directly at the baked templates.
		os.Getenv("ALETHIA_ARGOCD_TEMPLATES_DIR"),
		"/home/runner/argocd-templates",
		"argocd-templates",
		"../../infra/templates/argocd",
	}
	for _, d := range candidates {
		if d == "" {
			continue
		}
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func installArgoCD(ctx context.Context, vc *types.ProjectConfig, outputs map[string]interface{}, result *PlanResult, stdout, stderr io.Writer) error {
	fmt.Fprintln(stdout, "Installing ArgoCD...")

	addRepoCmd := "helm repo add argo https://argoproj.github.io/argo-helm && helm repo update"
	if err := utils.ExecuteCommand(addRepoCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to add ArgoCD helm repo: %w", err)
	}

	// Pre-seed the argocd-redis secret BEFORE the chart's pre-install `redis-secret-init` hook
	// runs. That hook (`argocd admin redis-initial-password`) crash-looped with exit 20 on Talos —
	// argocd's generic-error exit on the first K8s API call from the hook pod (RBAC/hook-ordering
	// race, or the hook pod on a node whose datapath wasn't ready) — which blocks the WHOLE chart
	// install so `helm --wait` hangs then fails. Seeding the secret first makes the hook's Create a
	// no-op (AlreadyExists) and its Get succeed. Redis keeps a strong random auth. Idempotent: we
	// never overwrite an existing secret (that would desync running redis from its clients).
	if err := ensureArgoRedisSecret(stdout, stderr); err != nil {
		return fmt.Errorf("failed to pre-seed the argocd-redis secret: %w", err)
	}

	installCmd := "helm upgrade --install argo-cd argo/argo-cd --namespace argocd --create-namespace --version 7.1.3 --wait --timeout 5m"

	if vc.DNS.Enabled && vc.DNS.DomainName != "" {
		argoHost := fmt.Sprintf("argocd.%s", vc.DNS.DomainName)
		certArn := argocd.ExtractOutput(outputs, "acm_certificate_arn")
		if certArn != "" {
			installCmd += fmt.Sprintf(
				" --set configs.params.server\\.insecure=true"+
					" --set server.ingress.enabled=true"+
					" --set server.ingress.ingressClassName=alb"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/scheme=internet-facing'"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/target-type=ip'"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/listen-ports=[{\"HTTPS\":443}]'"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/certificate-arn=%s'"+
					" --set 'server.ingress.hosts[0]=%s'",
				certArn, argoHost)
			fmt.Fprintf(stdout, "Configuring ArgoCD Ingress at %s\n", argoHost)
			// The URL is only real when the ingress above is actually configured (AWS
			// ALB+ACM today). Setting it from DomainName alone reported a URL that
			// resolves nowhere on every other cloud.
			result.ArgocdURL = fmt.Sprintf("https://%s", argoHost)
		}
	}

	if err := utils.ExecuteCommand(installCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to install ArgoCD: %w", err)
	}

	// The admin password is NOT extracted here: it stays in the `argocd-initial-admin-secret`
	// Secret and is retrieved on-demand from the cluster
	// (`kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`).
	// Reading it into the deploy result would carry plaintext across the sandbox boundary and into
	// the console's execution_metadata (Postgres) — a secret leak. The console shows the retrieval
	// command instead of a stored password.
	fmt.Fprintln(stdout, "ArgoCD installed.")

	if result.ArgocdURL != "" {
		fmt.Fprintf(stdout, "ArgoCD ready. URL: %s\n", result.ArgocdURL)
	} else {
		fmt.Fprintln(stdout, "ArgoCD ready (no ingress on this cloud yet — access via port-forward; retrieve the admin password on-demand from argocd-initial-admin-secret).")
	}
	return nil
}

// ensureArgoRedisSecret creates the `argocd-redis` Secret (key `auth`) with a strong random
// password BEFORE the argo-cd helm install, but ONLY if it does not already exist. The chart's
// pre-install `redis-secret-init` hook otherwise races/fails on Talos (E1 finding, exit 20),
// blocking the whole install. Idempotent by design — never overwrite an existing auth, or a
// running redis desyncs from its clients. The secret carries Helm ownership metadata so the chart
// ADOPTS it (without these, Helm errors "invalid ownership metadata").
func ensureArgoRedisSecret(stdout, stderr io.Writer) error {
	// Ensure the namespace exists (the helm install also uses --create-namespace, but we seed first).
	nsCmd := "kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -"
	if err := utils.ExecuteCommand(nsCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("ensure argocd namespace: %w", err)
	}

	// Idempotency guard: never regenerate an existing password.
	if out, err := utils.ExecuteCommandWithOutput(
		"kubectl get secret argocd-redis -n argocd -o jsonpath={.data.auth}", ".", nil); err == nil && strings.TrimSpace(out) != "" {
		fmt.Fprintln(stdout, "argocd-redis secret already present; leaving its auth untouched.")
		return nil
	}

	buf := make([]byte, 32) // 256-bit password
	if _, err := rand.Read(buf); err != nil {
		return fmt.Errorf("generate redis password: %w", err)
	}
	auth := hex.EncodeToString(buf)

	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: argocd-redis
  namespace: argocd
  labels:
    app.kubernetes.io/name: argocd-redis
    app.kubernetes.io/part-of: argocd
    app.kubernetes.io/managed-by: Helm
  annotations:
    meta.helm.sh/release-name: argo-cd
    meta.helm.sh/release-namespace: argocd
type: Opaque
stringData:
  auth: %s
`, auth)

	dir, err := os.MkdirTemp("", "alethia-argocd-redis-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "argocd-redis.yaml")
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	if err := utils.ExecuteCommand("kubectl apply -f "+path, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("apply argocd-redis secret: %w", err)
	}
	fmt.Fprintln(stdout, "Pre-seeded argocd-redis secret (avoids the chart's flaky redis-secret-init hook).")
	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		// Preserve symlinks rather than dereferencing them. The baked, pre-initialized
		// `.terraform/providers` tree holds symlinks into the shared plugin cache;
		// reading through them would copy hundreds of MB per job (and fail outright on
		// links that point at directories). filepath.Walk uses Lstat, so symlinks
		// arrive here with ModeSymlink set and are not descended into.
		if info.Mode()&os.ModeSymlink != 0 {
			linkDest, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			return os.Symlink(linkDest, target)
		}
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
}
