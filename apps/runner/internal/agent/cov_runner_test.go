// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ---------------------------------------------------------------------------
// Test doubles shared by this file.
//
// The runner's job spine calls out through exactly two seams that already exist in
// production: the JobAPI interface (w.api) and the sandbox.Sandbox interface
// (w.sandbox). Both are struct fields, so an in-package test substitutes them
// without any production change — no new seam is introduced here.
// ---------------------------------------------------------------------------

// covRunSandbox is a sandbox.Sandbox that never runs the untrusted closure. It records the
// spec it was handed (so a test can write result.json / the phase marker into the real
// per-job workdir the runner created) and returns whatever the test wants.
type covRunSandbox struct {
	mu    sync.Mutex
	onRun func(spec sandbox.Spec) error
	specs []sandbox.Spec
}

// Run records the spec and delegates to the test's hook, ignoring the in-process closure.
func (s *covRunSandbox) Run(_ context.Context, spec sandbox.Spec, _ sandbox.Job) error {
	s.mu.Lock()
	s.specs = append(s.specs, spec)
	hook := s.onRun
	s.mu.Unlock()
	if spec.Warn != nil {
		spec.Warn("isolation stubbed for test")
	}
	if hook != nil {
		return hook(spec)
	}
	return nil
}

// lastSpec returns the spec of the most recent Run call.
func (s *covRunSandbox) lastSpec() sandbox.Spec {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.specs) == 0 {
		return sandbox.Spec{}
	}
	return s.specs[len(s.specs)-1]
}

// covRunAPI extends the package's mockAPI with per-test overrides for the job-channel calls
// the deploy/plan/destroy spine makes. Anything left nil falls through to mockAPI.
type covRunAPI struct {
	*mockAPI

	mu sync.Mutex

	updateErr     error
	getJobFn      func(jobID string) (*Job, error)
	gitTokenFn    func(jobID, repoURL string) (string, error)
	addonSecretFn func(jobID string) (map[string]map[string]string, error)
	stateTokenErr error
	downloadOK    bool // true ⇒ DownloadPlanArtifact creates the file and succeeds
	uploadErr     error
	purgeErr      error
	talosFetchFn  func(jobID string) (string, error)
	talosPutErr   error
	heartbeatFn   func() ([]string, error)
	claimFn       func() (*ClaimResponse, error)
	streamWakeFn  func(ctx context.Context, onEvent func(WakeEvent)) error

	awsErr     error
	gcpErr     error
	azureErr   error
	alibabaErr error

	talosPuts   []string
	uploadCalls int
	purgeCalls  int
}

// newCovRunAPI builds a covRunAPI over a fresh mockAPI.
func newCovRunAPI() *covRunAPI {
	return &covRunAPI{mockAPI: &mockAPI{claimResponse: &ClaimResponse{Job: nil}}}
}

// UpdateJobStatus records the update through mockAPI and optionally reports a failure.
func (a *covRunAPI) UpdateJobStatus(jobID, status, errMsg string, metadata map[string]any) error {
	_ = a.mockAPI.UpdateJobStatus(jobID, status, errMsg, metadata)
	return a.updateErr
}

// GetJob delegates to the test hook when one is set.
func (a *covRunAPI) GetJob(jobID string) (*Job, error) {
	if a.getJobFn != nil {
		return a.getJobFn(jobID)
	}
	return a.mockAPI.GetJob(jobID)
}

// FetchGitToken delegates to the test hook when one is set.
func (a *covRunAPI) FetchGitToken(jobID, repoURL string) (string, error) {
	if a.gitTokenFn != nil {
		return a.gitTokenFn(jobID, repoURL)
	}
	return "", nil
}

// FetchAddonSecrets delegates to the test hook when one is set.
func (a *covRunAPI) FetchAddonSecrets(jobID string) (map[string]map[string]string, error) {
	if a.addonSecretFn != nil {
		return a.addonSecretFn(jobID)
	}
	return nil, nil
}

// FetchStateToken fails when the test asked for a state-token mint failure.
func (a *covRunAPI) FetchStateToken(jobID string) (string, error) {
	if a.stateTokenErr != nil {
		return "", a.stateTokenErr
	}
	return "covrun-state-token", nil
}

// DownloadPlanArtifact writes an empty artifact when the test opted into a successful download.
func (a *covRunAPI) DownloadPlanArtifact(jobID, destPath string) error {
	if !a.downloadOK {
		return errors.New("no plan artifact stored")
	}
	return os.WriteFile(destPath, []byte("plan"), 0o600)
}

// UploadPlanArtifact counts the call and reports the test's configured outcome.
func (a *covRunAPI) UploadPlanArtifact(jobID, filePath string) error {
	a.mu.Lock()
	a.uploadCalls++
	a.mu.Unlock()
	return a.uploadErr
}

// PurgeProjectState counts the call and reports the test's configured outcome.
func (a *covRunAPI) PurgeProjectState(jobID, stateToken string) error {
	a.mu.Lock()
	a.purgeCalls++
	a.mu.Unlock()
	return a.purgeErr
}

// FetchFabricTalosconfig delegates to the test hook when one is set.
func (a *covRunAPI) FetchFabricTalosconfig(jobID string) (string, error) {
	if a.talosFetchFn != nil {
		return a.talosFetchFn(jobID)
	}
	return "", nil
}

// PutFabricTalosconfig records the persisted talosconfig and reports the configured outcome.
func (a *covRunAPI) PutFabricTalosconfig(jobID, talosconfig string) error {
	a.mu.Lock()
	a.talosPuts = append(a.talosPuts, talosconfig)
	a.mu.Unlock()
	return a.talosPutErr
}

// Heartbeat delegates to the test hook when one is set.
func (a *covRunAPI) Heartbeat() ([]string, error) {
	if a.heartbeatFn != nil {
		return a.heartbeatFn()
	}
	return a.mockAPI.Heartbeat()
}

// ClaimJob delegates to the test hook when one is set.
func (a *covRunAPI) ClaimJob() (*ClaimResponse, error) {
	if a.claimFn != nil {
		return a.claimFn()
	}
	return a.mockAPI.ClaimJob()
}

// StreamWake delegates to the test hook when one is set.
func (a *covRunAPI) StreamWake(ctx context.Context, onEvent func(WakeEvent)) error {
	if a.streamWakeFn != nil {
		return a.streamWakeFn(ctx, onEvent)
	}
	return a.mockAPI.StreamWake(ctx, onEvent)
}

// FetchAwsToken fails when the test asked for a federation-mint failure.
func (a *covRunAPI) FetchAwsToken(jobID string) (*AwsFederation, error) {
	if a.awsErr != nil {
		return nil, a.awsErr
	}
	return a.mockAPI.FetchAwsToken(jobID)
}

// FetchGcpToken fails when the test asked for a GCP-mint failure.
func (a *covRunAPI) FetchGcpToken(jobID string) (string, error) {
	if a.gcpErr != nil {
		return "", a.gcpErr
	}
	return a.mockAPI.FetchGcpToken(jobID)
}

// FetchAzureToken fails when the test asked for an Azure-mint failure.
func (a *covRunAPI) FetchAzureToken(jobID string) (string, error) {
	if a.azureErr != nil {
		return "", a.azureErr
	}
	return a.mockAPI.FetchAzureToken(jobID)
}

// FetchAlibabaToken fails when the test asked for an Alibaba-mint failure.
func (a *covRunAPI) FetchAlibabaToken(jobID string) (string, error) {
	if a.alibabaErr != nil {
		return "", a.alibabaErr
	}
	return a.mockAPI.FetchAlibabaToken(jobID)
}

// covRunSnapshot is a minimal config_snapshot that decodes cleanly against the strict
// ProjectConfig contract.
func covRunSnapshot() map[string]any {
	return map[string]any{
		"project_name":      "covrun",
		"region":            "nbg1",
		"environment_stage": "dev",
	}
}

// covRunBadSnapshot carries a key types.ProjectConfig does not model, so
// snapshotToProjectConfig fails closed immediately.
func covRunBadSnapshot() map[string]any {
	return map[string]any{"project_name": "covrun", "covrun_unknown_key": true}
}

// covRunWriteResult writes a stage result.json holding the given raw PlanResult JSON into
// the per-job workdir, exactly where the sandbox child would leave it.
func covRunWriteResult(t *testing.T, workDir, planResultJSON string) {
	t.Helper()
	body := `{"plan_result":` + planResultJSON + `}`
	if err := os.WriteFile(filepath.Join(workDir, "result.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write result.json: %v", err)
	}
}

// covRunFullPlanResult is a PlanResult carrying every optional field buildDeployMetadata
// forwards, plus a talosconfig output and a NESTED secret the whole-blob scrub must catch.
// PlanResult has no json tags, so the keys are the Go field names.
const covRunFullPlanResult = `{
  "ClusterName": "covrun-cluster",
  "ClusterEndpoint": "https://covrun.example",
  "ClusterReady": true,
  "ArgocdURL": "https://argocd.covrun.example",
  "Outputs": {
    "kubeconfig": "SENSITIVE-DROPPED-BY-OUTPUT-SCRUB",
    "talosconfig": {"value": "COVRUN-TALOSCONFIG"},
    "vpc_id": "vpc-covrun",
    "cluster_info": {"admin_password": "SENSITIVE-DROPPED-BY-TREE-SCRUB"}
  },
  "VerifyReport": {},
  "VerifyReceipt": {},
  "CompatReport": {},
  "AddOnStatus": {"argocd": {}},
  "DataEndpoints": {"db-primary": {}},
  "InfraServices": [{}],
  "KeylessBindings": [{}],
  "SecurityPosture": {},
  "GitopsStatus": {},
  "PlanJSON": {"resource_changes": [{"address": "module.x"}]},
  "CostBreakdown": {"summary": {}},
  "PlanFileBytes": "cGxhbmJ5dGVz"
}`

// covRunShortTimings shortens the runner's background-loop timing vars for the duration of a
// test and restores them afterwards, so the loops finish instantly.
func covRunShortTimings(t *testing.T) {
	t.Helper()
	hb, grace, base, max := heartbeatInterval, shutdownGracePeriod, wakeBackoffBase, wakeMaxBackoff
	t.Cleanup(func() {
		heartbeatInterval, shutdownGracePeriod, wakeBackoffBase, wakeMaxBackoff = hb, grace, base, max
	})
	heartbeatInterval = 2 * time.Millisecond
	shutdownGracePeriod = 10 * time.Millisecond
	wakeBackoffBase = time.Millisecond
	wakeMaxBackoff = 2 * time.Millisecond
}

// covRunTerminal returns the last terminal status update posted for a job.
func covRunTerminal(api *covRunAPI, jobID string) (statusUpdate, bool) {
	var out statusUpdate
	var found bool
	for _, u := range api.getStatusUpdates() {
		if u.jobID != jobID {
			continue
		}
		if u.status == "SUCCESS" || u.status == "FAILED" || u.status == "CANCELLED" {
			out, found = u, true
		}
	}
	return out, found
}

// ---------------------------------------------------------------------------
// Construction + sandbox selection
// ---------------------------------------------------------------------------

// TestRun_New_BuildsAPIBackedRunner proves the production constructor wires a real API client,
// the selected sandbox and a cancel registry (NewWithAPI is the injection variant used elsewhere).
func TestRun_New_BuildsAPIBackedRunner(t *testing.T) {
	w := New(Config{Operator: "self", AlethiaURL: "https://console.invalid", RunnerID: "r-1", RunnerToken: "t", Providers: []string{"hetzner"}})
	if w.api == nil || w.sandbox == nil || w.cancels == nil {
		t.Fatal("New must wire an api, a sandbox and a cancel registry")
	}
	client, ok := w.api.(*RunnerAPIClient)
	if !ok {
		t.Fatalf("New must build a RunnerAPIClient, got %T", w.api)
	}
	if len(client.providers) != 1 || client.providers[0] != "hetzner" {
		t.Errorf("per-cloud routing providers must reach the client, got %v", client.providers)
	}
}

// TestRun_SelectSandbox_FailsClosedWhenContainerUnavailable proves the fail-closed contract: when
// the container backend is REQUESTED but cannot initialize, a non-self operator gets a Passthrough
// that REFUSES every job (EnforceManaged), while an explicit self operator gets a lenient one.
func TestRun_SelectSandbox_FailsClosedWhenContainerUnavailable(t *testing.T) {
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "container")
	t.Setenv("ALETHIA_SANDBOX_RUNTIME", "covrun-no-such-container-runtime")

	managed, ok := selectSandbox(Config{Operator: "managed"}).(sandbox.Passthrough)
	if !ok {
		t.Fatal("an unavailable container backend must degrade to Passthrough")
	}
	if !managed.EnforceManaged {
		t.Error("a non-self operator must get an EnforceManaged (job-refusing) Passthrough")
	}

	self, ok := selectSandbox(Config{Operator: "self"}).(sandbox.Passthrough)
	if !ok {
		t.Fatal("an unavailable container backend must degrade to Passthrough for self too")
	}
	if self.EnforceManaged {
		t.Error("an explicit self operator must get the lenient Passthrough")
	}
}

// TestRun_SelectSandbox_DefaultPassthroughHonoursEnforceFlag proves the config-driven kill-switch on
// the DEFAULT (no-container) path.
func TestRun_SelectSandbox_DefaultPassthroughHonoursEnforceFlag(t *testing.T) {
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "yes")
	p, ok := selectSandbox(Config{Operator: "managed"}).(sandbox.Passthrough)
	if !ok {
		t.Fatalf("default backend must be Passthrough, got %T", selectSandbox(Config{}))
	}
	if !p.EnforceManaged {
		t.Error("ALETHIA_SANDBOX_ENFORCE_MANAGED must reach the default Passthrough")
	}
}

// TestRun_SelectSandbox_UsesContainerBackendWhenAvailable proves the container backend is adopted
// when it initializes. A binary that merely EXISTS on PATH stands in for the container runtime —
// selectSandbox only has to resolve it, and no container is ever started here.
func TestRun_SelectSandbox_UsesContainerBackendWhenAvailable(t *testing.T) {
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "container")
	t.Setenv("ALETHIA_SANDBOX_RUNTIME", "sh")
	t.Setenv("ALETHIA_SANDBOX_IMAGE", "example.invalid/covrun-runner:test")
	t.Setenv("ALETHIA_SANDBOX_EGRESS_ENFORCED", "1")

	c, ok := selectSandbox(Config{Operator: "managed"}).(sandbox.Container)
	if !ok {
		t.Fatalf("an initializable container backend must be adopted, got %T", selectSandbox(Config{Operator: "managed"}))
	}
	if c.Operator != "managed" || !c.EgressEnforced || c.Image != "example.invalid/covrun-runner:test" {
		t.Errorf("container backend not configured from the environment: %+v", c)
	}
}

// TestRun_StateBackend_SurfacesMintFailure proves a failed per-job state-token mint is reported
// with context rather than silently producing a token-less backend config.
func TestRun_StateBackend_SurfacesMintFailure(t *testing.T) {
	api := newCovRunAPI()
	api.stateTokenErr = errors.New("mint refused")
	w := NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.invalid"}, api)

	if _, err := w.stateBackend("job-1"); err == nil || !strings.Contains(err.Error(), "tofu state token") {
		t.Fatalf("expected a wrapped state-token error, got %v", err)
	}

	api.stateTokenErr = nil
	cfg, err := w.stateBackend("job-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.JobID != "job-1" || cfg.Token != "covrun-state-token" || cfg.ConsoleURL != "https://console.invalid" {
		t.Errorf("state backend config not assembled from the job + runner config: %+v", cfg)
	}
}

// TestRun_ResolveCategoriesTemplatesDir_PicksLocalCandidate covers the composable-category
// module lookup, which finds nothing from the package dir in a checkout.
func TestRun_ResolveCategoriesTemplatesDir_PicksLocalCandidate(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "category-templates"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Chdir(dir)
	if got := resolveCategoriesTemplatesDir(); got != "category-templates" {
		t.Errorf("resolveCategoriesTemplatesDir() = %q, want %q", got, "category-templates")
	}
	if got := resolveProjectTemplatesDir(); got != "" {
		t.Errorf("resolveProjectTemplatesDir() = %q, want empty when no candidate exists", got)
	}
}

// ---------------------------------------------------------------------------
// Background loops: Run, heartbeat, wake, claim
// ---------------------------------------------------------------------------

// TestRun_Run_StartsLoopsAndDrainsOnSignal proves the process spine: Run starts the heartbeat,
// and a SIGTERM flips the runner to draining so claimLoop exits cleanly. signal.Notify is
// registered before the heartbeat fires, so the self-signal is delivered to the runner's channel
// rather than terminating the test binary.
func TestRun_Run_StartsLoopsAndDrainsOnSignal(t *testing.T) {
	covRunShortTimings(t)
	api := newCovRunAPI()

	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-signal", AlethiaURL: "https://console.invalid"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()

	// The heartbeat goroutine starts AFTER signal.Notify, so a beat proves the handler is armed.
	deadline := time.After(3 * time.Second)
	for {
		api.mockAPI.mu.Lock()
		beats := api.heartbeatCount
		api.mockAPI.mu.Unlock()
		if beats > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("heartbeat never fired; Run did not start its loops")
		default:
		}
		time.Sleep(2 * time.Millisecond)
	}

	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("self-signal: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a drained shutdown must return nil, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after the shutdown signal")
	}
}

// TestRun_HeartbeatLoop_ReportsFailuresAndAppliesCancels proves both heartbeat arms: a failing
// beat is logged (and captured) without killing the loop, and a beat that reports a
// server-side-cancelled job tears that job down through the fallback path.
func TestRun_HeartbeatLoop_ReportsFailuresAndAppliesCancels(t *testing.T) {
	covRunShortTimings(t)

	var beats atomic.Int32
	api := newCovRunAPI()
	api.heartbeatFn = func() ([]string, error) {
		// Beat 1 is the initial (pre-ticker) beat and beat 2 the first ticker beat — both
		// fail, so each failure arm runs; from beat 3 the console reports the cancel.
		if beats.Add(1) <= 2 {
			return nil, errors.New("heartbeat refused")
		}
		return []string{"hb-covrun"}, nil
	}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-hb"}, api)

	_, jobCancel := context.WithCancel(context.Background())
	defer jobCancel()
	w.cancels.register("hb-covrun", jobCancel)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.heartbeatLoop(ctx); close(done) }()

	deadline := time.After(3 * time.Second)
	for !w.cancels.wasCancelled("hb-covrun") {
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("the heartbeat fallback never cancelled the reported job")
		default:
		}
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	<-done

	if beats.Load() < 3 {
		t.Errorf("expected both the failing ticker arm and a reporting beat, got %d beats", beats.Load())
	}
}

// TestRun_WakeLoop_ReconnectsWithBoundedBackoff proves the push-dispatch stream reconnects after
// both a clean EOF and an error, that the backoff is capped, and that a cancelled context stops it.
func TestRun_WakeLoop_ReconnectsWithBoundedBackoff(t *testing.T) {
	covRunShortTimings(t)

	var conns atomic.Int32
	api := newCovRunAPI()
	api.streamWakeFn = func(ctx context.Context, onEvent func(WakeEvent)) error {
		n := conns.Add(1)
		onEvent(WakeEvent{Type: "wake"})
		if n%2 == 0 {
			return errors.New("stream dropped")
		}
		return nil
	}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-wake"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	var events atomic.Int32
	done := make(chan struct{})
	go func() {
		w.wakeLoop(ctx, func(WakeEvent) { events.Add(1) })
		close(done)
	}()

	deadline := time.After(3 * time.Second)
	for conns.Load() < 6 {
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatalf("wake stream only reconnected %d times", conns.Load())
		default:
		}
		time.Sleep(time.Millisecond)
	}
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("wakeLoop did not stop after its context was cancelled")
	}
	if events.Load() == 0 {
		t.Error("expected wake events to be dispatched")
	}
}

// TestRun_ClaimLoop_BreaksDrainOnClaimError proves a claim failure ends the drain (rather than
// hot-looping against a failing console) and that the loop exits once the runner starts draining.
func TestRun_ClaimLoop_BreaksDrainOnClaimError(t *testing.T) {
	covRunShortTimings(t)

	var claims atomic.Int32
	api := newCovRunAPI()
	api.claimFn = func() (*ClaimResponse, error) {
		claims.Add(1)
		return nil, errors.New("claim refused")
	}
	// Reconnecting stream ⇒ a fresh wake every backoff, so the outer loop re-checks draining.
	api.streamWakeFn = func(ctx context.Context, onEvent func(WakeEvent)) error {
		onEvent(WakeEvent{Type: "wake"})
		return errors.New("stream dropped")
	}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-claim"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var draining atomic.Bool
	done := make(chan error, 1)
	go func() { done <- w.claimLoop(ctx, &draining) }()

	deadline := time.After(3 * time.Second)
	for claims.Load() < 2 {
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("claimLoop never retried after a claim error")
		default:
		}
		time.Sleep(time.Millisecond)
	}

	draining.Store(true)
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a draining claimLoop must return nil, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("claimLoop did not exit once draining")
	}
}

// TestRun_ClaimLoop_StopsMidDrainOnContextCancel proves the drain re-checks the root context
// between jobs: once it is cancelled, the loop returns instead of claiming another job.
func TestRun_ClaimLoop_StopsMidDrainOnContextCancel(t *testing.T) {
	covRunShortTimings(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var claims atomic.Int32
	api := newCovRunAPI()
	api.claimFn = func() (*ClaimResponse, error) {
		if claims.Add(1) >= 2 {
			cancel() // the shutdown-drain force-cancel, observed at the top of the next iteration
		}
		return &ClaimResponse{Job: &Job{
			ID: "covrun-drain", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{},
		}}, nil
	}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-drain"}, api)

	var draining atomic.Bool
	done := make(chan error, 1)
	go func() { done <- w.claimLoop(ctx, &draining) }()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a context-cancelled claimLoop must return nil, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claimLoop did not return after its context was cancelled")
	}
	if claims.Load() < 2 {
		t.Errorf("expected at least two claims before the cancel, got %d", claims.Load())
	}
}

// TestRun_ClaimLoop_ReturnsWhenContextCancelledWhileIdle proves the idle select arm: a runner
// parked between wakes exits on context cancellation.
func TestRun_ClaimLoop_ReturnsWhenContextCancelledWhileIdle(t *testing.T) {
	covRunShortTimings(t)
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-idle"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	var draining atomic.Bool
	done := make(chan error, 1)
	go func() { done <- w.claimLoop(ctx, &draining) }()

	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("expected nil on context cancel, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("an idle claimLoop did not exit on context cancel")
	}
}

// ---------------------------------------------------------------------------
// executeJob: status posting, credential activation, dispatch
// ---------------------------------------------------------------------------

// TestRun_ExecuteJob_ReportsProcessingPostFailure proves a failed PROCESSING transition is
// surfaced on the SYSTEM stream instead of dying on the runner's own stderr — the job still runs.
func TestRun_ExecuteJob_ReportsProcessingPostFailure(t *testing.T) {
	api := newCovRunAPI()
	api.updateErr = errors.New("console unreachable")
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-sys"}, api)

	_ = w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "covrun-sys", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
	})

	var sawSystem bool
	for _, c := range api.getLogChunks() {
		if c.streamType == "SYSTEM" && strings.Contains(c.chunk, "PROCESSING") {
			sawSystem = true
		}
	}
	if !sawSystem {
		t.Error("a failed PROCESSING post must be reported on the SYSTEM stream")
	}
}

// TestRun_ExecuteJob_ActivatesAwsFederationForManagedRunner proves the keyless managed AWS path:
// the assertion is minted over the job channel and the SDK is pointed at a web-identity profile.
func TestRun_ExecuteJob_ActivatesAwsFederationForManagedRunner(t *testing.T) {
	t.Setenv("AWS_CONFIG_FILE", "")
	t.Setenv("AWS_PROFILE", "")
	t.Setenv("AWS_SDK_LOAD_CONFIG", "")
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-aws"}, api)

	_ = w.executeJob(t.Context(), &ClaimResponse{
		Job:           &Job{ID: "covrun-aws", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
		CloudIdentity: &CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1234:role/covrun", AccountID: "1234"},
	})

	var banner bool
	for _, c := range api.getLogChunks() {
		if strings.Contains(c.chunk, "keyless AWS federation") {
			banner = true
		}
	}
	if !banner {
		t.Error("the managed AWS path must announce keyless federation")
	}
	if u, ok := covRunTerminal(api, "covrun-aws"); !ok || u.status != "FAILED" {
		t.Errorf("the bogus job type must still fail the job, got %+v", u)
	}
}

// TestRun_ExecuteJob_FailsWhenAwsFederationMintFails proves a failed assertion mint fails the job
// before any provisioning work.
func TestRun_ExecuteJob_FailsWhenAwsFederationMintFails(t *testing.T) {
	api := newCovRunAPI()
	api.awsErr = errors.New("issuer refused")
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-aws-fail"}, api)

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job:           &Job{ID: "covrun-aws-fail", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot()},
		CloudIdentity: &CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1234:role/covrun"},
	})
	if err == nil {
		t.Fatal("a failed AWS federation must fail the job")
	}
	if u, ok := covRunTerminal(api, "covrun-aws-fail"); !ok || u.status != "FAILED" {
		t.Errorf("expected FAILED, got %+v", u)
	}
}

// TestRun_ExecuteJob_SelfRunnerAssumeRoleFailureIsFatal proves the self-hosted AWS path fails the
// job when AssumeRole does not succeed. The context is pre-cancelled so the STS call fails locally
// — no network, no ambient credentials.
func TestRun_ExecuteJob_SelfRunnerAssumeRoleFailureIsFatal(t *testing.T) {
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_REGION", "eu-central-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "covrun-not-a-real-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "covrun-not-a-real-secret")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-aws-self"}, api)

	err := w.executeJob(ctx, &ClaimResponse{
		Job:           &Job{ID: "covrun-aws-self", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
		CloudIdentity: &CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1234:role/covrun", ExternalID: "x", AccountID: "1234"},
	})
	if err == nil {
		t.Fatal("AssumeRole must fail on a cancelled context")
	}
}

// TestRun_ExecuteJob_RefusesRetiredGcpHubConfig proves a GCP connection still on the retired
// AWS-hub setup is refused with a reconnect instruction rather than silently attempted.
func TestRun_ExecuteJob_RefusesRetiredGcpHubConfig(t *testing.T) {
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-gcp-legacy"}, api)

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job:           &Job{ID: "covrun-gcp-legacy", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
		CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "p", WifConfig: `{"subject_token_type":"urn:ietf:params:aws:token-type:aws4_request"}`},
	})
	if err == nil || !strings.Contains(err.Error(), "retired AWS-hub") {
		t.Fatalf("expected the retired-hub refusal, got %v", err)
	}
}

// TestRun_ExecuteJob_ActivatesGcpOidcForManagedRunner covers the direct-OIDC GCP path and its
// mint-failure arm.
func TestRun_ExecuteJob_ActivatesGcpOidcForManagedRunner(t *testing.T) {
	wif := `{"type":"external_account","subject_token_type":"` + gcpJWTSubjectTokenType + `","audience":"//iam.googleapis.com/covrun"}`

	t.Run("activates", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-gcp"}, api)
		_ = w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-gcp", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "covrun-proj", ServiceAccountEmail: "sa@covrun", WifConfig: wif},
		})
		var banner bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "keyless GCP OIDC") {
				banner = true
			}
		}
		if !banner {
			t.Error("the managed GCP path must announce keyless OIDC")
		}
	})

	t.Run("mint failure is fatal", func(t *testing.T) {
		api := newCovRunAPI()
		api.gcpErr = errors.New("issuer refused")
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-gcp-fail"}, api)
		err := w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-gcp-fail", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "covrun-proj", WifConfig: wif},
		})
		if err == nil {
			t.Fatal("a failed GCP mint must fail the job")
		}
	})
}

// TestRun_ExecuteJob_ActivatesGcpWifForSelfRunner covers the self-hosted GCP WIF path and its
// empty-config failure arm.
func TestRun_ExecuteJob_ActivatesGcpWifForSelfRunner(t *testing.T) {
	t.Run("activates", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-gcp-self"}, api)
		_ = w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-gcp-self", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "covrun-proj", WifConfig: `{"type":"external_account"}`},
		})
		var banner bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "Activating WIF") {
				banner = true
			}
		}
		if !banner {
			t.Error("the self-hosted GCP path must announce WIF activation")
		}
	})

	t.Run("empty wif config is fatal", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-gcp-self-fail"}, api)
		err := w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-gcp-self-fail", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "covrun-proj"},
		})
		if err == nil {
			t.Fatal("an empty WIF config must fail the job")
		}
	})
}

// TestRun_ExecuteJob_ActivatesAzureFederatedIdentity covers the Azure OIDC path and its
// missing-identity failure arm.
func TestRun_ExecuteJob_ActivatesAzureFederatedIdentity(t *testing.T) {
	t.Run("activates", func(t *testing.T) {
		t.Setenv("ARM_SUBSCRIPTION_ID", "")
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-azure"}, api)
		_ = w.executeJob(t.Context(), &ClaimResponse{
			Job: &Job{ID: "covrun-azure", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{
				Provider: "azure", TenantID: "tenant-1", ClientID: "client-1", SubscriptionID: "sub-1",
			},
		})
		var banner bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "Azure federated identity") {
				banner = true
			}
		}
		if !banner {
			t.Error("the Azure path must announce federated-identity activation")
		}
	})

	t.Run("missing tenant is fatal", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-azure-fail"}, api)
		err := w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-azure-fail", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "azure", SubscriptionID: "sub-1"},
		})
		if err == nil {
			t.Fatal("a missing Azure tenant/client must fail the job")
		}
	})
}

// TestRun_ExecuteJob_ActivatesTokenCloud covers the token-cloud arm, including the optional
// Hetzner Object Storage key pair and the empty-token failure.
func TestRun_ExecuteJob_ActivatesTokenCloud(t *testing.T) {
	t.Run("hetzner with object storage keys", func(t *testing.T) {
		t.Setenv("HCLOUD_TOKEN", "")
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-hetzner"}, api)
		_ = w.executeJob(t.Context(), &ClaimResponse{
			Job: &Job{ID: "covrun-hetzner", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{
				Provider: "hetzner", APIToken: "covrun-hcloud-token",
				S3AccessKey: "covrun-ak", S3SecretKey: "covrun-sk",
			},
		})
		var s3Banner bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "Hetzner Object Storage") {
				s3Banner = true
			}
		}
		if !s3Banner {
			t.Error("a Hetzner identity carrying an S3 key pair must activate object-storage creds")
		}
	})

	t.Run("empty token is fatal", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-civo-fail"}, api)
		err := w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-civo-fail", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "civo"},
		})
		if err == nil {
			t.Fatal("an empty token-cloud API token must fail the job")
		}
	})
}

// TestRun_ExecuteJob_ActivatesAlibabaOidc covers the keyless Alibaba arm and its
// missing-ARN failure.
func TestRun_ExecuteJob_ActivatesAlibabaOidc(t *testing.T) {
	t.Run("activates", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-alibaba"}, api)
		_ = w.executeJob(t.Context(), &ClaimResponse{
			Job: &Job{ID: "covrun-alibaba", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{
				Provider: "alibaba", RoleArn: "acs:ram::1:role/covrun", OidcProviderArn: "acs:ram::1:oidc-provider/covrun",
			},
		})
		var banner bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "keyless Alibaba OIDC") {
				banner = true
			}
		}
		if !banner {
			t.Error("the Alibaba path must announce keyless OIDC")
		}
	})

	t.Run("missing arns are fatal", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-alibaba-fail"}, api)
		err := w.executeJob(t.Context(), &ClaimResponse{
			Job:           &Job{ID: "covrun-alibaba-fail", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
			CloudIdentity: &CloudIdentity{Provider: "alibaba", RoleArn: "acs:ram::1:role/covrun"},
		})
		if err == nil {
			t.Fatal("a missing Alibaba OIDC provider ARN must fail the job")
		}
	})
}

// TestRun_ExecuteJob_DispatchesEveryJobType proves the exhaustive job-type switch routes each
// provision_job_type to its executor. Every case is given an input its executor rejects
// immediately, so the assertion is on the ROUTING, not on the executor's own work.
func TestRun_ExecuteJob_DispatchesEveryJobType(t *testing.T) {
	cases := []struct {
		jobType  types.JobType
		snapshot map[string]any
	}{
		{types.JobTypePlan, covRunBadSnapshot()},
		{types.JobTypeDeploy, covRunBadSnapshot()},
		{types.JobTypeDestroy, covRunBadSnapshot()},
		{types.JobTypeDeployRunner, map[string]any{}},
		{types.JobTypeUpdateRunner, map[string]any{}},
		{types.JobTypeDestroyRunner, map[string]any{}},
		{types.JobTypeAnalyzeRepo, map[string]any{}},
		{types.JobTypeDetectDrift, covRunBadSnapshot()},
		{types.JobTypeAudit, map[string]any{}},
		{types.JobTypeChartScan, map[string]any{}},
		{types.JobTypeIacScan, map[string]any{}},
		{types.JobTypeStateSurgery, map[string]any{}},
		{types.JobTypeProbeCluster, covRunBadSnapshot()},
		{types.JobTypeBuild, covRunBadSnapshot()},
	}

	for _, tc := range cases {
		t.Run(string(tc.jobType), func(t *testing.T) {
			// A non-self operator makes IAC_SCAN fail closed at the E0 boundary; it is
			// irrelevant to the other executors, all of which reject their input first.
			t.Setenv("ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED", "")
			api := newCovRunAPI()
			w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-dispatch"}, api)
			jobID := "covrun-" + string(tc.jobType)

			err := w.executeJob(t.Context(), &ClaimResponse{
				Job: &Job{ID: jobID, JobType: string(tc.jobType), ConfigSnapshot: tc.snapshot},
			})
			if err == nil {
				t.Fatalf("%s: expected the executor to reject its stub input", tc.jobType)
			}
			if u, ok := covRunTerminal(api, jobID); !ok || u.status != "FAILED" {
				t.Errorf("%s: expected a FAILED terminal status, got %+v", tc.jobType, u)
			}
		})
	}
}

// TestRun_ExecuteJob_FlagsOrphanEvidenceFromFailedApply proves issue #526's terminal metadata:
// an apply that FAILED (not interrupted) but carried positive evidence of a resource left outside
// tofu state posts orphan_risk plus the importable address/id pair, so the operator gets a
// diagnosis instead of a permanently wedged environment.
func TestRun_ExecuteJob_FlagsOrphanEvidenceFromFailedApply(t *testing.T) {
	api := newCovRunAPI()
	sb := &covRunSandbox{onRun: func(sandbox.Spec) error {
		return &provisioner.ApplyOrphanError{
			Err: errors.New("apply failed"),
			Finding: provisioner.OrphanFinding{
				Evidence: provisioner.OrphanCertain,
				Address:  "module.covrun.aws_vpc.this",
				CloudID:  "vpc-covrun",
				Reason:   "the provider reported the resource already exists",
			},
		}
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-orphan"}, api)
	w.sandbox = sb

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "covrun-orphan", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
	})
	if err == nil {
		t.Fatal("expected the apply failure to surface")
	}

	u, ok := covRunTerminal(api, "covrun-orphan")
	if !ok || u.status != "FAILED" {
		t.Fatalf("expected FAILED, got %+v", u)
	}
	if u.metadata["orphan_risk"] != true {
		t.Fatalf("expected orphan_risk=true, got %v", u.metadata)
	}
	if u.metadata["orphan_resource_address"] != "module.covrun.aws_vpc.this" {
		t.Errorf("expected the tofu address in the metadata, got %v", u.metadata["orphan_resource_address"])
	}
	if u.metadata["orphan_resource_cloud_id"] != "vpc-covrun" {
		t.Errorf("expected the cloud id in the metadata, got %v", u.metadata["orphan_resource_cloud_id"])
	}
}

// TestRun_ExecuteJob_PostsSuccessOnCleanRun proves the happy terminal transition.
func TestRun_ExecuteJob_PostsSuccessOnCleanRun(t *testing.T) {
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-ok"}, api)
	w.sandbox = &covRunSandbox{}

	if err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "covrun-ok", JobType: string(types.JobTypeDestroy), ConfigSnapshot: covRunSnapshot()},
	}); err != nil {
		t.Fatalf("a clean destroy must succeed, got %v", err)
	}
	if u, ok := covRunTerminal(api, "covrun-ok"); !ok || u.status != "SUCCESS" {
		t.Errorf("expected SUCCESS, got %+v", u)
	}
}

// ---------------------------------------------------------------------------
// executeDeploy
// ---------------------------------------------------------------------------

// covRunDeploySnapshot is a DEPLOY config_snapshot exercising every per-add-on branch the deploy
// spine walks: a non-git add-on, a git add-on with no repo, two sharing one repo (so the token is
// resolved once), a git add-on whose token fetch fails, and one declaring a secret ref.
func covRunDeploySnapshot(placement string) map[string]any {
	snap := covRunSnapshot()
	snap["addons"] = []any{
		map[string]any{"id": "a1", "chartRepo": "https://charts.example", "chart": "x"},
		map[string]any{"id": "a2", "source": "git"},
		map[string]any{"id": "a3", "source": "git", "chartRepo": "https://git.example/x.git"},
		map[string]any{"id": "a4", "source": "git", "chartRepo": "https://git.example/x.git"},
		map[string]any{"id": "a5", "source": "git", "chartRepo": "https://git.example/broken.git"},
		map[string]any{"id": "a6", "secretRef": map[string]any{}},
	}
	if placement != "" {
		snap["placement_mode"] = placement
	}
	return snap
}

// TestRun_ExecuteDeploy_SucceedsAndPersistsMetadata drives the whole DEPLOY spine on the happy
// path — plan-job validation, per-repo BYO git tokens, add-on secrets, the saved plan artifact,
// the cost-ceiling estimate, the sandbox hand-off, the execution_metadata post (scrubbed at two
// layers) and the Fabric talosconfig write-back.
func TestRun_ExecuteDeploy_SucceedsAndPersistsMetadata(t *testing.T) {
	t.Setenv("ALETHIA_COST_CEILING_MONTHLY_USD", "250")
	t.Setenv("INFRACOST_API_KEY", "covrun-infracost")

	planJobID := "covrun-plan-job"
	hash := "covrun-hash"
	api := newCovRunAPI()
	api.downloadOK = true
	api.getJobFn = func(id string) (*Job, error) {
		return &Job{ID: id, Status: "SUCCESS", ConfigurationHash: &hash}, nil
	}
	api.gitTokenFn = func(jobID, repoURL string) (string, error) {
		if strings.Contains(repoURL, "broken") {
			return "", errors.New("no credential for that repo")
		}
		return "covrun-git-token", nil
	}
	api.addonSecretFn = func(string) (map[string]map[string]string, error) {
		return map[string]map[string]string{"a6": {"apiKey": "covrun"}}, nil
	}

	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		covRunWriteResult(t, spec.WorkDir, covRunFullPlanResult)
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-deploy", AlethiaURL: "https://console.invalid"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-deploy", "STDOUT")
	stderr := NewJobLogger(api, "covrun-deploy", "STDERR")
	job := &Job{
		ID: "covrun-deploy", JobType: string(types.JobTypeDeploy),
		ConfigSnapshot: covRunDeploySnapshot(""), PlanJobID: &planJobID, ConfigurationHash: &hash,
	}
	err := w.executeDeploy(t.Context(), job, "hetzner", &CloudIdentity{Provider: "hetzner", AccountID: "acct-1"}, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("deploy must succeed: %v", err)
	}

	if spec := sb.lastSpec(); spec.Kind != "deploy" || spec.Provider != "hetzner" || spec.Stage == nil {
		t.Errorf("the sandbox must receive a serialized deploy stage, got %+v", spec)
	}

	// The Fabric's admin talosconfig is written back after a dedicated apply.
	api.mu.Lock()
	puts := append([]string(nil), api.talosPuts...)
	api.mu.Unlock()
	if len(puts) != 1 || puts[0] != "COVRUN-TALOSCONFIG" {
		t.Errorf("expected the dedicated apply to persist the Fabric talosconfig, got %v", puts)
	}

	// execution_metadata is posted as a PROCESSING merge, scrubbed at both layers.
	var meta map[string]any
	for _, u := range api.getStatusUpdates() {
		if u.jobID == "covrun-deploy" && u.status == "PROCESSING" && u.metadata != nil {
			meta = u.metadata
		}
	}
	if meta == nil {
		t.Fatal("expected execution_metadata to be posted")
	}
	for _, k := range []string{"cluster_name", "cluster_endpoint", "cluster_ready", "argocd_url", "outputs",
		"verify_result", "verify_receipt", "compat_result", "addon_status", "data_endpoints",
		"infra_services", "keyless_bindings", "security_report", "gitops_status"} {
		if _, ok := meta[k]; !ok {
			t.Errorf("execution_metadata is missing %q: %v", k, meta)
		}
	}
	outputs, _ := meta["outputs"].(map[string]any)
	if _, leaked := outputs["kubeconfig"]; leaked {
		t.Error("a kubeconfig output must never reach execution_metadata")
	}
	if _, leaked := outputs["talosconfig"]; leaked {
		t.Error("a talosconfig output must never reach execution_metadata")
	}
	nested, _ := outputs["cluster_info"].(map[string]any)
	if _, leaked := nested["admin_password"]; leaked {
		t.Error("the whole-blob backstop must drop a NESTED credential key")
	}
}

// TestRun_ExecuteDeploy_MintsPlacementTalosconfig proves a hetzner namespace/vcluster placement
// fetches the Fabric's persisted admin talosconfig (and proceeds fail-safe when it cannot).
func TestRun_ExecuteDeploy_MintsPlacementTalosconfig(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fetchFn func(string) (string, error)
	}{
		{"fetched", func(string) (string, error) { return "COVRUN-FABRIC-TALOS", nil }},
		{"fetch fails fail-safe", func(string) (string, error) { return "", errors.New("no fabric config") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newCovRunAPI()
			api.talosFetchFn = tc.fetchFn
			w := NewWithAPI(Config{Operator: "self", RunnerID: "r-placement"}, api)
			w.sandbox = &covRunSandbox{}

			stdout := NewJobLogger(api, "covrun-placement", "STDOUT")
			stderr := NewJobLogger(api, "covrun-placement", "STDERR")
			err := w.executeDeploy(t.Context(),
				&Job{ID: "covrun-placement", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunDeploySnapshot("namespace")},
				"hetzner", nil, nil, stdout, stderr)
			stdout.Close()
			stderr.Close()
			if err != nil {
				t.Fatalf("a placement deploy must succeed: %v", err)
			}
			// A placement runs no tofu, so nothing is written back.
			api.mu.Lock()
			puts := len(api.talosPuts)
			api.mu.Unlock()
			if puts != 0 {
				t.Errorf("a placement must not write back a talosconfig, got %d puts", puts)
			}
		})
	}
}

// TestRun_ExecuteDeploy_FlagsOrphanRiskOnMidApplyTeardown proves a cancel that lands at/after the
// state-mutating apply phase marks orphan risk and still posts the partial GitOps metadata.
func TestRun_ExecuteDeploy_FlagsOrphanRiskOnMidApplyTeardown(t *testing.T) {
	api := newCovRunAPI()
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		if err := os.WriteFile(deployPhaseFile(spec.WorkDir), []byte("apply\n"), 0o600); err != nil {
			return err
		}
		covRunWriteResult(t, spec.WorkDir, `{"GitopsStatus":{"mode":"gitops"}}`)
		return errors.New("torn down mid-apply")
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-teardown"}, api)
	w.sandbox = sb
	w.cancels.cancel("covrun-teardown")

	stdout := NewJobLogger(api, "covrun-teardown", "STDOUT")
	stderr := NewJobLogger(api, "covrun-teardown", "STDERR")
	err := w.executeDeploy(t.Context(),
		&Job{ID: "covrun-teardown", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
		"aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err == nil {
		t.Fatal("a torn-down apply must surface its error")
	}
	if !w.cancels.orphanRisk("covrun-teardown") {
		t.Error("an interruption at the apply phase must mark orphan risk")
	}

	var sawGitops bool
	for _, u := range api.getStatusUpdates() {
		if u.status == "PROCESSING" && u.metadata != nil {
			if _, ok := u.metadata["gitops_status"]; ok {
				sawGitops = true
			}
		}
	}
	if !sawGitops {
		t.Error("a partial result must still post gitops_status so the console can show why wiring failed")
	}
}

// TestRun_ExecuteDeploy_WarnsWhenTalosWriteBackFails covers the best-effort write-back arms: an
// unreadable stage result, a result with no talosconfig output, and a failing console post.
func TestRun_ExecuteDeploy_WarnsWhenTalosWriteBackFails(t *testing.T) {
	t.Run("no stage result at all", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-noresult"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "covrun-noresult", "STDOUT")
		stderr := NewJobLogger(api, "covrun-noresult", "STDERR")
		err := w.executeDeploy(t.Context(),
			&Job{ID: "covrun-noresult", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
			"hetzner", nil, nil, stdout, stderr)
		stdout.Close()
		stderr.Close()
		if err != nil {
			t.Fatalf("a missing result.json must not fail the deploy: %v", err)
		}
	})

	t.Run("result without a talosconfig output", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-notalos"}, api)
		w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
			covRunWriteResult(t, spec.WorkDir, `{"ClusterName":"c","Outputs":{"vpc_id":"v"}}`)
			return nil
		}}
		stdout := NewJobLogger(api, "covrun-notalos", "STDOUT")
		stderr := NewJobLogger(api, "covrun-notalos", "STDERR")
		if err := w.executeDeploy(t.Context(),
			&Job{ID: "covrun-notalos", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
			"hetzner", nil, nil, stdout, stderr); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		stdout.Close()
		stderr.Close()
		api.mu.Lock()
		puts := len(api.talosPuts)
		api.mu.Unlock()
		if puts != 0 {
			t.Errorf("no talosconfig output ⇒ no write-back, got %d puts", puts)
		}
	})

	t.Run("console rejects the write-back", func(t *testing.T) {
		api := newCovRunAPI()
		api.talosPutErr = errors.New("console rejected it")
		w := NewWithAPI(Config{Operator: "self", RunnerID: "r-putfail"}, api)
		w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
			covRunWriteResult(t, spec.WorkDir, `{"Outputs":{"talosconfig":"BARE-STRING-TALOS"}}`)
			return nil
		}}
		stdout := NewJobLogger(api, "covrun-putfail", "STDOUT")
		stderr := NewJobLogger(api, "covrun-putfail", "STDERR")
		if err := w.executeDeploy(t.Context(),
			&Job{ID: "covrun-putfail", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
			"hetzner", nil, nil, stdout, stderr); err != nil {
			t.Fatalf("a failed write-back must not fail the deploy: %v", err)
		}
		stdout.Close()
		stderr.Close()
		api.mu.Lock()
		puts := append([]string(nil), api.talosPuts...)
		api.mu.Unlock()
		if len(puts) != 1 || puts[0] != "BARE-STRING-TALOS" {
			t.Errorf("a bare-string talosconfig output must still be persisted, got %v", puts)
		}
	})
}

// TestRun_ExecuteDeploy_RejectsBeforeAnyWork covers the deploy spine's fail-closed guards and
// warning arms: an unmodelled snapshot key, the E0 BYO-IaC boundary, an unfetchable plan job, a
// refused state-token mint and an uncreatable workdir.
func TestRun_ExecuteDeploy_RejectsBeforeAnyWork(t *testing.T) {
	t.Run("unknown snapshot key", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDeploy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunBadSnapshot()}, "", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "config snapshot") {
			t.Fatalf("expected a snapshot parse failure, got %v", err)
		}
	})

	t.Run("byo iac on a managed runner", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed"}, api)
		w.sandbox = &covRunSandbox{}
		snap := covRunSnapshot()
		snap["iac_source"] = map[string]any{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDeploy(t.Context(), &Job{ID: "j", ConfigSnapshot: snap}, "", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "egress-enforced container sandbox") {
			t.Fatalf("expected the E0 boundary refusal, got %v", err)
		}
	})

	t.Run("plan job cannot be fetched", func(t *testing.T) {
		api := newCovRunAPI()
		api.getJobFn = func(string) (*Job, error) { return nil, errors.New("plan job gone") }
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		planJobID := "covrun-missing-plan"
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		err := w.executeDeploy(t.Context(),
			&Job{ID: "j", ConfigSnapshot: covRunSnapshot(), PlanJobID: &planJobID}, "aws", nil, nil, stdout, stderr)
		stdout.Close()
		stderr.Close()
		if err != nil {
			t.Fatalf("an unfetchable plan job must only warn, got %v", err)
		}
		var warned bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "could not fetch plan job") {
				warned = true
			}
		}
		if !warned {
			t.Error("expected a warning about the unfetchable plan job")
		}
	})

	t.Run("state token mint refused", func(t *testing.T) {
		api := newCovRunAPI()
		api.stateTokenErr = errors.New("mint refused")
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executeDeploy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr); err == nil {
			t.Fatal("a refused state-token mint must fail the deploy")
		}
	})

	t.Run("workdir cannot be created", func(t *testing.T) {
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "covrun-absent"))
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDeploy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "create workdir") {
			t.Fatalf("expected a workdir failure, got %v", err)
		}
	})
}

// TestRun_ExecuteDeploy_EnforcesPlanApprovalContract proves the pre-approved-plan gate: a deploy
// whose plan job did not SUCCEED, or whose configuration changed since that plan was generated,
// is refused before any state-mutating work.
func TestRun_ExecuteDeploy_EnforcesPlanApprovalContract(t *testing.T) {
	planJobID := "covrun-plan-ref"
	planHash := "hash-at-plan-time"
	currentHash := "hash-now"

	t.Run("plan job did not succeed", func(t *testing.T) {
		api := newCovRunAPI()
		api.getJobFn = func(id string) (*Job, error) {
			return &Job{ID: id, Status: "FAILED", ConfigurationHash: &planHash}, nil
		}
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDeploy(t.Context(),
			&Job{ID: "j", ConfigSnapshot: covRunSnapshot(), PlanJobID: &planJobID, ConfigurationHash: &planHash},
			"aws", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "expected SUCCESS") {
			t.Fatalf("expected the plan-status refusal, got %v", err)
		}
	})

	t.Run("configuration changed since the plan", func(t *testing.T) {
		api := newCovRunAPI()
		api.getJobFn = func(id string) (*Job, error) {
			return &Job{ID: id, Status: "SUCCESS", ConfigurationHash: &planHash}, nil
		}
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDeploy(t.Context(),
			&Job{ID: "j", ConfigSnapshot: covRunSnapshot(), PlanJobID: &planJobID, ConfigurationHash: &currentHash},
			"aws", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "configuration changed since plan") {
			t.Fatalf("expected the hash-drift refusal, got %v", err)
		}
	})
}

// TestRun_ExecuteDeploy_WarnsOnCredentialFetchFailures proves the fail-SAFE direction of the two
// best-effort job-channel fetches: an unavailable git token or add-on secret warns on the job's
// error stream and the deploy proceeds (the affected chart surfaces its own missing Secret)
// rather than killing a whole deploy over one add-on.
func TestRun_ExecuteDeploy_WarnsOnCredentialFetchFailures(t *testing.T) {
	api := newCovRunAPI()
	api.gitTokenFn = func(string, string) (string, error) { return "", errors.New("no git credential") }
	api.addonSecretFn = func(string) (map[string]map[string]string, error) {
		return nil, errors.New("secret store unavailable")
	}
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.sandbox = &covRunSandbox{}

	stdout := NewJobLogger(api, "covrun-warn", "STDOUT")
	stderr := NewJobLogger(api, "covrun-warn", "STDERR")
	if err := w.executeDeploy(t.Context(),
		&Job{ID: "covrun-warn", ConfigSnapshot: covRunDeploySnapshot("")}, "aws", nil, nil, stdout, stderr); err != nil {
		t.Fatalf("a failed credential fetch must not fail the deploy: %v", err)
	}
	stdout.Close()
	stderr.Close()

	var sawGit, sawAddon bool
	for _, c := range api.getLogChunks() {
		// The apps-repo warning has no repo in it; the per-repo BYO ones read "… token for <url>".
		if strings.Contains(c.chunk, "failed to fetch git token: ") {
			sawGit = true
		}
		if strings.Contains(c.chunk, "failed to fetch add-on secrets") {
			sawAddon = true
		}
	}
	if !sawGit {
		t.Error("expected a warning for the apps-repo git token")
	}
	if !sawAddon {
		t.Error("expected a warning for the add-on secrets fetch")
	}
}

// TestRun_ExecuteDeploy_DefaultsProviderAndAccount proves the provider/account fallbacks: an empty
// provider falls back to the snapshot's, then to aws; and with no CloudIdentity the account id is
// read from the ambient SDK env vars a self-registered runner already uses.
func TestRun_ExecuteDeploy_DefaultsProviderAndAccount(t *testing.T) {
	t.Setenv("AWS_ACCOUNT_ID", "111122223333")
	api := newCovRunAPI()
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-default", "STDOUT")
	stderr := NewJobLogger(api, "covrun-default", "STDERR")
	if err := w.executeDeploy(t.Context(),
		&Job{ID: "covrun-default", ConfigSnapshot: covRunSnapshot()}, "", nil, nil, stdout, stderr); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	stdout.Close()
	stderr.Close()

	if got := sb.lastSpec().Provider; got != "aws" {
		t.Errorf("an unset provider must default to aws, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

// TestRun_ExecutePlan_PostsPlanCostAndArtifact drives the PLAN spine end to end: the plan JSON's
// resource changes, the cost breakdown and summary, the verification/compat reports, and the
// uploaded plan artifact whose storage key the deploy job later re-downloads.
func TestRun_ExecutePlan_PostsPlanCostAndArtifact(t *testing.T) {
	t.Setenv("INFRACOST_API_KEY", "covrun-infracost")
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.invalid"}, api)
	w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		covRunWriteResult(t, spec.WorkDir, covRunFullPlanResult)
		return nil
	}}

	stdout := NewJobLogger(api, "covrun-plan", "STDOUT")
	stderr := NewJobLogger(api, "covrun-plan", "STDERR")
	if err := w.executePlan(t.Context(),
		&Job{ID: "covrun-plan", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot()},
		"aws", &CloudIdentity{Provider: "gcp", ProjectID: "covrun-proj"}, nil, stdout, stderr); err != nil {
		t.Fatalf("plan must succeed: %v", err)
	}
	stdout.Close()
	stderr.Close()

	api.mu.Lock()
	uploads := api.uploadCalls
	api.mu.Unlock()
	if uploads != 1 {
		t.Errorf("expected exactly one plan-artifact upload, got %d", uploads)
	}

	var meta map[string]any
	for _, u := range api.getStatusUpdates() {
		if u.jobID == "covrun-plan" && u.status == "PROCESSING" && u.metadata["plan_completed"] == true {
			meta = u.metadata
		}
	}
	if meta == nil {
		t.Fatal("expected the plan metadata post")
	}
	for _, k := range []string{"plan_result", "cost_breakdown", "cost_summary", "verify_result", "verify_receipt", "compat_result", "plan_file_key"} {
		if _, ok := meta[k]; !ok {
			t.Errorf("plan metadata is missing %q: %v", k, meta)
		}
	}
	if meta["plan_file_key"] != "covrun-plan/tofu.plan.out" {
		t.Errorf("plan_file_key = %v, want covrun-plan/tofu.plan.out", meta["plan_file_key"])
	}
}

// TestRun_ExecutePlan_HandlesDegradedResults covers the honest-degradation arms: a plan JSON with
// no resource_changes key, a nil plan JSON (tofu show failed), an unreadable stage result and a
// failed artifact upload — none of which may fail the plan job.
func TestRun_ExecutePlan_HandlesDegradedResults(t *testing.T) {
	cases := []struct {
		name       string
		result     string // "" ⇒ write no result.json at all
		uploadErr  error
		wantKeys   []string
		absentKeys []string
	}{
		{
			name:       "plan json without resource_changes",
			result:     `{"PlanJSON":{"format_version":"1.0"}}`,
			wantKeys:   []string{"plan_result"},
			absentKeys: []string{"cost_breakdown", "plan_file_key"},
		},
		{
			name:       "nil plan json",
			result:     `{"ClusterName":"c"}`,
			absentKeys: []string{"plan_result"},
		},
		{
			name:       "no stage result",
			absentKeys: []string{"plan_result"},
		},
		{
			name:       "artifact upload fails",
			result:     `{"PlanFileBytes":"cGxhbmJ5dGVz"}`,
			uploadErr:  errors.New("storage refused"),
			absentKeys: []string{"plan_file_key"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := newCovRunAPI()
			api.uploadErr = tc.uploadErr
			w := NewWithAPI(Config{Operator: "self"}, api)
			result := tc.result
			w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
				if result != "" {
					covRunWriteResult(t, spec.WorkDir, result)
				}
				return nil
			}}

			stdout := NewJobLogger(api, "covrun-degraded", "STDOUT")
			stderr := NewJobLogger(api, "covrun-degraded", "STDERR")
			if err := w.executePlan(t.Context(),
				&Job{ID: "covrun-degraded", ConfigSnapshot: covRunSnapshot()},
				"", nil, nil, stdout, stderr); err != nil {
				t.Fatalf("a degraded result must not fail the plan: %v", err)
			}
			stdout.Close()
			stderr.Close()

			var meta map[string]any
			for _, u := range api.getStatusUpdates() {
				if u.status == "PROCESSING" && u.metadata["plan_completed"] == true {
					meta = u.metadata
				}
			}
			if meta == nil {
				t.Fatal("expected the plan metadata post")
			}
			for _, k := range tc.wantKeys {
				if _, ok := meta[k]; !ok {
					t.Errorf("expected %q in the plan metadata, got %v", k, meta)
				}
			}
			for _, k := range tc.absentKeys {
				if _, ok := meta[k]; ok {
					t.Errorf("did not expect %q in the plan metadata, got %v", k, meta)
				}
			}
		})
	}
}

// TestRun_ExecutePlan_RejectsBeforeAnyWork covers the plan spine's guards: an unmodelled snapshot
// key, the E0 BYO-IaC boundary, a git-token warning, a refused state-token mint, an uncreatable
// workdir and a failing stage.
func TestRun_ExecutePlan_RejectsBeforeAnyWork(t *testing.T) {
	t.Run("unknown snapshot key", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executePlan(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunBadSnapshot()}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("expected a snapshot parse failure")
		}
	})

	t.Run("byo iac on a managed runner", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed"}, api)
		w.sandbox = &covRunSandbox{}
		snap := covRunSnapshot()
		snap["iac_source"] = map[string]any{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executePlan(t.Context(), &Job{ID: "j", ConfigSnapshot: snap}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("expected the E0 boundary refusal")
		}
	})

	t.Run("git token fetch warns", func(t *testing.T) {
		api := newCovRunAPI()
		api.gitTokenFn = func(string, string) (string, error) { return "", errors.New("no token") }
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "covrun-gitwarn", "STDOUT")
		stderr := NewJobLogger(api, "covrun-gitwarn", "STDERR")
		if err := w.executePlan(t.Context(), &Job{ID: "covrun-gitwarn", ConfigSnapshot: covRunSnapshot()}, "", nil, nil, stdout, stderr); err != nil {
			t.Fatalf("a missing git token must only warn: %v", err)
		}
		stdout.Close()
		stderr.Close()
		var warned bool
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "failed to fetch git token") {
				warned = true
			}
		}
		if !warned {
			t.Error("expected a git-token warning")
		}
	})

	t.Run("state token mint refused", func(t *testing.T) {
		api := newCovRunAPI()
		api.stateTokenErr = errors.New("mint refused")
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executePlan(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("a refused state-token mint must fail the plan")
		}
	})

	t.Run("workdir cannot be created", func(t *testing.T) {
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "covrun-absent"))
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executePlan(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "create workdir") {
			t.Fatalf("expected a workdir failure, got %v", err)
		}
	})

	t.Run("stage fails", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{onRun: func(sandbox.Spec) error { return errors.New("tofu plan failed") }}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executePlan(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("a failed plan stage must surface")
		}
	})
}

// ---------------------------------------------------------------------------
// executeDestroy
// ---------------------------------------------------------------------------

// TestRun_ExecuteDestroy_PurgesStateAfterTeardown proves the destroy spine runs the teardown
// through the isolation seam and then best-effort purges the now-empty tofu state object.
func TestRun_ExecuteDestroy_PurgesStateAfterTeardown(t *testing.T) {
	api := newCovRunAPI()
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.invalid"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-destroy", "STDOUT")
	stderr := NewJobLogger(api, "covrun-destroy", "STDERR")
	if err := w.executeDestroy(t.Context(),
		&Job{ID: "covrun-destroy", JobType: string(types.JobTypeDestroy), ConfigSnapshot: covRunSnapshot()},
		"", &CloudIdentity{Provider: "azure", SubscriptionID: "sub-1"}, nil, stdout, stderr); err != nil {
		t.Fatalf("destroy must succeed: %v", err)
	}
	stdout.Close()
	stderr.Close()

	if spec := sb.lastSpec(); spec.Kind != "destroy" || spec.Stage == nil {
		t.Errorf("the sandbox must receive a serialized destroy stage, got %+v", spec)
	}
	api.mu.Lock()
	purges := api.purgeCalls
	api.mu.Unlock()
	if purges != 1 {
		t.Errorf("expected exactly one state purge, got %d", purges)
	}
}

// TestRun_ExecuteDestroy_WarnsWhenStatePurgeFails proves a failed purge is a warning, not a failed
// teardown — the infrastructure is already gone.
func TestRun_ExecuteDestroy_WarnsWhenStatePurgeFails(t *testing.T) {
	api := newCovRunAPI()
	api.purgeErr = errors.New("storage refused")
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.sandbox = &covRunSandbox{}

	stdout := NewJobLogger(api, "covrun-purgefail", "STDOUT")
	stderr := NewJobLogger(api, "covrun-purgefail", "STDERR")
	if err := w.executeDestroy(t.Context(),
		&Job{ID: "covrun-purgefail", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr); err != nil {
		t.Fatalf("a failed purge must not fail the destroy: %v", err)
	}
	stdout.Close()
	stderr.Close()

	var warned bool
	for _, c := range api.getLogChunks() {
		if strings.Contains(c.chunk, "failed to purge tofu state") {
			warned = true
		}
	}
	if !warned {
		t.Error("expected a state-purge warning")
	}
}

// TestRun_ExecuteDestroy_RejectsBeforeAnyWork covers the destroy spine's guards: an unmodelled
// snapshot key, the E0 BYO-IaC boundary, a refused state-token mint, an uncreatable workdir and a
// failing stage.
func TestRun_ExecuteDestroy_RejectsBeforeAnyWork(t *testing.T) {
	t.Run("unknown snapshot key", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executeDestroy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunBadSnapshot()}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("expected a snapshot parse failure")
		}
	})

	t.Run("byo iac on a managed runner", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "managed"}, api)
		w.sandbox = &covRunSandbox{}
		snap := covRunSnapshot()
		snap["iac_source"] = map[string]any{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executeDestroy(t.Context(), &Job{ID: "j", ConfigSnapshot: snap}, "", nil, nil, stdout, stderr); err == nil {
			t.Fatal("expected the E0 boundary refusal")
		}
	})

	t.Run("state token mint refused", func(t *testing.T) {
		api := newCovRunAPI()
		api.stateTokenErr = errors.New("mint refused")
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executeDestroy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr); err == nil {
			t.Fatal("a refused state-token mint must fail the destroy")
		}
	})

	t.Run("workdir cannot be created", func(t *testing.T) {
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "covrun-absent"))
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		err := w.executeDestroy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr)
		if err == nil || !strings.Contains(err.Error(), "create workdir") {
			t.Fatalf("expected a workdir failure, got %v", err)
		}
	})

	t.Run("stage fails", func(t *testing.T) {
		api := newCovRunAPI()
		w := NewWithAPI(Config{Operator: "self"}, api)
		w.sandbox = &covRunSandbox{onRun: func(sandbox.Spec) error { return errors.New("tofu destroy failed") }}
		stdout := NewJobLogger(api, "j", "STDOUT")
		stderr := NewJobLogger(api, "j", "STDERR")
		defer stdout.Close()
		defer stderr.Close()
		if err := w.executeDestroy(t.Context(), &Job{ID: "j", ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr); err == nil {
			t.Fatal("a failed destroy stage must surface")
		}
		api.mu.Lock()
		purges := api.purgeCalls
		api.mu.Unlock()
		if purges != 0 {
			t.Error("a failed teardown must NOT purge the state object")
		}
	})
}

// ---------------------------------------------------------------------------
// Snapshot decoding + small helpers
// ---------------------------------------------------------------------------

// TestRun_SnapshotToProjectConfig_SurfacesEncodingFailures covers the decode's non-allowlist error
// arms: a value that cannot be marshalled at the strict-check stage, one hidden under a DB-row
// spread key (so it reaches the second marshal), and a type mismatch the strict check passes
// through to the real decode.
func TestRun_SnapshotToProjectConfig_SurfacesEncodingFailures(t *testing.T) {
	t.Run("unmarshallable value at the strict check", func(t *testing.T) {
		_, err := snapshotToProjectConfig(map[string]any{"project_name": make(chan int)})
		if err == nil {
			t.Fatal("expected a marshal failure")
		}
	})

	t.Run("unmarshallable value under a db-row spread key", func(t *testing.T) {
		// `databases` is stripped before the strict check, so the failure surfaces at the
		// second marshal inside snapshotToProjectConfig.
		_, err := snapshotToProjectConfig(map[string]any{"databases": make(chan int)})
		if err == nil {
			t.Fatal("expected a marshal failure")
		}
	})

	t.Run("type mismatch", func(t *testing.T) {
		_, err := snapshotToProjectConfig(map[string]any{"project_name": 42})
		if err == nil {
			t.Fatal("expected a decode failure for a non-string project_name")
		}
	})
}

// TestRun_AssertNoUnknownSnapshotKeys_IgnoresNonObjectAllowlistPath proves the nested-allowlist
// walk skips a path whose value is not an object rather than failing on it.
func TestRun_AssertNoUnknownSnapshotKeys_IgnoresNonObjectAllowlistPath(t *testing.T) {
	if err := assertNoUnknownSnapshotKeys(map[string]any{"project_name": "p", "cluster": "not-an-object"}); err != nil {
		t.Fatalf("a non-object at an allowlisted path must not fail the unknown-key check: %v", err)
	}
}

// TestRun_ToCoreConnectorCreds_ConvertsClaimCredentials covers the claim → core credential
// conversion, including the empty short-circuit.
func TestRun_ToCoreConnectorCreds_ConvertsClaimCredentials(t *testing.T) {
	if got := toCoreConnectorCreds(nil); got != nil {
		t.Errorf("no credentials must convert to nil, got %v", got)
	}
	got := toCoreConnectorCreds([]ConnectorCredential{
		{Category: "dns", Slug: "cloudflare", Credentials: map[string]string{"api_key": "k"}},
	})
	if len(got) != 1 || got[0].Slug != "cloudflare" || got[0].Credentials["api_key"] != "k" {
		t.Errorf("connector credentials did not survive the conversion: %+v", got)
	}
}

// TestRun_IsTalosPlacementMode_OnlyPlacementsMint proves only the modes that run NO tofu on a
// shared Fabric mint kube access from the persisted talosconfig.
func TestRun_IsTalosPlacementMode_OnlyPlacementsMint(t *testing.T) {
	for mode, want := range map[types.PlacementMode]bool{
		types.PlacementModeNamespace: true,
		types.PlacementModeVcluster:  true,
		types.PlacementModeDedicated: false,
		types.PlacementMode(""):      false,
	} {
		if got := isTalosPlacementMode(mode); got != want {
			t.Errorf("isTalosPlacementMode(%q) = %v, want %v", mode, got, want)
		}
	}
}

// TestRun_SleepCtx_ReturnsEarlyOnCancel proves the backoff sleep is context-aware, so a shutdown
// is not delayed by a pending reconnect wait.
func TestRun_SleepCtx_ReturnsEarlyOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { sleepCtx(ctx, time.Hour); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("sleepCtx did not return on a cancelled context")
	}
	sleepCtx(context.Background(), time.Millisecond)
}
