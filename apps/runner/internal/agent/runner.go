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
	"strings"
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
}

type Runner struct {
	config Config
	api    JobAPI
	// sandbox is the isolation boundary a job's untrusted work runs through. The
	// default is a no-isolation Passthrough (today's behavior); an isolating backend
	// is swapped in behind a flag once proven (see the E0 plan). Never nil.
	sandbox sandbox.Sandbox
	// cancels tracks in-flight jobs so a cancel event pushed over the wake stream can
	// tear down the right job mid-flight (and mark it CANCELLED, not FAILED).
	cancels *cancelRegistry
}

func New(cfg Config) *Runner {
	client := NewRunnerAPIClient(cfg.AlethiaURL, cfg.RunnerID, cfg.RunnerToken)
	client.providers = cfg.Providers
	return &Runner{config: cfg, api: client, sandbox: selectSandbox(cfg), cancels: newCancelRegistry()}
}

func NewWithAPI(cfg Config, api JobAPI) *Runner {
	return &Runner{config: cfg, api: api, sandbox: selectSandbox(cfg), cancels: newCancelRegistry()}
}

// selectSandbox picks the isolation backend from ALETHIA_SANDBOX_BACKEND. Default is the
// no-isolation Passthrough (today's behavior). "container" selects the per-job container
// backend; if it can't initialize on an operator=managed runner it is **fail-closed** — a
// Passthrough with EnforceManaged=true that REFUSES every job — rather than silently
// running untrusted work unsandboxed.
//
// ALETHIA_SANDBOX_ENFORCE_MANAGED is the config-driven kill-switch for the DEFAULT
// (no-container) path: once the container backend is proven on the fleet (Step 3b), the
// maintainer sets it fleet-wide so any managed pool that LACKS the container backend
// refuses jobs rather than silently running unsandboxed — no code redeploy to flip. Left
// false today so existing trusted managed provisioning is unaffected.
func selectSandbox(cfg Config) sandbox.Sandbox {
	if os.Getenv("ALETHIA_SANDBOX_BACKEND") != "container" {
		return sandbox.Passthrough{
			Operator:       cfg.Operator,
			EnforceManaged: envTrue("ALETHIA_SANDBOX_ENFORCE_MANAGED"),
		}
	}
	c, err := sandbox.NewContainerFromEnv(cfg.Operator)
	if err == nil {
		return c
	}
	// Fail-closed for anything that is not an EXPLICIT self operator: an empty/unknown
	// operator string must NOT downgrade to a lenient Passthrough when the container backend
	// was requested but is unavailable — only "self" (customer's own cloud) is lenient.
	if cfg.Operator != "self" {
		fmt.Fprintf(os.Stderr, "sandbox: container backend required but unavailable on non-self runner (operator=%q): %v — refusing jobs (fail-closed)\n", cfg.Operator, err)
		return sandbox.Passthrough{Operator: cfg.Operator, EnforceManaged: true}
	}
	fmt.Fprintf(os.Stderr, "sandbox: container backend unavailable (%v); using Passthrough (operator=%s)\n", err, cfg.Operator)
	return sandbox.Passthrough{Operator: cfg.Operator}
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

	// Bind runner_id onto the process-wide operational logger for every job-less line.
	InitAgentLogger(w.config.RunnerID)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		Log().Info("received shutdown signal, finishing current job")
		draining.Store(true)
		time.AfterFunc(10*time.Minute, func() {
			Log().Warn("grace period expired, forcing shutdown")
			cancel()
		})
	}()

	go w.heartbeatLoop(ctx)

	Log().Info("runner started",
		"operator", w.config.Operator,
		"version", version.Version,
		"alethia_url", w.config.AlethiaURL)

	return w.claimLoop(ctx, &draining)
}

func (w *Runner) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	if err := w.api.Heartbeat(); err != nil {
		Log().Error("initial heartbeat failed", "err", err.Error())
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.api.Heartbeat(); err != nil {
				Log().Error("heartbeat failed", "err", err.Error())
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

	go w.wakeLoop(ctx, func(ev WakeEvent) { w.dispatchWakeEvent(ev, trigger) })

	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	trigger() // drain any backlog on startup

	for {
		if draining.Load() {
			Log().Info("draining: no more jobs will be claimed, exiting")
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
				Log().Error("failed to claim job", "err", err.Error())
				break
			}
			if claim.Job == nil {
				break
			}

			traceID := traceIDFromTraceparent(claim.Job.Traceparent)
			LogWith(w.config.RunnerID, traceID, claim.Job.ID).Info("claimed job",
				"job_type", claim.Job.JobType)
			// PLAN/DEPLOY/DESTROY provision real infra, so they keep a long timeout.
			jobTimeout := 2 * time.Hour
			jobCtx, jobCancel := context.WithTimeout(ctx, jobTimeout)
			// Register the cancel function so a cancel event over the wake stream can
			// tear THIS job down mid-flight; reap the registry entry once it's done.
			w.cancels.register(claim.Job.ID, jobCancel)
			if err := w.executeJob(jobCtx, claim); err != nil {
				LogWith(w.config.RunnerID, traceID, claim.Job.ID).Error("job failed",
					"err", err.Error())
			}
			jobCancel()
			w.cancels.reap(claim.Job.ID)
		}
	}
}

// dispatchWakeEvent routes a push-dispatch event: a wake triggers a claim drain; a cancel
// tears down the targeted in-flight job (a no-op if it isn't running on this runner — e.g. a
// QUEUED job the console cancelled DB-only, or one already finished).
func (w *Runner) dispatchWakeEvent(ev WakeEvent, trigger func()) {
	switch ev.Type {
	case "cancel":
		if ev.JobID != "" {
			if w.cancels.cancel(ev.JobID) {
				Log().Info("cancel signal received; tearing down job", "job_id", ev.JobID)
			}
		}
	default: // "wake"
		trigger()
	}
}

// wakeLoop maintains the push-dispatch SSE connection, reconnecting with backoff.
// Each event is dispatched via onEvent (wake → claim attempt; cancel → job teardown).
func (w *Runner) wakeLoop(ctx context.Context, onEvent func(WakeEvent)) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		err := w.api.StreamWake(ctx, onEvent)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			Log().Warn("wake stream disconnected; reconnecting",
				"err", err.Error(), "backoff", backoff.String())
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
	traceparent := job.Traceparent
	traceID := traceIDFromTraceparent(traceparent)
	// Operational logger for this job's lifetime — structured JSON to stderr carrying
	// the correlation ids so a runner line joins the console trace.
	jlog := LogWith(w.config.RunnerID, traceID, job.ID)

	// Customer-facing job streams (STDOUT/STDERR) — trace-stamped so each log line
	// correlates. SYSTEM ships the runner's OPERATIONAL failures to the console (they
	// would otherwise die on the runner's stderr).
	stdoutLogger := NewJobLoggerWithTrace(w.api, job.ID, "STDOUT", traceparent)
	stderrLogger := NewJobLoggerWithTrace(w.api, job.ID, "STDERR", traceparent)
	sysLogger := NewSystemLogger(w.api, job.ID, traceparent)
	defer stdoutLogger.Close()
	defer stderrLogger.Close()
	defer sysLogger.Close()

	// Emit immediately so the user sees activity within ~100ms of claim — before
	// credential setup and tofu init — instead of waiting on the first real step.
	fmt.Fprintln(stdoutLogger, "▸ Job claimed — preparing workspace…")

	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", nil); err != nil {
		jlog.Error("failed to update job status to PROCESSING", "err", err.Error())
		fmt.Fprintf(sysLogger, "Failed to update job status to PROCESSING: %v\n", err)
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
			// Hetzner Object Storage: export the (optional) S3 key pair for the minio provider.
			if types.CloudProvider(claim.CloudIdentity.Provider) == types.CloudProviderHetzner &&
				claim.CloudIdentity.S3AccessKey != "" && claim.CloudIdentity.S3SecretKey != "" {
				fmt.Fprintln(stdoutLogger, "Activating Hetzner Object Storage S3 credentials...")
				s3Cleanup := ActivateHetznerS3(claim.CloudIdentity.S3AccessKey, claim.CloudIdentity.S3SecretKey)
				defer s3Cleanup()
			}
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
	case types.JobTypeIacScan:
		execErr = w.executeIacScan(ctx, job, stdoutLogger, stderrLogger)
	default:
		execErr = fmt.Errorf("unknown job type: %s", job.JobType)
	}

	if execErr != nil {
		// A user cancel surfaces as a context-cancelled error from the stage. Post
		// CANCELLED (not FAILED) so the terminal state reflects the intent, and flag
		// orphan risk when the teardown killed a mid-apply (cloud resources may exist
		// outside tofu state → an operator must reconcile; see markOrphanRisk).
		if w.cancels.wasCancelled(job.ID) {
			jlog.Info("job cancelled", "job_type", job.JobType)
			var meta map[string]any
			if w.cancels.orphanRisk(job.ID) {
				meta = map[string]any{
					"orphan_risk":        true,
					"orphan_risk_reason": "apply was interrupted by a cancel; cloud resources may exist outside tofu state and need reconciliation",
				}
				fmt.Fprintln(stderrLogger, "Cancelled during apply — cloud resources may have been left outside tofu state (orphan risk). An operator should reconcile.")
			}
			fmt.Fprintln(stdoutLogger, "▸ Job cancelled — teardown complete.")
			stderrLogger.Close()
			_ = w.api.UpdateJobStatus(job.ID, "CANCELLED", "Cancelled by user", meta)
			return execErr
		}
		jlog.Error("job execution failed", "job_type", job.JobType, "err", execErr.Error())
		fmt.Fprintf(stderrLogger, "Error: %v\n", execErr)
		stderrLogger.Close()
		_ = w.api.UpdateJobStatus(job.ID, "FAILED", execErr.Error(), nil)
		return execErr
	}

	_ = w.api.UpdateJobStatus(job.ID, "SUCCESS", "", nil)
	jlog.Info("job completed successfully")
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

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "DEPLOY"); err != nil {
		return err
	}

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
		// On a mid-flight cancel, decide whether the killed work had reached the apply
		// (state-mutating) phase. RunDeployV2 writes "apply" to workDir/phase just before
		// `tofu apply`; if we cancelled at or after that point, orphaned cloud resources may
		// exist. Read it BEFORE the deferred RemoveAll(workDir) so the marker is still there.
		if w.cancels.wasCancelled(job.ID) && readDeployPhase(workDir) == "apply" {
			w.cancels.markOrphanRisk(job.ID)
		}
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
		if result.ClusterReady {
			// The reachability gate confirmed the API server answered + nodes are Ready —
			// "SUCCESS" means a working cluster, not just that `tofu apply` exited 0.
			metadata["cluster_ready"] = true
		}
		if result.ArgocdURL != "" {
			metadata["argocd_url"] = result.ArgocdURL
		}
		if result.ArgocdAdminPassword != "" {
			metadata["argocd_admin_password"] = result.ArgocdAdminPassword
		}
		// Persist outputs to the console, but scrub credential-bearing outputs (full
		// kubeconfigs / client keys — e.g. Alibaba/Hetzner emit a cluster-admin `kubeconfig`)
		// so they never land in execution_metadata (console Postgres). The pipeline already
		// consumed the full outputs in-process above.
		if scrubbed := scrubSensitiveOutputs(result.Outputs); len(scrubbed) > 0 {
			metadata["outputs"] = scrubbed
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
		if len(result.InfraServices) > 0 {
			// Honest per-cloud infra-service install/skip decisions (reasons + statuses).
			// Non-sensitive, safe to persist to the console alongside addon_status.
			metadata["infra_services"] = result.InfraServices
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

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "PLAN"); err != nil {
		return err
	}

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

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "DESTROY"); err != nil {
		return err
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

// deployPhaseFile is the path RunDeployV2 writes the provisioning phase to (under the
// per-job workdir, so it survives the container-sandbox boundary). Kept in one place so
// the writer (stage.go → DeployParams.PhaseFile) and reader agree.
func deployPhaseFile(workDir string) string {
	return filepath.Join(workDir, "phase")
}

// readDeployPhase returns the provisioning phase RunDeployV2 recorded ("apply" once the
// state-mutating apply started), or "" if none was written (pre-apply, or a non-deploy stage).
func readDeployPhase(workDir string) string {
	b, err := os.ReadFile(deployPhaseFile(workDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// byoManagedGate is the E0 isolation boundary for bring-your-own IaC on a MANAGED-operator
// runner. BYO PLAN/DEPLOY/DESTROY/DETECT_DRIFT execute UNTRUSTED customer OpenTofu — an RCE
// surface: provider plugins run at init/validate/plan, and `local-exec`/`remote-exec`
// provisioners + `external` data sources run arbitrary commands. A managed runner federates
// into customer clouds AND sits in the platform account, so that untrusted code must NEVER
// run outside an egress-enforced container sandbox — otherwise it reaches 169.254.169.254
// and recovers the fleet's storage master key + bootstrap token (the metadata firehose).
//
// The gate has two separable halves:
//   - the "is this untrusted BYO?" decision (a non-nil IacSource) lives HERE, and
//   - the "managed requires an egress-enforced container" enforcement lives in
//     requireManagedContainerSandbox, so the SAME enforcement can be applied by callers
//     whose job is untrusted-BYO by definition and carries no ProjectConfig (IAC_SCAN).
//
// SELF operators run BYO IaC in the customer's OWN cloud with their own creds — their risk
// boundary — so they are always allowed. A nil IacSource (trusted Alethia templates) is
// unaffected. When the gate PASSES, the untrusted work still runs THROUGH the container
// sandbox (the deploy/plan/destroy/drift paths all call w.sandbox.Run) — the gate guarantees
// that backend is the active one, so managed BYO IaC can never execute outside the container.
func (w *Runner) byoManagedGate(vc *types.ProjectConfig, kind string) error {
	if vc == nil || vc.IacSource == nil {
		return nil // trusted (non-BYO) template path — unaffected
	}
	return w.requireManagedContainerSandbox(kind)
}

// requireManagedContainerSandbox is the enforcement half of the E0 boundary: it refuses to
// run untrusted BYO work unless the runner is an explicit SELF operator OR the egress-enforced
// container sandbox is active with managed-enforcement on. It presumes the caller has already
// established the work is untrusted BYO — byoManagedGate calls it only when IacSource != nil,
// and executeIacScan calls it UNCONDITIONALLY (an IAC_SCAN is untrusted BYO by definition).
//
// It is FAIL-CLOSED. Work is allowed ONLY when either:
//   - w.config.Operator == "self" — the customer's OWN cloud + creds are their risk boundary; OR
//   - all of: the active backend is the Container backend (ALETHIA_SANDBOX_BACKEND=container),
//     that backend confirms egress enforcement (EgressEnforced, from
//     ALETHIA_SANDBOX_EGRESS_ENFORCED=1 — default-deny net + IMDS block + squid allowlist), AND
//     ALETHIA_SANDBOX_ENFORCE_MANAGED=1 (the post-canary managed-enforcement flip, which the
//     maintainer sets fleet-wide AFTER the real-VM 3b canary; see memory e0-isolation-runtime).
//
// Crucially only an EXPLICIT "self" operator takes the allow path — an empty/miscased/unknown
// operator string ("", "Managed", typo) is treated as managed-strict and MUST pass through the
// container requirement, so a mis-set operator can never fail OPEN into unsandboxed execution.
func (w *Runner) requireManagedContainerSandbox(kind string) error {
	if w.config.Operator == "self" {
		return nil // self operator: customer's own cloud + creds = their risk boundary
	}
	c, ok := w.sandbox.(sandbox.Container)
	if ok && c.EgressEnforced && envTrue("ALETHIA_SANDBOX_ENFORCE_MANAGED") {
		return nil // egress-enforced container sandbox is active + managed-enforcement on
	}
	return fmt.Errorf(
		"refusing to run bring-your-own IaC %s on a managed runner without the egress-enforced container sandbox: "+
			"this executes untrusted customer OpenTofu (provider plugins + provisioners run arbitrary code) and is only "+
			"permitted inside the E0 isolation boundary — set ALETHIA_SANDBOX_BACKEND=container, "+
			"ALETHIA_SANDBOX_EGRESS_ENFORCED=1 and ALETHIA_SANDBOX_ENFORCE_MANAGED=1 on the managed fleet (post 3b canary)",
		kind)
}

// envTrue reports whether an env var is set to a truthy value (1/true/yes/on).
func envTrue(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
