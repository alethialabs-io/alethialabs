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
}

// RunDriftDetection reconciles an environment's recorded state with the live cloud
// via `tofu plan -refresh-only` and returns a drift Posture. It mutates nothing in
// the cloud (refresh-only) and never applies — the "keep proving it" check. The
// state-backend setup mirrors RunDeployV2 so it reads the same workspace state.
func RunDriftDetection(ctx context.Context, params DriftParams) (*drift.Posture, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunDriftDetection")
	}
	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state access")
	}
	if params.TemplatesDir == "" {
		return nil, fmt.Errorf("TemplatesDir is required")
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

	tmpRoot, err := os.MkdirTemp("", "alethia-drift-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	tfDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(params.TemplatesDir, tfDir); err != nil {
		return nil, fmt.Errorf("failed to copy templates: %w", err)
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	tfvars := provider.ProviderTfvars(vc)
	if _, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
		return nil, fmt.Errorf("connector composition failed: %w", composeErr)
	}
	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}

	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	planFile := filepath.Join(tfDir, "drift.plan.out")
	if _, err := tf.PlanRefreshOnly(ctx, varFile, planFile); err != nil {
		return nil, fmt.Errorf("tofu plan -refresh-only failed: %w", err)
	}

	planJSON, showErr := tf.ShowPlanJSON(ctx, planFile)
	if showErr != nil {
		return nil, fmt.Errorf("tofu show -json failed: %w", showErr)
	}

	posture := drift.Analyze(planJSON)
	if b, mErr := json.Marshal(posture); mErr == nil {
		fmt.Fprintf(stdout, "Drift posture: %s\n", string(b))
	}
	return posture, nil
}
