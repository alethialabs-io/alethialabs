// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
)

type runnerDeployConfig struct {
	RunnerID        string `json:"runner_id"`
	RunnerToken     string `json:"runner_token"`
	RunnerName      string `json:"runner_name"`
	ImageTag        string `json:"image_tag"`
	Region          string `json:"region"`
	CloudProvider   string `json:"cloud_provider"`
	AlethiaURL      string `json:"alethia_url"`
	CPU             int    `json:"cpu"`
	Memory          int    `json:"memory"`
	ImageRepository string `json:"image_repository"`
}

func (w *Runner) executeDeployRunner(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	cfg, err := parseRunnerDeployConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse runner deploy config: %w", err)
	}

	if cfg.CloudProvider == "" {
		cfg.CloudProvider = provider
	}
	if cfg.CloudProvider == "" {
		cfg.CloudProvider = "aws"
	}
	if cfg.ImageTag == "" {
		cfg.ImageTag = "latest"
	}
	if cfg.CPU == 0 {
		cfg.CPU = 512
	}
	if cfg.Memory == 0 {
		cfg.Memory = 1024
	}
	templatesDir := resolveRunnerTemplatesDir()
	if templatesDir == "" {
		return fmt.Errorf("runner templates directory not found")
	}

	providerDir := filepath.Join(templatesDir, cfg.CloudProvider)
	if _, err := os.Stat(providerDir); err != nil {
		return fmt.Errorf("no templates for provider %s: %w", cfg.CloudProvider, err)
	}

	fmt.Fprintf(stdout, "Deploying runner %q (%s) to %s/%s\n", cfg.RunnerName, shortID(cfg.RunnerID, 8), cfg.CloudProvider, cfg.Region)

	tmpRoot, err := os.MkdirTemp("", "alethia-deploy-runner-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	workDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(providerDir, workDir); err != nil {
		return fmt.Errorf("failed to copy runner templates: %w", err)
	}

	tfvars := map[string]interface{}{
		"runner_id":        cfg.RunnerID,
		"runner_token":     cfg.RunnerToken,
		"runner_name":      cfg.RunnerName,
		"alethia_url":      cfg.AlethiaURL,
		"image_tag":        cfg.ImageTag,
		"region":           cfg.Region,
		"cpu":              cfg.CPU,
		"memory":           cfg.Memory,
		"image_repository": cfg.ImageRepository,
	}

	varFile, err := tofu.OverrideTfvarsFromMap(workDir, tfvars)
	if err != nil {
		return fmt.Errorf("failed to write tfvars: %w", err)
	}

	// Runner-lifecycle state lives on the console http proxy (keyed server-side by the target
	// runner id), so the fleet needs no storage master credentials. The per-job token authorizes
	// state I/O and reaches tofu via TF_HTTP_PASSWORD (never a workdir file).
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

	tf, err := tofu.NewTofuCLI(ctx, tofu.ResolvedIaCVersion(), workDir, stdout, stderr)
	if err != nil {
		return fmt.Errorf("tofu setup failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running tofu init...")
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return fmt.Errorf("tofu init failed: %w", err)
	}

	planFile := filepath.Join(workDir, "tofu.plan.out")
	fmt.Fprintln(stdout, "Running tofu plan...")
	if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
		return fmt.Errorf("tofu plan failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running tofu apply...")
	if err := tf.Apply(ctx, planFile); err != nil {
		return fmt.Errorf("tofu apply failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read tofu outputs: %v\n", err)
	} else if len(outputs) > 0 {
		_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
			"runner_outputs": outputs,
		})
	}

	// Persist the redeploy-able config, but NEVER the runner_token: it is a live bearer credential
	// and runners.metadata is plaintext JSONB. The console holds only its SHA-256 hash and re-mints a
	// fresh token for each UPDATE/DESTROY job, so nothing needs the plaintext at rest (#945).
	if err := w.api.UpdateRunnerMetadata(cfg.RunnerID, map[string]any{
		"deploy_config": map[string]any{
			"region":           cfg.Region,
			"cloud_provider":   cfg.CloudProvider,
			"image_tag":        cfg.ImageTag,
			"alethia_url":      cfg.AlethiaURL,
			"cpu":              cfg.CPU,
			"memory":           cfg.Memory,
			"image_repository": cfg.ImageRepository,
		},
	}); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to save deploy config to runner metadata: %v\n", err)
	}

	fmt.Fprintf(stdout, "Runner %q deployed successfully\n", cfg.RunnerName)
	return nil
}

func resolveRunnerTemplatesDir() string {
	candidates := []string{
		"/home/runner/runner-templates",
		"runner-templates",
		"../../infra/templates/runner",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func parseRunnerDeployConfig(snapshot map[string]any) (*runnerDeployConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var cfg runnerDeployConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.RunnerID == "" || cfg.RunnerToken == "" {
		return nil, fmt.Errorf("runner_id and runner_token are required in config_snapshot")
	}
	return &cfg, nil
}

func parseRunnerDestroyConfig(snapshot map[string]any) (*runnerDeployConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var cfg runnerDeployConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.RunnerID == "" {
		return nil, fmt.Errorf("runner_id is required in config_snapshot")
	}
	return &cfg, nil
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
