package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	grapeAws "github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud/aws"
	grapeAzure "github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud/azure"
	grapeGcp "github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud/gcp"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/provisioner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

type Config struct {
	Mode        string // "self-hosted" or "cloud-hosted"
	TrellisURL  string
	WorkerID    string
	WorkerToken string
}

type Worker struct {
	config Config
	api    JobAPI
}

func New(cfg Config) *Worker {
	return &Worker{
		config: cfg,
		api:    NewWorkerAPIClient(cfg.TrellisURL, cfg.WorkerID, cfg.WorkerToken),
	}
}

func NewWithAPI(cfg Config, api JobAPI) *Worker {
	return &Worker{config: cfg, api: api}
}

func (w *Worker) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\nReceived shutdown signal, finishing current job...")
		cancel()
	}()

	go w.heartbeatLoop(ctx)

	fmt.Printf("Worker started (id=%s, mode=%s)\n", w.config.WorkerID, w.config.Mode)
	fmt.Printf("Polling %s for jobs...\n", w.config.TrellisURL)

	return w.pollLoop(ctx)
}

func (w *Worker) heartbeatLoop(ctx context.Context) {
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

func (w *Worker) pollLoop(ctx context.Context) error {
	pollInterval := 10 * time.Second

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
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

		if err := w.executeJob(ctx, claim); err != nil {
			fmt.Fprintf(os.Stderr, "Job %s failed: %v\n", claim.Job.ID, err)
		}
	}
}

func (w *Worker) executeJob(ctx context.Context, claim *ClaimResponse) error {
	job := claim.Job

	stdoutLogger := NewJobLogger(w.api, job.ID, "STDOUT")
	stderrLogger := NewJobLogger(w.api, job.ID, "STDERR")
	defer stdoutLogger.Close()
	defer stderrLogger.Close()

	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", nil); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to update job status to PROCESSING: %v\n", err)
	}

	if w.config.Mode == "cloud-hosted" && claim.CloudIdentity != nil {
		switch claim.CloudIdentity.Provider {
		case "aws":
			fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
			sessionName := fmt.Sprintf("grape-worker-%s", job.ID[:8])
			if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
				errMsg := fmt.Sprintf("Failed to assume role: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer ClearAssumedCredentials()
		case "gcp":
			fmt.Fprintf(stdoutLogger, "Activating WIF for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
			cleanup, err := ActivateGcpWIF(claim.CloudIdentity.WifConfig)
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
	case "BOOTSTRAP":
		execErr = w.executeBootstrap(ctx, job, stdoutLogger, stderrLogger)
	case "PLAN":
		execErr = w.executePlan(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case "DEPLOY":
		execErr = w.executeDeploy(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case "DESTROY":
		execErr = w.executeDestroy(ctx, job, stdoutLogger, stderrLogger)
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

func (w *Worker) fetchAwsResources(ctx context.Context, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching enabled regions...")
	ec2Client, err := grapeAws.NewEC2Client(ctx, grapeAws.AWSOptions{Region: "us-east-1"})
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
		regionalClient, err := grapeAws.NewEC2Client(ctx, grapeAws.AWSOptions{Region: region})
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
	r53Client, err := grapeAws.NewRoute53Client(ctx, grapeAws.AWSOptions{Region: "us-east-1"})
	var hostedZones []grapeAws.HostedZoneInfo
	if err == nil {
		hostedZones, _ = r53Client.ListHostedZones(ctx)
	}
	fmt.Fprintf(logger, "Found %d hosted zones\n", len(hostedZones))

	return map[string]any{
		"regions":      regions,
		"vpcs":         vpcs,
		"subnets":      subnets,
		"hosted_zones": hostedZones,
	}, nil
}

func (w *Worker) fetchGcpResources(ctx context.Context, projectID string, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching GCP compute regions...")
	computeClient, err := grapeGcp.NewComputeClient(ctx, projectID)
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
	dnsClient, err := grapeGcp.NewDNSClient(ctx, projectID)
	var managedZones []grapeGcp.ManagedZoneInfo
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

func (w *Worker) fetchAzureResources(ctx context.Context, subscriptionID string, logger *JobLogger) (map[string]any, error) {
	fmt.Fprintln(logger, "Fetching Azure locations...")
	computeClient, err := grapeAzure.NewComputeClient(ctx, subscriptionID)
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

	fmt.Fprintln(logger, "Fetching Azure DNS zones...")
	dnsClient, err := grapeAzure.NewDNSClient(ctx, subscriptionID)
	var dnsZones []grapeAzure.DnsZoneInfo
	if err == nil {
		dnsZones, _ = dnsClient.ListDnsZones(ctx)
	}
	fmt.Fprintf(logger, "Found %d DNS zones\n", len(dnsZones))

	return map[string]any{
		"locations": locations,
		"vnets":     vnets,
		"subnets":   map[string]any{},
		"dns_zones": dnsZones,
	}, nil
}

func (w *Worker) executeBootstrap(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	snapshot := job.ConfigSnapshot

	params := provisioner.BootstrapParams{
		VineyardID:  job.VineyardID,
		Environment: getSnapshotString(snapshot, "environment_stage"),
		Region:      getSnapshotString(snapshot, "aws_region"),
		VpcCidr:     getSnapshotString(snapshot, "vpc_cidr"),
		SelectedVpc: getSnapshotString(snapshot, "selected_vpc"),
		Stdout:      stdout,
		Stderr:      stderr,
	}

	if params.Environment == "" {
		params.Environment = "dev"
	}
	if params.Region == "" {
		params.Region = "eu-central-1"
	}

	result, err := provisioner.RunBootstrap(ctx, params)
	if err != nil {
		return err
	}

	if result != nil {
		metadata := map[string]any{
			"cluster_name": result.ClusterName,
			"cluster_id":   result.ClusterID,
		}
		w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)
	}

	return nil
}

func resolveTemplatesDir() string {
	candidates := []string{
		"/home/grape/templates",
		"templates",
		"../../packages/templates",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func (w *Worker) executeDeploy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	vc, err := snapshotToVineConfig(job.ConfigSnapshot)
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
		vc.CloudAccountID = identity.AccountID
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

	params := provisioner.DeployParams{
		VineConfig:     vc,
		Provider:       provider,
		TemplatesDir:   resolveTemplatesDir(),
		GitAccessToken: vc.GitAccessToken,
		Stdout:         stdout,
		Stderr:         stderr,
	}

	result, err := provisioner.RunDeployV2(ctx, params)
	if err != nil {
		return err
	}

	if result != nil && (result.ClusterName != "" || result.ClusterEndpoint != "") {
		metadata := map[string]any{
			"cluster_name":     result.ClusterName,
			"cluster_endpoint": result.ClusterEndpoint,
		}
		w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)
	}

	return nil
}

func (w *Worker) executePlan(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	vc, err := snapshotToVineConfig(job.ConfigSnapshot)
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
		vc.CloudAccountID = identity.AccountID
	}

	infracostKey := os.Getenv("INFRACOST_API_KEY")

	params := provisioner.DeployParams{
		VineConfig:     vc,
		Provider:       provider,
		DryRun:         true,
		TemplatesDir:   resolveTemplatesDir(),
		InfracostToken: infracostKey,
		GitAccessToken: vc.GitAccessToken,
		Stdout:         stdout,
		Stderr:         stderr,
	}

	w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "terraform_plan", "progress": "Running terraform plan...",
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
			fmt.Fprintln(stdout, "Warning: PlanJSON is nil — terraform show may have failed")
		}
		if result.CostBreakdown != nil {
			metadata["cost_breakdown"] = result.CostBreakdown
			if result.CostBreakdown.Summary != nil {
				metadata["cost_summary"] = result.CostBreakdown.Summary
			}
		}
	}

	w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)

	return nil
}

func (w *Worker) executeDestroy(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	snapshot := job.ConfigSnapshot

	region := getSnapshotString(snapshot, "region")
	if region == "" {
		region = getSnapshotString(snapshot, "aws_region")
	}

	params := provisioner.DestroyParams{
		VineyardID:       job.VineyardID,
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

func snapshotToVineConfig(snapshot map[string]any) (*types.VineConfig, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var vc types.VineConfig
	if err := json.Unmarshal(data, &vc); err != nil {
		return nil, err
	}

	if vc.Region == "" {
		if r, ok := snapshot["aws_region"]; ok {
			if s, ok := r.(string); ok {
				vc.Region = s
			}
		}
	}

	return &vc, nil
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
