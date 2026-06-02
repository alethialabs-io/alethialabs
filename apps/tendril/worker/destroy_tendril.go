package worker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/terraform"
)

func (w *Worker) executeDestroyWorker(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	cfg, err := parseWorkerDestroyConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse worker destroy config: %w", err)
	}

	if cfg.CloudProvider == "" {
		cfg.CloudProvider = provider
	}
	if cfg.CloudProvider == "" {
		cfg.CloudProvider = "aws"
	}

	templatesDir := resolveTendrilTemplatesDir()
	if templatesDir == "" {
		return fmt.Errorf("worker templates directory not found")
	}

	providerDir := filepath.Join(templatesDir, cfg.CloudProvider)
	if _, err := os.Stat(providerDir); err != nil {
		return fmt.Errorf("no templates for provider %s: %w", cfg.CloudProvider, err)
	}

	fmt.Fprintf(stdout, "Destroying worker %q (%s) in %s/%s\n", cfg.WorkerName, cfg.WorkerID[:8], cfg.CloudProvider, cfg.Region)

	tmpRoot, err := os.MkdirTemp("", "grape-destroy-worker-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	workDir := filepath.Join(tmpRoot, "work")
	if err := copyDir(providerDir, workDir); err != nil {
		return fmt.Errorf("failed to copy worker templates: %w", err)
	}

	varFile, err := terraform.OverrideTfvarsFromMap(workDir, map[string]any{
		"worker_id":        cfg.WorkerID,
		"worker_token":     "destroy-placeholder",
		"worker_name":      cfg.WorkerName,
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

	fmt.Fprintln(stdout, "Running terraform destroy...")
	if err := tf.Destroy(ctx, varFile); err != nil {
		return fmt.Errorf("terraform destroy failed: %w", err)
	}

	fmt.Fprintln(stdout, "Deleting worker record...")
	if err := w.api.DeleteWorker(cfg.WorkerID); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to delete worker record: %v\n", err)
	}

	fmt.Fprintf(stdout, "Worker %q destroyed successfully\n", cfg.WorkerName)
	return nil
}
