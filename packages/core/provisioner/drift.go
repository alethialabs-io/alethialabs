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

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/drift"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tfjson "github.com/hashicorp/terraform-json"
)

// DriftParams configures a refresh-only drift-detection run.
type DriftParams struct {
	ProjectConfig *types.ProjectConfig
	Provider      string
	TemplatesDir  string
	CategoriesDir string
	// StateBackend reads project tofu state from the console's per-job http proxy
	// (same backend RunDeployV2 writes). Required.
	StateBackend *cloud.HTTPBackendConfig
	Stdout       io.Writer
	Stderr       io.Writer
	// GitAccessToken authorizes the BYO IaC clone (only used when ProjectConfig
	// carries an IacSource; falls back to ProjectConfig.GitAccessToken when empty).
	GitAccessToken string
	// ClusterEvidence, when set, reads what the environment's cluster says about the cloud
	// changes its controllers own (ClusterEvidenceReader), so an AWS Load Balancer Controller
	// rule for a live TargetGroupBinding is reported as kubernetes_owned rather than drift.
	// Consulted only while the posture still drifts; nil (BYO IaC, non-aws) changes nothing.
	ClusterEvidence ClusterEvidenceFunc
}

// RunDriftDetection reconciles an environment's recorded state with the live cloud
// via `tofu plan -refresh-only` and returns a drift Posture plus the workspace's tofu
// outputs. It mutates nothing in the cloud (refresh-only) and never applies — the
// "keep proving it" check. The state-backend setup mirrors RunDeployV2 so it reads
// the same workspace state.
//
// The outputs ride along because the day-2 InspectCluster refresh needs them:
// alibaba's ConfigureKubeconfig reads the sensitive `kubeconfig` output and hetzner mints
// one from the `talosconfig` output (#5330); neither can be synthesized from a cluster name. Outputs are read best-effort (nil on
// failure) and MUST stay in-process — callers never persist them (the runner scrubs
// sensitive outputs from anything it posts).
func RunDriftDetection(ctx context.Context, params DriftParams) (*drift.Posture, map[string]interface{}, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, nil, fmt.Errorf("ProjectConfig is required for RunDriftDetection")
	}
	if params.StateBackend == nil {
		return nil, nil, fmt.Errorf("StateBackend config is required for state access")
	}
	byoIac := vc.IacSource != nil
	if !byoIac && params.TemplatesDir == "" {
		return nil, nil, fmt.Errorf("TemplatesDir is required")
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, nil, err
	}

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	tmpRoot, err := os.MkdirTemp("", "alethia-drift-*")
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	var tfDir string
	var tfvars map[string]interface{}
	if byoIac {
		// BYO IaC: refresh-only drift MUST run the customer's module at the SAME
		// pinned commit. Clone-at-pinned-SHA + inline fail-closed gate + backend
		// override, exactly like the deploy.
		token := params.GitAccessToken
		if token == "" {
			token = vc.GitAccessToken
		}
		cloneDir := filepath.Join(tmpRoot, "clone")
		var restore func()
		tfDir, tfvars, restore, err = prepareByoIacWorkdir(ctx, vc, token, cloneDir, stdout, stderr)
		if err != nil {
			return nil, nil, err
		}
		defer restore()
	} else {
		tfDir = filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, tfDir); err != nil {
			return nil, nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfvars = provider.ProviderTfvars(vc)
		if _, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
			return nil, nil, fmt.Errorf("connector composition failed: %w", composeErr)
		}
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, nil, fmt.Errorf("tofu init failed: %w", err)
	}

	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to write backend config: %w", err)
	}

	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, nil, fmt.Errorf("tofu init failed: %w", err)
	}

	planFile := filepath.Join(tfDir, "drift.plan.out")
	if _, err := tf.PlanRefreshOnly(ctx, varFile, planFile); err != nil {
		return nil, nil, fmt.Errorf("tofu plan -refresh-only failed: %w", err)
	}

	planJSON, showErr := tf.ShowPlanJSON(ctx, planFile)
	if showErr != nil {
		return nil, nil, fmt.Errorf("tofu show -json failed: %w", showErr)
	}

	posture := drift.Analyze(planJSON)

	// Provider schemas tell the normalizer which attributes have no config path into them
	// at all — server-set, read-only fields such as google_storage_bucket.updated. Without
	// them a refresh-only check reports such a field as drift on EVERY scan, forever,
	// because only an apply rewrites state and this step never applies (#3099).
	//
	// Fetched only when the schema-free pass already reported drift, which is what makes
	// the cost acceptable. The reordering is safe because the schema evidence is
	// one-directional: it can only move a resource from drifted to dismissed, never the
	// reverse (drift.AnalyzeWithSchemas adds a dismissal tier and removes none), so an
	// in-sync posture cannot become drifted by learning more. drift's
	// TestSchemasNeverIncreaseDrift pins that invariant.
	//
	// Cost, and why there is no cache. The workdir is already `init`-ed, so this is a
	// local plugin RPC against the downloaded provider binaries: no network egress, no
	// cloud API call. It is still multi-second and hundreds of megabytes of JSON on a
	// large provider (azurerm), which is why the output is silenced
	// (tofu.ProvidersSchema) and why it runs at most once per drift job. A cache keyed on
	// provider+version would never see a second hit — RunDriftDetection builds a fresh
	// temp workdir, analyses one plan and returns, and for BYO IaC the whole call runs
	// inside a per-job container sandbox (apps/runner/internal/agent/stage.go,
	// runDriftStage) that is torn down after it. Fetching HERE rather than in the runner
	// parent also means nothing new crosses the sandbox boundary — only the marshalled
	// Posture ever does.
	//
	// Best-effort, exactly like the outputs read below: a failure must NOT fail the drift
	// check. Without a schema the schema-aware tier fails closed and never fires, so the
	// posture stays the one already computed above.
	var schemas *tfjson.ProviderSchemas
	if !posture.InSync {
		fetched, schemaErr := tf.ProvidersSchema(ctx)
		if schemaErr != nil {
			fmt.Fprintf(stderr, "Warning: could not read provider schemas; computed-attribute normalization is off for this run: %v\n", schemaErr)
		} else {
			schemas = fetched
			posture = drift.AnalyzeWithSchemas(planJSON, schemas)
		}
	}

	// Best-effort: the workspace is initialized against real state, so outputs are
	// free here. A failure must not fail the drift job — inspection just degrades.
	// Read BEFORE the cluster evidence below, whose kubeconfig acquisition needs them.
	outputs, outErr := tf.Output(ctx)
	if outErr != nil {
		fmt.Fprintf(stderr, "Warning: could not read tofu outputs for cluster inspection: %v\n", outErr)
		outputs = nil
	}

	// Cluster evidence (maintainer ruling 2026-09-30): a security-group rule the AWS Load
	// Balancer Controller opened for a TargetGroupBinding that exists is kubernetes_owned, not
	// drift. Only the cluster can say whether that binding exists, so it is read here, bounded,
	// and only while something still drifts. Best-effort and fail-closed: no reader, no access or
	// a read error leaves the posture above untouched.
	posture = applyClusterEvidence(ctx, posture, planJSON, schemas, outputs, params.ClusterEvidence, stdout, stderr)

	if b, mErr := json.Marshal(posture); mErr == nil {
		fmt.Fprintf(stdout, "Drift posture: %s\n", string(b))
	}
	return posture, outputs, nil
}
