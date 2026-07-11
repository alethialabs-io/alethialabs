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
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
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
	// sandbox is the isolation boundary a job's untrusted work runs through. The
	// default is a no-isolation Passthrough (today's behavior); an isolating backend
	// is swapped in behind a flag once proven (see the E0 plan). Never nil.
	sandbox sandbox.Sandbox
}

func New(cfg Config) *Runner {
	client := NewRunnerAPIClient(cfg.AlethiaURL, cfg.RunnerID, cfg.RunnerToken)
	client.providers = cfg.Providers
	return &Runner{config: cfg, api: client, sandbox: selectSandbox(cfg)}
}

func NewWithAPI(cfg Config, api JobAPI) *Runner {
	return &Runner{config: cfg, api: api, sandbox: selectSandbox(cfg)}
}

// selectSandbox picks the isolation backend from ALETHIA_SANDBOX_BACKEND. Default is the
// no-isolation Passthrough (today's behavior). "container" selects the per-job container
// backend; if it can't initialize on an operator=managed runner it is **fail-closed** — a
// Passthrough with EnforceManaged=true that REFUSES every job — rather than silently
// running untrusted work unsandboxed.
func selectSandbox(cfg Config) sandbox.Sandbox {
	if os.Getenv("ALETHIA_SANDBOX_BACKEND") != "container" {
		return sandbox.Passthrough{Operator: cfg.Operator}
	}
	c, err := sandbox.NewContainerFromEnv(cfg.Operator)
	if err == nil {
		return c
	}
	if cfg.Operator == "managed" {
		fmt.Fprintf(os.Stderr, "sandbox: container backend required but unavailable on managed runner: %v — refusing jobs (fail-closed)\n", err)
		return sandbox.Passthrough{Operator: cfg.Operator, EnforceManaged: true}
	}
	fmt.Fprintf(os.Stderr, "sandbox: container backend unavailable (%v); using Passthrough (operator=%s)\n", err, cfg.Operator)
	return sandbox.Passthrough{Operator: cfg.Operator}
}

func (w *Runner) s3Backend() *cloud.S3BackendConfig {
	return cloud.S3BackendFromConfig(
		w.config.S3Endpoint,
		w.config.S3Region,
		w.config.S3AccessKey,
		w.config.S3SecretKey,
	)
}

// stateBackend mints a per-job tofu-state token and returns the console http
// state-backend config for project provisioning. The token authorizes state I/O
// for this job only and reaches tofu via TF_HTTP_PASSWORD (never a workdir file),
// so no storage master credential touches the untrusted project path.
func (w *Runner) stateBackend(jobID string) (*cloud.HTTPBackendConfig, error) {
	token, err := w.api.FetchStateToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch tofu state token: %w", err)
	}
	return &cloud.HTTPBackendConfig{
		ConsoleURL: w.config.AlethiaURL,
		JobID:      jobID,
		Token:      token,
	}, nil
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
			// Managed runners have NO ambient AWS identity (the Hetzner fleet injects no keys), so they
			// federate in KEYLESSLY via DIRECT OIDC: AssumeRoleWithWebIdentity straight into the customer
			// role (which trusts the Alethia issuer), auto-refreshing — no platform AWS account, no
			// ExternalId. Self-hosted runners run in the customer's cloud with their own creds, so they keep
			// the direct AssumeRole path.
			if w.config.Operator == "managed" {
				fmt.Fprintf(stdoutLogger, "Activating keyless AWS federation into %s (account %s)...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
				cleanup, err := ActivateAwsFederated(ctx, w.api, claim.CloudIdentity.RoleArn, job.ID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate AWS federation: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			} else {
				fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
				sessionName := fmt.Sprintf("runner-%s", job.ID[:8])
				if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
					errMsg := fmt.Sprintf("Failed to assume role: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer ClearAssumedCredentials()
			}
		case types.CloudProviderGcp:
			// Managed runners federate GCP KEYLESSLY via DIRECT OIDC — a minted JWT via a token file, no AWS
			// hop. (The legacy AWS-hub path is retired.) Self-hosted runners rely on their own ambient GCP
			// credentials (ADC / metadata).
			if w.config.Operator == "managed" {
				if !isOidcWifJSON(claim.CloudIdentity.WifConfig) {
					errMsg := "This GCP connection uses the retired AWS-hub setup. Reconnect it (Connectors → GCP) to migrate to direct-OIDC."
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return fmt.Errorf("%s", errMsg)
				}
				fmt.Fprintf(stdoutLogger, "Activating keyless GCP OIDC for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
				cleanup, err := ActivateGcpOIDC(ctx, w.api, claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID, job.ID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate GCP OIDC: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			} else {
				fmt.Fprintf(stdoutLogger, "Activating WIF for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
				cleanup, err := ActivateGcpWIF(claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate GCP WIF: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			}
		case types.CloudProviderAzure:
			fmt.Fprintf(stdoutLogger, "Activating Azure federated identity for tenant %s (subscription: %s)...\n", claim.CloudIdentity.TenantID, claim.CloudIdentity.SubscriptionID)
			cleanup, err := ActivateAzureFederated(ctx, w.api, claim.CloudIdentity.TenantID, claim.CloudIdentity.ClientID, claim.CloudIdentity.SubscriptionID, job.ID)
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
			// Keyless: the alicloud provider runs an anonymous AssumeRoleWithOIDC from a token file — no
			// AccessKey on the runner (the retired platform RAM key).
			fmt.Fprintf(stdoutLogger, "Activating keyless Alibaba OIDC for role %s...\n", claim.CloudIdentity.RoleArn)
			cleanup, err := ActivateAlibabaOIDC(ctx, w.api, claim.CloudIdentity.RoleArn, claim.CloudIdentity.OidcProviderArn, job.ID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate Alibaba OIDC: %v", err)
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
		execErr = w.executeDestroy(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
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
	case types.JobTypeChartScan:
		execErr = w.executeChartScan(ctx, job, stdoutLogger, stderrLogger)
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

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	// Download the pre-approved plan into the workdir (mounted into the sandbox) so the
	// child can read it.
	planFile := ""
	if job.PlanJobID != nil && *job.PlanJobID != "" {
		planFileDest := filepath.Join(workDir, "plan-apply.out")
		if dlErr := w.api.DownloadPlanArtifact(*job.PlanJobID, planFileDest); dlErr != nil {
			fmt.Fprintf(stdout, "Warning: could not download plan artifact: %v (will re-plan)\n", dlErr)
		} else {
			fmt.Fprintln(stdout, "Using saved plan artifact from plan job.")
			planFile = planFileDest
		}
	}

	payload := buildDeployPayload(vc, provider, false, planFile,
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		"", buildVerifyOverride(job.VerifyOverride), w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StageDeploy, payload)
	if err != nil {
		return err
	}
	sec := stageSecrets{GitToken: gitToken, StateToken: stateBackend.Token}

	// Run the untrusted provisioning work through the isolation seam. Passthrough runs
	// runDeployStage in-process; the container backend re-execs it in a per-job container.
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "deploy", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDeployStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	result, err := readPlanResult(workDir)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read stage result: %v\n", err)
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

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	payload := buildDeployPayload(vc, provider, true, "",
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		infracostKey, nil, w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StagePlan, payload)
	if err != nil {
		return err
	}
	sec := stageSecrets{GitToken: planGitToken, StateToken: stateBackend.Token}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "tofu_plan", "progress": "Running OpenTofu plan...",
	})

	// Run the untrusted plan through the isolation seam (Passthrough in-process / container re-exec).
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "plan", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDeployStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	result, err := readPlanResult(workDir)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read stage result: %v\n", err)
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

func (w *Runner) executeDestroy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
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

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	payload := buildDestroyPayload(vc, provider,
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StageDestroy, payload)
	if err != nil {
		return err
	}
	sec := stageSecrets{StateToken: stateBackend.Token}

	// Run the (untrusted-class, for BYO) teardown through the isolation seam, like
	// deploy/plan — Passthrough runs it in-process; the container backend re-execs it.
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "destroy", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDestroyStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	// Best-effort: purge the now-empty state object (tofu's http backend leaves it behind).
	if err := w.api.PurgeProjectState(job.ID, stateBackend.Token); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to purge tofu state: %v\n", err)
	}
	return nil
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
