package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	grapeAws "github.com/bobikenobi12/bb-thesis-2026/apps/grape/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/provisioner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
)

type Config struct {
	Mode        string // "self-hosted" or "cloud-hosted"
	TrellisURL  string
	WorkerID    string
	WorkerToken string
}

type Worker struct {
	config Config
	api    *WorkerAPIClient
}

func New(cfg Config) *Worker {
	return &Worker{
		config: cfg,
		api:    NewWorkerAPIClient(cfg.TrellisURL, cfg.WorkerID, cfg.WorkerToken),
	}
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
		fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
		sessionName := fmt.Sprintf("grape-worker-%s", job.ID[:8])
		if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
			errMsg := fmt.Sprintf("Failed to assume role: %v", err)
			fmt.Fprintln(stderrLogger, errMsg)
			w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
			return err
		}
		defer ClearAssumedCredentials()
	}

	var execErr error
	switch job.JobType {
	case "CONNECTION_TEST":
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
	case "FETCH_RESOURCES":
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
	case "BOOTSTRAP":
		execErr = w.executeBootstrap(ctx, job, stdoutLogger, stderrLogger)
	case "DEPLOY":
		execErr = w.executeDeploy(ctx, job, stdoutLogger, stderrLogger)
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

func (w *Worker) executeDeploy(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	config, err := snapshotToConfiguration(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}

	params := provisioner.DeployParams{
		Config: config,
		Stdout: stdout,
		Stderr: stderr,
	}

	return provisioner.RunDeploy(ctx, params)
}

func (w *Worker) executeDestroy(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	snapshot := job.ConfigSnapshot

	params := provisioner.DestroyParams{
		VineyardID:       job.VineyardID,
		Environment:      getSnapshotString(snapshot, "environment_stage"),
		Region:           getSnapshotString(snapshot, "aws_region"),
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

func snapshotToConfiguration(snapshot map[string]any) (*types.Configuration, error) {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var config types.Configuration
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
