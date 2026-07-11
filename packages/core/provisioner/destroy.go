// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

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
}

// RunDestroy tears down a project environment. It rebuilds the tofu workdir from
// the bundled templates, initializes the http state backend (pulling the recorded
// state), and runs `tofu destroy`. It mirrors RunDeployV2's workdir setup so the
// destroy plan matches what was applied.
func RunDestroy(ctx context.Context, params DestroyParams) error {
	vc := params.ProjectConfig
	if vc == nil {
		return fmt.Errorf("ProjectConfig is required for RunDestroy")
	}
	if params.StateBackend == nil {
		return fmt.Errorf("StateBackend config is required for state access")
	}
	if params.TemplatesDir == "" {
		return fmt.Errorf("TemplatesDir is required")
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
		return err
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

	tmpRoot, err := os.MkdirTemp("", "alethia-destroy-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	tfDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(params.TemplatesDir, tfDir); err != nil {
		return fmt.Errorf("failed to copy templates: %w", err)
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, out, stderr)
	if err != nil {
		return fmt.Errorf("failed to initialize OpenTofu CLI: %w", err)
	}

	// Reconstruct the same tfvars the apply used so the destroy plan resolves the
	// same variables (greenfield/provisioned-network is the common case; brownfield
	// subnet re-resolution is a follow-up).
	tfvars := provider.ProviderTfvars(vc)
	if _, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, out); composeErr != nil {
		return fmt.Errorf("connector composition failed: %w", composeErr)
	}
	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return fmt.Errorf("failed to write tfvars: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return fmt.Errorf("failed to write backend config: %w", err)
	}
	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return fmt.Errorf("tofu init failed: %w", err)
	}

	fmt.Fprintln(out, "   Destroying Cloud Resources (this may take 10-15 mins)...")
	if err := tf.Destroy(ctx, varFile); err != nil {
		return fmt.Errorf("tofu destroy failed: %w", err)
	}

	fmt.Fprintln(out, "Environment destroyed successfully!")
	return nil
}
