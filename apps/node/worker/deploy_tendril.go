// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/terraform"
)

type workerDeployConfig struct {
	WorkerID        string `json:"worker_id"`
	WorkerToken     string `json:"worker_token"`
	WorkerName      string `json:"worker_name"`
	ImageTag        string `json:"image_tag"`
	Region          string `json:"region"`
	CloudProvider   string `json:"cloud_provider"`
	TrellisURL      string `json:"trellis_url"`
	CPU             int    `json:"cpu"`
	Memory          int    `json:"memory"`
	ImageRepository string `json:"image_repository"`
}

func (w *Worker) executeDeployWorker(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	cfg, err := parseWorkerDeployConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse worker deploy config: %w", err)
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
	if cfg.TrellisURL == "" {
		cfg.TrellisURL = "https://adp.prod.itgix.eu"
	}
	if cfg.ImageRepository == "" {
		cfg.ImageRepository = "787587782604.dkr.ecr.eu-west-1.amazonaws.com/tendril-dev-tendril"
	}

	templatesDir := resolveTendrilTemplatesDir()
	if templatesDir == "" {
		return fmt.Errorf("worker templates directory not found")
	}

	providerDir := filepath.Join(templatesDir, cfg.CloudProvider)
	if _, err := os.Stat(providerDir); err != nil {
		return fmt.Errorf("no templates for provider %s: %w", cfg.CloudProvider, err)
	}

	fmt.Fprintf(stdout, "Deploying worker %q (%s) to %s/%s\n", cfg.WorkerName, cfg.WorkerID[:8], cfg.CloudProvider, cfg.Region)

	tmpRoot, err := os.MkdirTemp("", "grape-deploy-worker-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	workDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(providerDir, workDir); err != nil {
		return fmt.Errorf("failed to copy worker templates: %w", err)
	}

	tfvars := map[string]interface{}{
		"worker_id":        cfg.WorkerID,
		"worker_token":     cfg.WorkerToken,
		"worker_name":      cfg.WorkerName,
		"trellis_url":      cfg.TrellisURL,
		"image_tag":        cfg.ImageTag,
		"region":           cfg.Region,
		"cpu":              cfg.CPU,
		"memory":           cfg.Memory,
		"image_repository": cfg.ImageRepository,
	}

	varFile, err := terraform.OverrideTfvarsFromMap(workDir, tfvars)
	if err != nil {
		return fmt.Errorf("failed to write tfvars: %w", err)
	}

	backend := w.supabaseBackend()
	backendFile, err := backend.WriteWorkerBackendHCL(workDir, cfg.WorkerID[:8])
	if err != nil {
		return fmt.Errorf("failed to write backend config: %w", err)
	}
	fmt.Fprintf(stdout, "State backend: Supabase S3 (workers/%s)\n", cfg.WorkerID[:8])

	tfVersion := "1.15.5"
	tf, err := terraform.NewTerraformCLI(ctx, tfVersion, workDir, stdout, stderr)
	if err != nil {
		return fmt.Errorf("terraform setup failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running terraform init...")
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	planFile := filepath.Join(workDir, "terraform.plan.out")
	fmt.Fprintln(stdout, "Running terraform plan...")
	if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
		return fmt.Errorf("terraform plan failed: %w", err)
	}

	fmt.Fprintln(stdout, "Running terraform apply...")
	if err := tf.Apply(ctx, planFile); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read terraform outputs: %v\n", err)
	} else if len(outputs) > 0 {
		w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
			"worker_outputs": outputs,
		})
	}

	if err := w.api.UpdateWorkerMetadata(cfg.WorkerID, map[string]any{
		"deploy_config": map[string]any{
			"region":           cfg.Region,
			"cloud_provider":   cfg.CloudProvider,
			"image_tag":        cfg.ImageTag,
			"trellis_url":      cfg.TrellisURL,
			"cpu":              cfg.CPU,
			"memory":           cfg.Memory,
			"image_repository": cfg.ImageRepository,
			"worker_token":     cfg.WorkerToken,
		},
	}); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to save deploy config to worker metadata: %v\n", err)
	}

	fmt.Fprintf(stdout, "Worker %q deployed successfully\n", cfg.WorkerName)
	return nil
}

func resolveTendrilTemplatesDir() string {
	candidates := []string{
		"/home/node/tendril-templates",
		"tendril-templates",
		"../../infra/templates/node",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func parseWorkerDeployConfig(snapshot map[string]any) (*workerDeployConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var cfg workerDeployConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.WorkerID == "" || cfg.WorkerToken == "" {
		return nil, fmt.Errorf("worker_id and worker_token are required in config_snapshot")
	}
	return &cfg, nil
}

func parseWorkerDestroyConfig(snapshot map[string]any) (*workerDeployConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var cfg workerDeployConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.WorkerID == "" {
		return nil, fmt.Errorf("worker_id is required in config_snapshot")
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
