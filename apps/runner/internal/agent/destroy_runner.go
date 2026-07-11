// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
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

	varFile, err := tofu.OverrideTfvarsFromMap(workDir, map[string]any{
		"runner_id":        cfg.RunnerID,
		"runner_token":     "destroy-placeholder",
		"runner_name":      cfg.RunnerName,
		"alethia_url":      cfg.AlethiaURL,
		"image_tag":        cfg.ImageTag,
		"region":           cfg.Region,
		"cpu":              cfg.CPU,
		"memory":           cfg.Memory,
		"image_repository": cfg.ImageRepository,
	})
	if err != nil {
		return fmt.Errorf("failed to write tfvars: %w", err)
	}

	// Runner-lifecycle state on the console http proxy (no storage master creds on the fleet).
	stateToken, err := w.api.FetchStateToken(job.ID)
	if err != nil {
		return fmt.Errorf("failed to fetch state token: %w", err)
	}
	stateBackend := &cloud.HTTPBackendConfig{ConsoleURL: w.config.AlethiaURL, JobID: job.ID, Token: stateToken}
	backendFile, err := stateBackend.WriteBackendHCL(workDir)
	if err != nil {
		return fmt.Errorf("failed to write backend config: %w", err)
	}
	restoreStateAuth := stateBackend.SetAuthEnv()
	defer restoreStateAuth()
	fmt.Fprintln(stdout, "State backend: console HTTP proxy (per-job token)")

	tfVersion := "1.15.5"
	tf, err := tofu.NewTofuCLI(ctx, tfVersion, workDir, stdout, stderr)
	if err != nil {
		return fmt.Errorf("tofu setup failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running tofu init...")
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return fmt.Errorf("tofu init failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running tofu destroy...")
	if err := tf.Destroy(ctx, varFile); err != nil {
		return fmt.Errorf("tofu destroy failed: %w", err)
	}

	// Best-effort: purge the now-empty state object (tofu's http backend leaves it behind).
	if err := w.api.PurgeProjectState(job.ID, stateToken); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to purge tofu state: %v\n", err)
	}

	fmt.Fprintln(stdout, "Deleting runner record...")
	if err := w.api.DeleteRunner(cfg.RunnerID); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to delete runner record: %v\n", err)
	}

	fmt.Fprintf(stdout, "Runner %q destroyed successfully\n", cfg.RunnerName)
	return nil
}
