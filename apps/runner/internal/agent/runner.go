// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	alethiaAws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	alethiaAzure "github.com/alethialabs-io/alethialabs/packages/core/cloud/azure"
	alethiaGcp "github.com/alethialabs-io/alethialabs/packages/core/cloud/gcp"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type Config struct {
	Mode        string // "self-hosted" or "cloud-hosted"
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
	return &Runner{
		config: cfg,
		api:    NewRunnerAPIClient(cfg.AlethiaURL, cfg.RunnerID, cfg.RunnerToken),
	}
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

	fmt.Printf("Runner started (id=%s, mode=%s, version=%s)\n", w.config.RunnerID, w.config.Mode, version.Version)
	fmt.Printf("Polling %s for jobs...\n", w.config.AlethiaURL)

	return w.pollLoop(ctx, &draining)
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

func (w *Runner) pollLoop(ctx context.Context, draining *atomic.Bool) error {
	pollInterval := 10 * time.Second

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if draining.Load() {
			fmt.Println("Draining: no more jobs will be claimed. Exiting.")
			return nil
		}

		claim, err := w.api.ClaimJob()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to claim job: %v\n", err)
			sleepCtx(ctx, pollInterval)
			continue
		}

		if claim.Job == nil {
			sleepCtx(ctx, pollInterval)
			continue
		}

		fmt.Printf("Claimed job %s (type=%s)\n", claim.Job.ID, claim.Job.JobType)

		jobCtx, jobCancel := context.WithTimeout(ctx, 2*time.Hour)
		if err := w.executeJob(jobCtx, claim); err != nil {
			fmt.Fprintf(os.Stderr, "Job %s failed: %v\n", claim.Job.ID, err)
		}
		jobCancel()
	}
}

func (w *Runner) executeJob(ctx context.Context, claim *ClaimResponse) error {
	job := claim.Job

	stdoutLogger := NewJobLogger(w.api, job.ID, "STDOUT")
	stderrLogger := NewJobLogger(w.api, job.ID, "STDERR")
	defer stdoutLogger.Close()
	defer stderrLogger.Close()

	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", nil); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to update job status to PROCESSING: %v\n", err)
	}

	if claim.CloudIdentity != nil {
		switch claim.CloudIdentity.Provider {
		case "aws":
			fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
			sessionName := fmt.Sprintf("runner-%s", job.ID[:8])
			if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
				errMsg := fmt.Sprintf("Failed to assume role: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer ClearAssumedCredentials()
		case "gcp":
			fmt.Fprintf(stdoutLogger, "Activating WIF for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
			cleanup, err := ActivateGcpWIF(claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate GCP WIF: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		case "azure":
			fmt.Fprintf(stdoutLogger, "Activating Azure federated identity for tenant %s (subscription: %s)...\n", claim.CloudIdentity.TenantID, claim.CloudIdentity.SubscriptionID)
			cleanup, err := ActivateAzureFederated(claim.CloudIdentity.TenantID, claim.CloudIdentity.ClientID, claim.CloudIdentity.SubscriptionID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate Azure federated identity: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
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
	switch job.JobType {
	case "CONNECTION_TEST":
		switch provider {
		case "gcp":
			fmt.Fprintln(stdoutLogger, "Connection test passed — WIF authentication succeeded.")
			resources, fetchErr := w.fetchGcpResources(ctx, claim.CloudIdentity.ProjectID, stdoutLogger)
			if fetchErr != nil {
				fmt.Fprintf(stderrLogger, "Warning: failed to cache GCP resources: %v\n", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "GCP resources cached successfully.")
			}
		case "azure":
			fmt.Fprintln(stdoutLogger, "Connection test passed — Azure federated identity authenticated.")
			resources, fetchErr := w.fetchAzureResources(ctx, claim.CloudIdentity.SubscriptionID, stdoutLogger)
			if fetchErr != nil {
				fmt.Fprintf(stderrLogger, "Warning: failed to cache Azure resources: %v\n", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "Azure resources cached successfully.")
			}
		default:
			fmt.Fprintln(stdoutLogger, "Connection test passed — role assumption succeeded.")
			resources, fetchErr := w.fetchAwsResources(ctx, stdoutLogger)
			if fetchErr != nil {
				fmt.Fprintf(stderrLogger, "Warning: failed to cache AWS resources: %v\n", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "AWS resources cached successfully.")
			}
		}
	case "FETCH_RESOURCES":
		switch provider {
		case "gcp":
			fmt.Fprintln(stdoutLogger, "Fetching GCP resources...")
			projectID := ""
			if claim.CloudIdentity != nil {
				projectID = claim.CloudIdentity.ProjectID
			}
			resources, fetchErr := w.fetchGcpResources(ctx, projectID, stdoutLogger)
			if fetchErr != nil {
				execErr = fmt.Errorf("failed to fetch GCP resources: %w", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "GCP resources fetched successfully.")
			}
		case "azure":
			fmt.Fprintln(stdoutLogger, "Fetching Azure resources...")
			subscriptionID := ""
			if claim.CloudIdentity != nil {
				subscriptionID = claim.CloudIdentity.SubscriptionID
			}
			resources, fetchErr := w.fetchAzureResources(ctx, subscriptionID, stdoutLogger)
			if fetchErr != nil {
				execErr = fmt.Errorf("failed to fetch Azure resources: %w", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "Azure resources fetched successfully.")
			}
		default:
			fmt.Fprintln(stdoutLogger, "Fetching AWS resources...")
			resources, fetchErr := w.fetchAwsResources(ctx, stdoutLogger)
			if fetchErr != nil {
				execErr = fmt.Errorf("failed to fetch AWS resources: %w", fetchErr)
			} else {
				w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
					"cached_resources": resources,
				})
				fmt.Fprintln(stdoutLogger, "AWS resources fetched successfully.")
			}
		}
	case "PLAN":
		execErr = w.executePlan(ctx, job, provider, claim.CloudIdentity, claim.IntegrationCredentials, stdoutLogger, stderrLogger)
	case "DEPLOY":
		execErr = w.executeDeploy(ctx, job, provider, claim.CloudIdentity, claim.IntegrationCredentials, stdoutLogger, stderrLogger)
	case "DESTROY":
		execErr = w.executeDestroy(ctx, job, stdoutLogger, stderrLogger)
	case "DEPLOY_RUNNER", "UPDATE_RUNNER":
		execErr = w.executeDeployRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case "DESTROY_RUNNER":
		execErr = w.executeDestroyRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	default:
		execErr = fmt.Errorf("unknown job type: %s", job.JobType)
	}

	if execErr != nil {
		fmt.Fprintf(stderrLogger, "Error: %v\n", execErr)
		stderrLogger.Close()
		w.api.UpdateJobStatus(job.ID, "FAILED", execErr.Error(), nil)
		return execErr
	}

	w.api.UpdateJobStatus(job.ID, "SUCCESS", "", nil)
	fmt.Printf("Job %s completed successfully\n", job.ID)
	return nil
}

func (w *Runner) fetchAwsResources(ctx context.Context, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching enabled regions...")
	ec2Client, err := alethiaAws.NewEC2Client(ctx, alethiaAws.AWSOptions{Region: "us-east-1"})
	if err != nil {
		return nil, fmt.Errorf("failed to create EC2 client: %w", err)
	}

	regions, err := ec2Client.ListRegions(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list regions: %w", err)
	}
	fmt.Fprintf(logger, "Found %d enabled regions\n", len(regions))

	vpcs := make(map[string]any)
	subnets := make(map[string]any)

	for _, region := range regions {
		regionalClient, err := alethiaAws.NewEC2Client(ctx, alethiaAws.AWSOptions{Region: region})
		if err != nil {
			continue
		}

		regionVPCs, err := regionalClient.ListVPCs(ctx)
		if err != nil {
			continue
		}

		if len(regionVPCs) > 0 {
			vpcs[region] = regionVPCs
			regionSubnets := make(map[string]any)
			for _, vpc := range regionVPCs {
				vpcSubnets, err := regionalClient.ListSubnets(ctx, vpc.ID)
				if err != nil {
					continue
				}
				if len(vpcSubnets) > 0 {
					regionSubnets[vpc.ID] = vpcSubnets
				}
			}
			if len(regionSubnets) > 0 {
				subnets[region] = regionSubnets
			}
		}
	}

	fmt.Fprintln(logger, "Fetching Route53 hosted zones...")
	r53Client, err := alethiaAws.NewRoute53Client(ctx, alethiaAws.AWSOptions{Region: "us-east-1"})
	var hostedZones []alethiaAws.HostedZoneInfo
	if err == nil {
		hostedZones, _ = r53Client.ListHostedZones(ctx)
	}
	fmt.Fprintf(logger, "Found %d hosted zones\n", len(hostedZones))

	fmt.Fprintln(logger, "Fetching IAM users...")
	iamClient, err := alethiaAws.NewIAMClient(ctx, alethiaAws.AWSOptions{Region: "us-east-1"})
	var iamUsers []alethiaAws.IAMUserInfo
	if err == nil {
		iamUsers, _ = iamClient.ListUsers(ctx)
	}
	fmt.Fprintf(logger, "Found %d IAM users\n", len(iamUsers))

	return map[string]any{
		"regions":      regions,
		"vpcs":         vpcs,
		"subnets":      subnets,
		"hosted_zones": hostedZones,
		"iam_users":    iamUsers,
	}, nil
}

func (w *Runner) fetchGcpResources(ctx context.Context, projectID string, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching GCP compute regions...")
	computeClient, err := alethiaGcp.NewComputeClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to create compute client: %w", err)
	}

	regions, err := computeClient.ListRegions(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list regions: %w", err)
	}
	fmt.Fprintf(logger, "Found %d active regions\n", len(regions))

	fmt.Fprintln(logger, "Fetching VPC networks...")
	networks, err := computeClient.ListNetworks(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list networks: %w", err)
	}
	fmt.Fprintf(logger, "Found %d networks\n", len(networks))

	subnets := make(map[string]any)
	for _, region := range regions {
		regionSubnets, err := computeClient.ListSubnetworks(ctx, region)
		if err != nil {
			continue
		}
		if len(regionSubnets) > 0 {
			subnets[region] = regionSubnets
		}
	}

	fmt.Fprintln(logger, "Fetching Cloud DNS managed zones...")
	dnsClient, err := alethiaGcp.NewDNSClient(ctx, projectID)
	var managedZones []alethiaGcp.ManagedZoneInfo
	if err == nil {
		managedZones, _ = dnsClient.ListManagedZones(ctx)
	}
	fmt.Fprintf(logger, "Found %d managed zones\n", len(managedZones))

	return map[string]any{
		"regions":       regions,
		"networks":      networks,
		"subnets":       subnets,
		"managed_zones": managedZones,
	}, nil
}

func (w *Runner) fetchAzureResources(ctx context.Context, subscriptionID string, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching Azure locations...")
	computeClient, err := alethiaAzure.NewComputeClient(ctx, subscriptionID)
	if err != nil {
		return nil, fmt.Errorf("failed to create Azure compute client: %w", err)
	}

	locations, err := computeClient.ListLocations(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list locations: %w", err)
	}
	fmt.Fprintf(logger, "Found %d locations\n", len(locations))

	fmt.Fprintln(logger, "Fetching VNets...")
	vnets, err := computeClient.ListVnets(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list vnets: %w", err)
	}
	fmt.Fprintf(logger, "Found %d VNets\n", len(vnets))

	fmt.Fprintln(logger, "Fetching subnets for each VNet...")
	subnets := make(map[string]any)
	for _, vnet := range vnets {
		if vnet.ID == "" {
			continue
		}
		parsed, parseErr := alethiaAzure.ParseResourceID(vnet.ID)
		if parseErr != nil {
			fmt.Fprintf(logger, "Warning: could not parse VNet ID %s: %v\n", vnet.ID, parseErr)
			continue
		}
		vnetSubnets, subErr := computeClient.ListSubnets(ctx, parsed.ResourceGroup, parsed.ResourceName)
		if subErr != nil {
			fmt.Fprintf(logger, "Warning: failed to list subnets for VNet %s: %v\n", vnet.Name, subErr)
			continue
		}
		subnets[vnet.Name] = vnetSubnets
		fmt.Fprintf(logger, "Found %d subnets in VNet %s\n", len(vnetSubnets), vnet.Name)
	}

	fmt.Fprintln(logger, "Fetching Azure DNS zones...")
	dnsClient, err := alethiaAzure.NewDNSClient(ctx, subscriptionID)
	var dnsZones []alethiaAzure.DnsZoneInfo
	if err == nil {
		dnsZones, _ = dnsClient.ListDnsZones(ctx)
	}
	fmt.Fprintf(logger, "Found %d DNS zones\n", len(dnsZones))

	return map[string]any{
		"locations": locations,
		"vnets":     vnets,
		"subnets":   subnets,
		"dns_zones": dnsZones,
	}, nil
}

func resolveSpecTemplatesDir() string {
	candidates := []string{
		"/home/runner/spec-templates",
		"spec-templates",
		"../../infra/templates/spec",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// resolveCategoriesTemplatesDir locates the composable per-category modules
// (infra/templates/categories) — a sibling of the spec templates dir.
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

// toCoreIntegrationCreds converts the runner's claim-response credentials into
// the core types used by the provisioner/composer.
func toCoreIntegrationCreds(creds []IntegrationCredential) []types.IntegrationCredential {
	if len(creds) == 0 {
		return nil
	}
	out := make([]types.IntegrationCredential, 0, len(creds))
	for _, c := range creds {
		out = append(out, types.IntegrationCredential{
			Category:    c.Category,
			Slug:        c.Slug,
			Credentials: c.Credentials,
		})
	}
	return out
}

func (w *Runner) executeDeploy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, integrationCreds []IntegrationCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToSpecConfig(job.ConfigSnapshot)
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
	vc.IntegrationCredentials = toCoreIntegrationCreds(integrationCreds)

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
		SpecConfig:     vc,
		Provider:       provider,
		TemplatesDir:   filepath.Join(resolveSpecTemplatesDir(), provider),
		CategoriesDir:  resolveCategoriesTemplatesDir(),
		GitAccessToken: gitToken,
		S3Backend:      w.s3Backend(),
		Stdout:         stdout,
		Stderr:         stderr,
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
		if len(metadata) > 0 {
			w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)
		}
	}

	return nil
}

func (w *Runner) executePlan(ctx context.Context, job *Job, provider string, identity *CloudIdentity, integrationCreds []IntegrationCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToSpecConfig(job.ConfigSnapshot)
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
	vc.IntegrationCredentials = toCoreIntegrationCreds(integrationCreds)

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
		SpecConfig:     vc,
		Provider:       provider,
		DryRun:         true,
		TemplatesDir:   filepath.Join(resolveSpecTemplatesDir(), provider),
		CategoriesDir:  resolveCategoriesTemplatesDir(),
		InfracostToken: infracostKey,
		GitAccessToken: planGitToken,
		S3Backend:      w.s3Backend(),
		Stdout:         stdout,
		Stderr:         stderr,
	}

	w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
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

	w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)

	return nil
}

func (w *Runner) executeDestroy(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	snapshot := job.ConfigSnapshot

	region := getSnapshotString(snapshot, "region")

	params := provisioner.DestroyParams{
		ZoneID:           job.ZoneID,
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

func snapshotToSpecConfig(snapshot map[string]any) (*types.SpecConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var vc types.SpecConfig
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
