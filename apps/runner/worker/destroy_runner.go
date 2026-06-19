// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/terraform"
)

func (w *Runner) executeDestroyRunner(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	cfg, err := parseRunnerDestroyConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse runner destroy config: %w", err)
	}

	if cfg.CloudProvider == "" {
		cfg.CloudProvider = provider
	}
	if cfg.CloudProvider == "" {
		cfg.CloudProvider = "aws"
	}

	templatesDir := resolveRunnerTemplatesDir()
	if templatesDir == "" {
		return fmt.Errorf("runner templates directory not found")
	}

	providerDir := filepath.Join(templatesDir, cfg.CloudProvider)
	if _, err := os.Stat(providerDir); err != nil {
		return fmt.Errorf("no templates for provider %s: %w", cfg.CloudProvider, err)
	}

	fmt.Fprintf(stdout, "Destroying runner %q (%s) in %s/%s\n", cfg.RunnerName, cfg.RunnerID[:8], cfg.CloudProvider, cfg.Region)

	tmpRoot, err := os.MkdirTemp("", "alethia-destroy-runner-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	workDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(providerDir, workDir); err != nil {
		return fmt.Errorf("failed to copy runner templates: %w", err)
	}

	varFile, err := terraform.OverrideTfvarsFromMap(workDir, map[string]any{
		"runner_id":        cfg.RunnerID,
		"runner_token":     "destroy-placeholder",
		"runner_name":      cfg.RunnerName,
		"trellis_url":      cfg.TrellisURL,
		"image_tag":        cfg.ImageTag,
		"region":           cfg.Region,
		"cpu":              cfg.CPU,
		"memory":           cfg.Memory,
		"image_repository": cfg.ImageRepository,
	})
	if err != nil {
		return fmt.Errorf("failed to write tfvars: %w", err)
	}

	backend := w.s3Backend()
	if err := backend.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("failed to ensure state bucket: %w", err)
	}
	backendFile, err := backend.WriteRunnerBackendHCL(workDir, cfg.RunnerID[:8])
	if err != nil {
		return fmt.Errorf("failed to write backend config: %w", err)
	}
	fmt.Fprintf(stdout, "State backend: S3 (runners/%s)\n", cfg.RunnerID[:8])

	tfVersion := "1.15.5"
	tf, err := terraform.NewTerraformCLI(ctx, tfVersion, workDir, stdout, stderr)
	if err != nil {
		return fmt.Errorf("terraform setup failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running terraform init...")
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running terraform destroy...")
	if err := tf.Destroy(ctx, varFile); err != nil {
		return fmt.Errorf("terraform destroy failed: %w", err)
	}

	fmt.Fprintln(stdout, "Deleting runner record...")
	if err := w.api.DeleteRunner(cfg.RunnerID); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to delete runner record: %v\n", err)
	}

	fmt.Fprintf(stdout, "Runner %q destroyed successfully\n", cfg.RunnerName)
	return nil
}
