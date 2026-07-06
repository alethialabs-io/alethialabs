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
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
)

type DestroyParams struct {
	ProjectName      string
	Environment      string
	Region           string
	CleanupWorkspace bool
	Stdout           io.Writer
	Stderr           io.Writer
	ApiClient        *api.Client
}

func RunDestroy(ctx context.Context, params DestroyParams) error {
	out := params.Stdout
	if out == nil {
		out = os.Stdout
	}

	workspaceName := fmt.Sprintf("%s-%s", params.ProjectName, params.Environment)

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	workDir := filepath.Join(home, ".alethia", "workspaces", workspaceName)
	if _, err := os.Stat(workDir); os.IsNotExist(err) {
		return fmt.Errorf("workspace directory not found: %s", workDir)
	}

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

	tf, err := tofu.NewTofuCLI(ctx, tofu.DefaultIaCVersion, workDir, out, out)
	if err != nil {
		return fmt.Errorf("failed to initialize OpenTofu CLI: %w", err)
	}

	fmt.Fprintln(out, "   Destroying Cloud Resources (this may take 10-15 mins)...")
	if err := tf.Destroy(ctx, "tofu.tfvars"); err != nil {
		return fmt.Errorf("tofu destroy failed: %w", err)
	}

	if params.CleanupWorkspace {
		fmt.Fprintln(out, "   Cleaning up workspace directory...")
		if err := os.RemoveAll(workDir); err != nil {
			fmt.Fprintf(out, "   Warning: Failed to remove workspace directory: %v\n", err)
		} else {
			fmt.Fprintln(out, "   Workspace directory removed.")
		}
	}

	fmt.Fprintln(out, "Environment destroyed successfully!")
	return nil
}
