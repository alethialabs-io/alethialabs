// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
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
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/aws/aws-sdk-go-v2/config"
	tfjson "github.com/hashicorp/terraform-json"
)

type DeployParams struct {
	ProjectConfig  *types.ProjectConfig
	Provider       string
	PlanFile       string
	DryRun         bool
	UpdateInfra    bool
	InfracostToken string
	GitAccessToken string
	TemplatesDir   string
	// CategoriesDir is the root of the composable per-category modules
	// (infra/templates/categories). When set, pluggable providers selected on the
	// Project resources are composed into the plan; native resources are guarded off via tfvars.
	CategoriesDir string
	S3Backend     *cloud.S3BackendConfig
	Stdout        io.Writer
	Stderr        io.Writer
	ApiClient     *api.Client
	DeploymentID  string
	// VerifyOverride, when set, waives specific failing verification controls so
	// a fail-closed apply can proceed deliberately. Nil means no waiver (the
	// default — any hard control failure blocks apply).
	VerifyOverride *verify.Override
}

// PlanResult holds structured output from a deployment (dry-run or full apply).
type PlanResult struct {
	PlanJSON            map[string]interface{}
	CostBreakdown       *infracost.CostBreakdown
	PlanFileBytes       []byte
	Outputs             map[string]interface{}
	ClusterName         string
	ClusterEndpoint     string
	ArgocdURL           string
	ArgocdAdminPassword string
	// VerifyReport is the deterministic verification gate's result for this plan
	// (nil if the plan JSON could not be produced). On a real apply a blocking
	// verdict stops the apply before any infrastructure changes.
	VerifyReport *verify.Report
	// VerifyReceipt is the per-apply evidence receipt sealing the report to the
	// plan hash + tool versions. Signed when a signing key is configured
	// (Algorithm "ed25519"); otherwise attached unsigned (Algorithm "none").
	VerifyReceipt *verify.SignedReceipt
}

// RunDeployV2 executes a deployment using the provider-agnostic ProjectConfig and CloudProvider interface.
func RunDeployV2(ctx context.Context, params DeployParams) (*PlanResult, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunDeployV2")
	}

	// Enforce placement discipline before anything else: a CORE resource on a
	// foreign cloud is a hot cross-cloud edge we can't provision yet. Fires on
	// dry-run (plan) too, so the user never reaches apply.
	if err := ValidatePlacement(vc); err != nil {
		return nil, err
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
	if params.TemplatesDir != "" {
		fmt.Fprintf(stdout, "Using bundled templates from %s\n", params.TemplatesDir)
		workDir := filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, workDir); err != nil {
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfDir = workDir
	} else {
		return nil, fmt.Errorf("git-based deployment not yet supported in V2; use TemplatesDir")
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	tfvars := provider.ProviderTfvars(vc)

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

	if params.S3Backend == nil {
		return nil, fmt.Errorf("S3Backend config is required for state storage")
	}
	if err := params.S3Backend.EnsureBucket(ctx); err != nil {
		return nil, fmt.Errorf("failed to ensure state bucket: %w", err)
	}
	backendFile, err := params.S3Backend.WriteBackendHCL(tfDir, vc.ProjectName, vc.EnvironmentStage, vc.Region)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}
	fmt.Fprintf(stdout, "State backend: S3 (bucket=%s)\n", params.S3Backend.Bucket)

	fmt.Fprintf(stdout, "DEBUG provider=%s, project=%v, region=%v, provision_network=%v, network_id=%q, cidr=%q\n",
		provider.Name(), tfvars["project_name"], vc.Region, vc.Network.ProvisionNetwork, vc.Network.NetworkID, vc.Network.CIDRBlock)

	// Compose pluggable per-category connector modules (Cloudflare DNS, Vault,
	// Docker Hub, observability). This merges their tfvars (including decrypted
	// secrets resolved at claim time), copies the modules into the work dir, and
	// sets the native-guard vars so the cluster cloud skips its native resource.
	if composed, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
		return nil, fmt.Errorf("connector composition failed: %w", composeErr)
	} else if composed > 0 {
		fmt.Fprintf(stdout, "Composed %d pluggable connector module(s).\n", composed)
	}

	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "tofu.plan.out"))
	if err != nil {
		return nil, err
	}

	// Suspend AWS env creds during init so the S3 backend uses inline creds from backend.hcl
	// (ECS task role always sets AWS env vars, which would override the S3 endpoint)
	savedCreds := suspendAWSEnvCreds()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		restoreAWSEnvCreds(savedCreds)
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}
	restoreAWSEnvCreds(savedCreds)

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

	// Fail-closed enforcement: a real apply must not proceed while any hard
	// verification control is failing and unwaived. An authorized override may
	// waive specific controls (recorded for the evidence receipt in Phase 1);
	// disabling the gate wholesale is deliberately not an option here.
	if result.VerifyReport != nil {
		if unresolved := result.VerifyReport.Unwaived(params.VerifyOverride); len(unresolved) > 0 {
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

	fmt.Fprintln(stdout, "Applying OpenTofu changes...")
	if err := tf.Apply(ctx, planFile); err != nil {
		return nil, fmt.Errorf("tofu apply failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tofu outputs: %w", err)
	}

	result.Outputs = outputs
	result.ClusterName = cloud.ExtractClusterName(outputs)
	result.ClusterEndpoint = cloud.ExtractClusterEndpoint(outputs)

	if result.ClusterName != "" {
		if err := provider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
			fmt.Fprintf(stdout, "Warning: kubeconfig configuration failed: %v\n", err)
		}
	}

	if !params.DryRun && result.ClusterName != "" {
		// GitOps bootstrap. The cluster is provisioned; ArgoCD + the infra-services
		// (external-dns, karpenter, ALB controller, …) and the user's apps-repo
		// connection are the "GitOps, wired — not just installed" promise. These steps
		// FAIL the job rather than logging a buried warning: a half-wired cluster that
		// reports success is worse than an honest failure the operator can act on.
		gitopsRequested := vc.Repositories.AppsDestinationRepo != ""

		if err := installArgoCD(ctx, vc, result.Outputs, &result, stdout, stderr); err != nil {
			if gitopsRequested {
				return nil, fmt.Errorf("ArgoCD install failed (GitOps requested for repo %s): %w", vc.Repositories.AppsDestinationRepo, err)
			}
			fmt.Fprintf(stderr, "Warning: ArgoCD installation failed: %v\n", err)
		}

		if gitopsRequested {
			if params.GitAccessToken == "" {
				return nil, fmt.Errorf("GitOps requested (apps repo %s) but no git access token is available — reconnect the git provider for this project", vc.Repositories.AppsDestinationRepo)
			}
			if err := argocd.ConfigureRepoCredentials(vc.Repositories.AppsDestinationRepo, params.GitAccessToken, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to connect ArgoCD to apps repo %s: %w", vc.Repositories.AppsDestinationRepo, err)
			}
		}

		argoTemplatesDir := resolveArgoTemplatesDir()
		if argoTemplatesDir == "" {
			// Templates are baked into the runner image; their absence is a build defect,
			// not a user error. Silently skipping infra-services left clusters half-wired.
			return nil, fmt.Errorf("ArgoCD application templates not found (looked in /home/runner/argocd-templates, argocd-templates, ../../infra/templates/argocd) — the runner image is missing its baked templates")
		}
		facts := argocd.BuildFromOutputs(result.Outputs, vc)
		renderedDir, renderErr := argocd.RenderApplications(argoTemplatesDir, facts)
		if renderErr != nil {
			return nil, fmt.Errorf("failed to render ArgoCD applications: %w", renderErr)
		}
		defer os.RemoveAll(renderedDir)
		if applyErr := argocd.ApplyApplications(renderedDir, stdout, stderr); applyErr != nil {
			return nil, fmt.Errorf("failed to apply ArgoCD infrastructure applications: %w", applyErr)
		}

		// Generate app manifests for detected services into an EMPTY apps repo (never
		// clobbers a bring-your-own repo). Non-fatal: a git edge case must not fail an
		// otherwise-healthy cluster — the operator can add manifests later.
		if genErr := generateAppManifests(vc, params.GitAccessToken, stdout, stderr); genErr != nil {
			fmt.Fprintf(stderr, "Warning: app manifest generation skipped: %v\n", genErr)
		}
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
		"/home/runner/argocd-templates",
		"argocd-templates",
		"../../infra/templates/argocd",
	}
	for _, d := range candidates {
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
		}
	}

	if err := utils.ExecuteCommand(installCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to install ArgoCD: %w", err)
	}

	fmt.Fprintln(stdout, "ArgoCD installed. Extracting admin credentials...")

	passwordCmd := "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d"
	password, err := utils.ExecuteCommandWithOutput(passwordCmd, ".", nil)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not extract ArgoCD admin password: %v\n", err)
	} else {
		result.ArgocdAdminPassword = strings.TrimSpace(password)
	}

	if vc.DNS.DomainName != "" {
		result.ArgocdURL = fmt.Sprintf("https://argocd.%s", vc.DNS.DomainName)
	}

	fmt.Fprintf(stdout, "ArgoCD ready. URL: %s\n", result.ArgocdURL)
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

func suspendAWSEnvCreds() map[string]string {
	keys := []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}
	saved := make(map[string]string, len(keys))
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			saved[k] = v
			os.Unsetenv(k)
		}
	}
	return saved
}

func restoreAWSEnvCreds(saved map[string]string) {
	for k, v := range saved {
		os.Setenv(k, v)
	}
}
