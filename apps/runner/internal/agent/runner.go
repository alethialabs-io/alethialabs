// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type Config struct {
	Operator    string   // "managed" or "self"
	Providers   []string // cloud providers this runner can run (per-cloud routing); empty = any
	AlethiaURL  string
	RunnerID    string
	RunnerToken string

	S3Endpoint  string
	S3Region    string
	S3AccessKey string
	S3SecretKey string
}

type Runner struct {
	config Config
	api    JobAPI
}

func New(cfg Config) *Runner {
	client := NewRunnerAPIClient(cfg.AlethiaURL, cfg.RunnerID, cfg.RunnerToken)
	client.providers = cfg.Providers
	return &Runner{config: cfg, api: client}
}

func NewWithAPI(cfg Config, api JobAPI) *Runner {
	return &Runner{config: cfg, api: api}
}

func (w *Runner) s3Backend() *cloud.S3BackendConfig {
	return cloud.S3BackendFromConfig(
		w.config.S3Endpoint,
		w.config.S3Region,
		w.config.S3AccessKey,
		w.config.S3SecretKey,
	)
}

func (w *Runner) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var draining atomic.Bool

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\nReceived shutdown signal, finishing current job...")
		draining.Store(true)
		time.AfterFunc(10*time.Minute, func() {
			fmt.Println("Grace period expired, forcing shutdown...")
			cancel()
		})
	}()

	go w.heartbeatLoop(ctx)

	fmt.Printf("Runner started (id=%s, operator=%s, version=%s)\n", w.config.RunnerID, w.config.Operator, version.Version)
	fmt.Printf("Connected to %s; waiting for jobs (push wake + safety poll)...\n", w.config.AlethiaURL)

	return w.claimLoop(ctx, &draining)
}

func (w *Runner) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	if err := w.api.Heartbeat(); err != nil {
		fmt.Fprintf(os.Stderr, "Initial heartbeat failed: %v\n", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.api.Heartbeat(); err != nil {
				fmt.Fprintf(os.Stderr, "Heartbeat failed: %v\n", err)
			}
		}
	}
}

// claimLoop reacts to push wakes (and a slow safety poll) by draining claimable
// jobs. The wake stream gives sub-second pickup; the safety poll is the fallback if
// the stream drops. Each tick drains the queue until nothing is left for this runner.
func (w *Runner) claimLoop(ctx context.Context, draining *atomic.Bool) error {
	const safetyInterval = 30 * time.Second

	wakeCh := make(chan struct{}, 1)
	trigger := func() {
		select {
		case wakeCh <- struct{}{}:
		default: // a wake is already pending; coalesce
		}
	}

	go w.wakeLoop(ctx, trigger)

	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	trigger() // drain any backlog on startup

	for {
		if draining.Load() {
			fmt.Println("Draining: no more jobs will be claimed. Exiting.")
			return nil
		}

		select {
		case <-ctx.Done():
			return nil
		case <-safety.C:
		case <-wakeCh:
		}

		// Drain: claim and run jobs until the queue has nothing for us.
		for !draining.Load() {
			if ctx.Err() != nil {
				return nil
			}
			claim, err := w.api.ClaimJob()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Failed to claim job: %v\n", err)
				break
			}
			if claim.Job == nil {
				break
			}

			fmt.Printf("Claimed job %s (type=%s)\n", claim.Job.ID, claim.Job.JobType)
			// PLAN/DEPLOY/DESTROY provision real infra, so they keep a long timeout.
			jobTimeout := 2 * time.Hour
			jobCtx, jobCancel := context.WithTimeout(ctx, jobTimeout)
			if err := w.executeJob(jobCtx, claim); err != nil {
				fmt.Fprintf(os.Stderr, "Job %s failed: %v\n", claim.Job.ID, err)
			}
			jobCancel()
		}
	}
}

// wakeLoop maintains the push-dispatch SSE connection, reconnecting with backoff.
// Each wake event triggers a claim attempt in claimLoop.
func (w *Runner) wakeLoop(ctx context.Context, trigger func()) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		err := w.api.StreamWake(ctx, trigger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "Wake stream disconnected (%v); reconnecting in %s\n", err, backoff)
		}
		sleepCtx(ctx, backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (w *Runner) executeJob(ctx context.Context, claim *ClaimResponse) error {
	job := claim.Job

	stdoutLogger := NewJobLogger(w.api, job.ID, "STDOUT")
	stderrLogger := NewJobLogger(w.api, job.ID, "STDERR")
	defer stdoutLogger.Close()
	defer stderrLogger.Close()

	// Emit immediately so the user sees activity within ~100ms of claim — before
	// credential setup and tofu init — instead of waiting on the first real step.
	fmt.Fprintln(stdoutLogger, "▸ Job claimed — preparing workspace…")

	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", nil); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to update job status to PROCESSING: %v\n", err)
	}

	if claim.CloudIdentity != nil {
		switch types.CloudProvider(claim.CloudIdentity.Provider) {
		case types.CloudProviderAws:
			fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
			sessionName := fmt.Sprintf("runner-%s", job.ID[:8])
			if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
				errMsg := fmt.Sprintf("Failed to assume role: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer ClearAssumedCredentials()
		case types.CloudProviderGcp:
			fmt.Fprintf(stdoutLogger, "Activating WIF for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
			cleanup, err := ActivateGcpWIF(claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate GCP WIF: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		case types.CloudProviderAzure:
			fmt.Fprintf(stdoutLogger, "Activating Azure federated identity for tenant %s (subscription: %s)...\n", claim.CloudIdentity.TenantID, claim.CloudIdentity.SubscriptionID)
			cleanup, err := ActivateAzureFederated(claim.CloudIdentity.TenantID, claim.CloudIdentity.ClientID, claim.CloudIdentity.SubscriptionID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate Azure federated identity: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		case types.CloudProviderDigitalocean, types.CloudProviderHetzner, types.CloudProviderCivo:
			fmt.Fprintf(stdoutLogger, "Activating %s API token...\n", claim.CloudIdentity.Provider)
			cleanup, err := ActivateTokenCloud(claim.CloudIdentity.Provider, claim.CloudIdentity.APIToken, claim.CloudIdentity.SelfManaged)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate %s token: %v", claim.CloudIdentity.Provider, err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		case types.CloudProviderAlibaba:
			fmt.Fprintf(stdoutLogger, "Assuming Alibaba RAM role %s...\n", claim.CloudIdentity.RoleArn)
			sessionName := fmt.Sprintf("runner-%s", job.ID[:8])
			cleanup, err := ActivateAlibabaRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to assume Alibaba RAM role: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		}
	}

	provider := ""
	if claim.CloudIdentity != nil {
		provider = claim.CloudIdentity.Provider
	}

	var execErr error
	// Switch on the generated types.JobType so `exhaustive` (golangci-lint) forces a
	// case for every provision_job_type value — adding a job type here is mandatory,
	// and removing one from the enum SSOT makes the missing constant a compile error.
	switch types.JobType(job.JobType) {
	case types.JobTypePlan:
		execErr = w.executePlan(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeDeploy:
		execErr = w.executeDeploy(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeDestroy:
		execErr = w.executeDestroy(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeDeployRunner, types.JobTypeUpdateRunner:
		execErr = w.executeDeployRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeDestroyRunner:
		execErr = w.executeDestroyRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeAnalyzeRepo:
		execErr = w.executeAnalyzeRepo(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeDetectDrift:
		execErr = w.executeDriftDetection(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeAudit:
		execErr = w.executeAudit(ctx, job, stdoutLogger, stderrLogger)
	default:
		execErr = fmt.Errorf("unknown job type: %s", job.JobType)
	}

	if execErr != nil {
		fmt.Fprintf(stderrLogger, "Error: %v\n", execErr)
		stderrLogger.Close()
		_ = w.api.UpdateJobStatus(job.ID, "FAILED", execErr.Error(), nil)
		return execErr
	}

	_ = w.api.UpdateJobStatus(job.ID, "SUCCESS", "", nil)
	fmt.Printf("Job %s completed successfully\n", job.ID)
	return nil
}

func resolveProjectTemplatesDir() string {
	candidates := []string{
		"/home/runner/project-templates",
		"project-templates",
		"../../infra/templates/project",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// resolveCategoriesTemplatesDir locates the composable per-category modules
// (infra/templates/categories) — a sibling of the project templates dir.
func resolveCategoriesTemplatesDir() string {
	candidates := []string{
		"/home/runner/category-templates",
		"category-templates",
		"../../infra/templates/categories",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// toCoreConnectorCreds converts the runner's claim-response credentials into
// the core types used by the provisioner/composer.
func toCoreConnectorCreds(creds []ConnectorCredential) []types.ConnectorCredential {
	if len(creds) == 0 {
		return nil
	}
	out := make([]types.ConnectorCredential, 0, len(creds))
	for _, c := range creds {
		out = append(out, types.ConnectorCredential{
			Category:    c.Category,
			Slug:        c.Slug,
			Credentials: c.Credentials,
		})
	}
	return out
}

func (w *Runner) executeDeploy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = vc.Provider
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	vc.ConnectorCredentials = toCoreConnectorCreds(connectorCreds)

	if job.PlanJobID != nil && *job.PlanJobID != "" {
		fmt.Fprintf(stdout, "Validating against plan job %s...\n", *job.PlanJobID)
		planJob, err := w.api.GetJob(*job.PlanJobID)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: could not fetch plan job for validation: %v\n", err)
		} else if planJob != nil {
			if planJob.Status != "SUCCESS" {
				return fmt.Errorf("plan job %s has status %s, expected SUCCESS", *job.PlanJobID, planJob.Status)
			}
			if job.ConfigurationHash != nil && planJob.ConfigurationHash != nil &&
				*job.ConfigurationHash != *planJob.ConfigurationHash {
				return fmt.Errorf("configuration changed since plan was generated (plan hash: %s, current: %s)",
					*planJob.ConfigurationHash, *job.ConfigurationHash)
			}
			fmt.Fprintln(stdout, "Plan validation passed.")
		}
	}

	gitToken := vc.GitAccessToken
	if gitToken == "" {
		if fetched, err := w.api.FetchGitToken(job.ID); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to fetch git token: %v\n", err)
		} else {
			gitToken = fetched
		}
	}

	params := provisioner.DeployParams{
		ProjectConfig:  vc,
		Provider:       provider,
		TemplatesDir:   filepath.Join(resolveProjectTemplatesDir(), provider),
		CategoriesDir:  resolveCategoriesTemplatesDir(),
		GitAccessToken: gitToken,
		S3Backend:      w.s3Backend(),
		Stdout:         stdout,
		Stderr:         stderr,
		// Honour an authorized verification waiver recorded on the job (if any).
		VerifyOverride: buildVerifyOverride(job.VerifyOverride),
	}

	if job.PlanJobID != nil && *job.PlanJobID != "" {
		planFileDest := filepath.Join(os.TempDir(), fmt.Sprintf("plan-apply-%s.out", job.ID))
		if dlErr := w.api.DownloadPlanArtifact(*job.PlanJobID, planFileDest); dlErr != nil {
			fmt.Fprintf(stdout, "Warning: could not download plan artifact: %v (will re-plan)\n", dlErr)
		} else {
			fmt.Fprintln(stdout, "Using saved plan artifact from plan job.")
			params.PlanFile = planFileDest
			defer os.Remove(planFileDest)
		}
	}

	result, err := provisioner.RunDeployV2(ctx, params)
	if err != nil {
		return err
	}

	if result != nil {
		metadata := map[string]any{}
		if result.ClusterName != "" {
			metadata["cluster_name"] = result.ClusterName
		}
		if result.ClusterEndpoint != "" {
			metadata["cluster_endpoint"] = result.ClusterEndpoint
		}
		if result.ArgocdURL != "" {
			metadata["argocd_url"] = result.ArgocdURL
		}
		if result.ArgocdAdminPassword != "" {
			metadata["argocd_admin_password"] = result.ArgocdAdminPassword
		}
		if len(result.Outputs) > 0 {
			metadata["outputs"] = result.Outputs
		}
		if result.VerifyReport != nil {
			metadata["verify_result"] = result.VerifyReport
		}
		if result.VerifyReceipt != nil {
			metadata["verify_receipt"] = result.VerifyReceipt
		}
		if len(result.AddOnStatus) > 0 {
			metadata["addon_status"] = result.AddOnStatus
		}
		if result.SecurityPosture != nil {
			metadata["security_report"] = result.SecurityPosture
		}
		if len(metadata) > 0 {
			_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)
		}
	}

	return nil
}

func (w *Runner) executePlan(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = vc.Provider
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	vc.ConnectorCredentials = toCoreConnectorCreds(connectorCreds)

	infracostKey := os.Getenv("INFRACOST_API_KEY")

	planGitToken := vc.GitAccessToken
	if planGitToken == "" {
		if fetched, err := w.api.FetchGitToken(job.ID); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to fetch git token: %v\n", err)
		} else {
			planGitToken = fetched
		}
	}

	params := provisioner.DeployParams{
		ProjectConfig:  vc,
		Provider:       provider,
		DryRun:         true,
		TemplatesDir:   filepath.Join(resolveProjectTemplatesDir(), provider),
		CategoriesDir:  resolveCategoriesTemplatesDir(),
		InfracostToken: infracostKey,
		GitAccessToken: planGitToken,
		S3Backend:      w.s3Backend(),
		Stdout:         stdout,
		Stderr:         stderr,
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "tofu_plan", "progress": "Running OpenTofu plan...",
	})

	result, err := provisioner.RunDeployV2(ctx, params)
	if err != nil {
		return err
	}

	metadata := map[string]any{"plan_completed": true}
	if result != nil {
		if result.PlanJSON != nil {
			if rc, ok := result.PlanJSON["resource_changes"]; ok {
				metadata["plan_result"] = map[string]any{"resource_changes": rc}
			} else {
				fmt.Fprintln(stdout, "Warning: PlanJSON has no resource_changes key")
				metadata["plan_result"] = result.PlanJSON
			}
		} else {
			fmt.Fprintln(stdout, "Warning: PlanJSON is nil — tofu show may have failed")
		}
		if result.CostBreakdown != nil {
			metadata["cost_breakdown"] = result.CostBreakdown
			if result.CostBreakdown.Summary != nil {
				metadata["cost_summary"] = result.CostBreakdown.Summary
			}
		}
		if result.VerifyReport != nil {
			metadata["verify_result"] = result.VerifyReport
		}
		if result.VerifyReceipt != nil {
			metadata["verify_receipt"] = result.VerifyReceipt
		}
	}

	if result != nil && len(result.PlanFileBytes) > 0 {
		tmpPlan := filepath.Join(os.TempDir(), fmt.Sprintf("plan-%s.out", job.ID))
		if err := os.WriteFile(tmpPlan, result.PlanFileBytes, 0644); err == nil {
			if uploadErr := w.api.UploadPlanArtifact(job.ID, tmpPlan); uploadErr != nil {
				fmt.Fprintf(stderr, "Warning: failed to upload plan artifact: %v\n", uploadErr)
			} else {
				fmt.Fprintln(stdout, "Plan artifact uploaded to storage.")
				metadata["plan_file_key"] = fmt.Sprintf("%s/tofu.plan.out", job.ID)
			}
			os.Remove(tmpPlan)
		}
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)

	return nil
}

func (w *Runner) executeDestroy(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	snapshot := job.ConfigSnapshot

	region := getSnapshotString(snapshot, "region")

	params := provisioner.DestroyParams{
		ProjectName:      getSnapshotString(snapshot, "project_name"),
		Environment:      getSnapshotString(snapshot, "environment_stage"),
		Region:           region,
		CleanupWorkspace: true,
		Stdout:           stdout,
		Stderr:           stderr,
	}

	return provisioner.RunDestroy(ctx, params)
}

func getSnapshotString(snapshot map[string]any, key string) string {
	if v, ok := snapshot[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func snapshotToProjectConfig(snapshot map[string]any) (*types.ProjectConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var vc types.ProjectConfig
	if err := json.Unmarshal(data, &vc); err != nil {
		return nil, err
	}

	return &vc, nil
}

func resolveAccountID(identity *CloudIdentity) string {
	switch identity.Provider {
	case "gcp":
		return identity.ProjectID
	case "azure":
		return identity.SubscriptionID
	default:
		return identity.AccountID
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
