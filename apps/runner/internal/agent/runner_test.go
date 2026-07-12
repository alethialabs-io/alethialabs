// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mockAPI struct {
	mu               sync.Mutex
	statusUpdates    []statusUpdate
	logChunks        []logEntry
	heartbeatCount   int
	heartbeatCancels []string // ids the mock heartbeat reports as server-side-cancelled
	claimResponse    *ClaimResponse
	claimErr         error
	claimCount       int
	jobs             map[string]*Job
	wakeEvents       []WakeEvent // extra events StreamWake replays after the initial wake
}

type statusUpdate struct {
	jobID    string
	status   string
	errMsg   string
	metadata map[string]any
}

type logEntry struct {
	jobID       string
	chunk       string
	streamType  string
	traceparent string
}

func (m *mockAPI) ClaimJob() (*ClaimResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.claimErr != nil {
		return nil, m.claimErr
	}
	m.claimCount++
	if m.claimCount == 1 {
		return m.claimResponse, nil
	}
	return &ClaimResponse{Job: nil}, nil // queue drained after the first claim
}

// StreamWake fires one wake immediately (simulating an enqueue), then replays any
// pre-seeded events (e.g. a cancel), then holds until the context is cancelled.
func (m *mockAPI) StreamWake(ctx context.Context, onEvent func(WakeEvent)) error {
	onEvent(WakeEvent{Type: "wake"})
	m.mu.Lock()
	events := append([]WakeEvent(nil), m.wakeEvents...)
	m.mu.Unlock()
	for _, ev := range events {
		onEvent(ev)
	}
	<-ctx.Done()
	return ctx.Err()
}

func (m *mockAPI) UpdateJobStatus(jobID, status, errMsg string, metadata map[string]any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.statusUpdates = append(m.statusUpdates, statusUpdate{jobID, status, errMsg, metadata})
	return nil
}

func (m *mockAPI) SendLog(jobID, chunk, streamType, traceparent string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logChunks = append(m.logChunks, logEntry{jobID, chunk, streamType, traceparent})
	return nil
}

func (m *mockAPI) Heartbeat() ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.heartbeatCount++
	return m.heartbeatCancels, nil
}

func (m *mockAPI) GetJob(jobID string) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.jobs != nil {
		if j, ok := m.jobs[jobID]; ok {
			return j, nil
		}
	}
	return nil, fmt.Errorf("job not found: %s", jobID)
}

func (m *mockAPI) FetchGitToken(jobID string) (string, error) {
	return "", nil
}

func (m *mockAPI) FetchStateToken(jobID string) (string, error) {
	return "test-state-token", nil
}

func (m *mockAPI) PurgeProjectState(jobID, stateToken string) error {
	return nil
}

func (m *mockAPI) FetchAzureToken(jobID string) (string, error) {
	return "test-azure-token", nil
}

func (m *mockAPI) FetchAwsToken(jobID string) (*AwsFederation, error) {
	return &AwsFederation{
		Token:  "test-aws-token",
		Region: "eu-central-1",
	}, nil
}

func (m *mockAPI) FetchAlibabaToken(jobID string) (string, error) {
	return "test-alibaba-token", nil
}

func (m *mockAPI) FetchGcpToken(jobID string) (string, error) {
	return "test-gcp-token", nil
}

func (m *mockAPI) UploadPlanArtifact(jobID, filePath string) error {
	return nil
}

func (m *mockAPI) DownloadPlanArtifact(jobID, destPath string) error {
	return fmt.Errorf("not implemented in mock")
}

func (m *mockAPI) UpdateRunnerMetadata(runnerID string, metadata map[string]any) error {
	return nil
}

func (m *mockAPI) DeleteRunner(runnerID string) error {
	return nil
}

func (m *mockAPI) getStatusUpdates() []statusUpdate {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]statusUpdate, len(m.statusUpdates))
	copy(result, m.statusUpdates)
	return result
}

func (m *mockAPI) getLogChunks() []logEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]logEntry, len(m.logChunks))
	copy(result, m.logChunks)
	return result
}

// TestApplyHeartbeatCancels proves the fallback cancel delivery: when the heartbeat reports a
// server-side-cancelled job that this runner is still running (the wake-stream cancel was missed),
// applyHeartbeatCancels tears it down; ids it isn't running are ignored.
func TestApplyHeartbeatCancels(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.cancels.register("hb-job", cancel)

	w.applyHeartbeatCancels([]string{"hb-job", "not-running-here"})

	select {
	case <-ctx.Done():
	default:
		t.Fatal("a heartbeat-reported running job should be cancelled via the fallback")
	}
	if !w.cancels.wasCancelled("hb-job") {
		t.Error("hb-job should be marked cancelled")
	}
	if w.cancels.wasCancelled("not-running-here") {
		t.Error("a job not running here must not be marked cancelled by the heartbeat fallback")
	}
}

func TestSnapshotToProjectConfig(t *testing.T) {
	tests := []struct {
		name       string
		snapshot   map[string]any
		wantName   string
		wantRegion string
	}{
		{
			name: "new format with region",
			snapshot: map[string]any{
				"project_name":      "myproject",
				"region":            "eu-west-1",
				"environment_stage": "dev",
				"create_vpc":        true,
				"vpc_cidr":          "10.0.0.0/16",
			},
			wantName:   "myproject",
			wantRegion: "eu-west-1",
		},
		{
			name: "with databases",
			snapshot: map[string]any{
				"project_name":      "dbproject",
				"region":            "eu-central-1",
				"environment_stage": "staging",
				"databases": []any{
					map[string]any{"name": "main", "engine": "aurora-postgresql"},
				},
			},
			wantName:   "dbproject",
			wantRegion: "eu-central-1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vc, err := snapshotToProjectConfig(tt.snapshot)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if vc.ProjectName != tt.wantName {
				t.Errorf("ProjectName = %q, want %q", vc.ProjectName, tt.wantName)
			}
			if vc.Region != tt.wantRegion {
				t.Errorf("Region = %q, want %q", vc.Region, tt.wantRegion)
			}
		})
	}
}

func TestGetSnapshotString(t *testing.T) {
	snapshot := map[string]any{
		"region": "eu-west-1",
		"count":  42,
	}

	if got := getSnapshotString(snapshot, "region"); got != "eu-west-1" {
		t.Errorf("expected eu-west-1, got %s", got)
	}
	if got := getSnapshotString(snapshot, "missing"); got != "" {
		t.Errorf("expected empty string, got %s", got)
	}
	if got := getSnapshotString(snapshot, "count"); got != "" {
		t.Errorf("expected empty for non-string, got %s", got)
	}
}

func TestExecuteJob_SetsProcessingFirst(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{
			ID:             "job-test",
			JobType:        "BOGUS_TYPE",
			ConfigSnapshot: map[string]any{},
		},
	}

	_ = w.executeJob(t.Context(), claim)

	updates := api.getStatusUpdates()
	if len(updates) == 0 {
		t.Fatal("expected at least one status update")
	}
	if updates[0].status != "PROCESSING" {
		t.Errorf("first status should be PROCESSING, got %s", updates[0].status)
	}
}

// TestExecuteJob_EmitsClaimBannerFirst asserts the user sees activity immediately:
// the "Job claimed" banner is the first STDOUT line, emitted before credential setup
// and any provisioning work.
func TestExecuteJob_EmitsClaimBannerFirst(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{
			ID:             "job-banner",
			JobType:        "BOGUS_TYPE",
			ConfigSnapshot: map[string]any{},
		},
	}

	// Deferred logger.Close() inside executeJob flushes remaining buffered output.
	_ = w.executeJob(t.Context(), claim)

	var firstStdout string
	for _, c := range api.getLogChunks() {
		if c.streamType == "STDOUT" {
			firstStdout = c.chunk
			break
		}
	}
	if firstStdout == "" {
		t.Fatal("expected at least one STDOUT log chunk")
	}
	if !strings.Contains(firstStdout, "Job claimed") {
		t.Errorf("expected first STDOUT chunk to be the claim banner, got %q", firstStdout)
	}
}

func TestExecuteJob_UnknownType(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{
			ID:             "job-unknown",
			JobType:        "BOGUS_TYPE",
			ConfigSnapshot: map[string]any{},
		},
	}

	err := w.executeJob(t.Context(), claim)
	if err == nil {
		t.Fatal("expected error for unknown job type")
	}

	updates := api.getStatusUpdates()
	found := false
	for _, u := range updates {
		if u.status == "FAILED" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected FAILED status update for unknown job type")
	}
}

// TestExecuteJob_CarriesClaimTraceparent asserts the traceparent minted at enqueue and
// returned in the claim response is threaded onto the job's shipped log chunks — the
// enqueue → claim → runner correlation hop.
func TestExecuteJob_CarriesClaimTraceparent(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-1"}, api)

	tp := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	claim := &ClaimResponse{
		Job: &Job{
			ID:             "job-trace",
			JobType:        "BOGUS_TYPE",
			ConfigSnapshot: map[string]any{},
			Traceparent:    tp,
		},
	}

	_ = w.executeJob(t.Context(), claim)

	chunks := api.getLogChunks()
	if len(chunks) == 0 {
		t.Fatal("expected shipped log chunks")
	}
	for _, c := range chunks {
		if c.traceparent != tp {
			t.Errorf("log chunk (stream %s) traceparent = %q, want %q", c.streamType, c.traceparent, tp)
		}
	}
}

// TestClaimLoop_DrainsOnWake proves push dispatch: a wake event drives claimLoop to
// claim and execute a queued job (no 10s poll wait). Uses an unknown job type so
// executeJob fails fast and records a FAILED status we can assert on.
func TestClaimLoop_DrainsOnWake(t *testing.T) {
	api := &mockAPI{
		claimResponse: &ClaimResponse{
			Job: &Job{ID: "wake-job", JobType: "BOGUS_TYPE", ConfigSnapshot: map[string]any{}},
		},
	}
	w := NewWithAPI(Config{Operator: "self"}, api)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var draining atomic.Bool
	done := make(chan error, 1)
	go func() { done <- w.claimLoop(ctx, &draining) }()

	deadline := time.After(2 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("job was not claimed + executed within 2s of wake")
		default:
		}
		claimed := false
		for _, u := range api.getStatusUpdates() {
			if u.jobID == "wake-job" && u.status == "FAILED" {
				claimed = true
			}
		}
		if claimed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	<-done
}

// TestExecuteJob_CancelledPostsCancelled proves a job cancelled via the registry posts
// CANCELLED (not FAILED) when its execution surfaces an error.
func TestExecuteJob_CancelledPostsCancelled(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	// Mark the job cancelled (as a cancel event would), then run it. The unknown job type
	// makes executeJob error; the cancelled branch must convert that to CANCELLED.
	w.cancels.cancel("job-cancel")

	claim := &ClaimResponse{
		Job: &Job{ID: "job-cancel", JobType: "BOGUS_TYPE", ConfigSnapshot: map[string]any{}},
	}
	_ = w.executeJob(t.Context(), claim)

	var terminal string
	var meta map[string]any
	for _, u := range api.getStatusUpdates() {
		if u.status == "CANCELLED" || u.status == "FAILED" {
			terminal = u.status
			meta = u.metadata
		}
	}
	if terminal != "CANCELLED" {
		t.Fatalf("expected CANCELLED terminal status, got %q", terminal)
	}
	// No apply ran (unknown type), so no orphan risk was flagged.
	if meta != nil && meta["orphan_risk"] == true {
		t.Error("did not expect orphan_risk without a mid-apply cancel")
	}
}

// TestExecuteJob_FailedWithOrphanRiskFlags proves a NON-cancel mid-apply interruption (the 2h
// jobCtx deadline, a shutdown-drain SIGKILL, or a crash-recovery) whose orphan risk was marked
// posts FAILED (not CANCELLED) carrying orphan_risk=true. The job is NOT cancelled here
// (wasCancelled=false), so it takes the FAILED branch — mirroring a runner torn down mid-apply
// by something other than an explicit user cancel. Without the fix the FAILED branch posts nil
// metadata, silently dropping the orphan signal.
func TestExecuteJob_FailedWithOrphanRiskFlags(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)
	// Interrupted mid-apply by a non-cancel cause: only the orphan-risk marker is set (the
	// deploy path sets it whenever ctx.Err()!=nil at/after the apply phase — see executeDeploy).
	w.cancels.markOrphanRisk("job-fail-orphan")

	claim := &ClaimResponse{
		Job: &Job{ID: "job-fail-orphan", JobType: "BOGUS_TYPE", ConfigSnapshot: map[string]any{}},
	}
	_ = w.executeJob(t.Context(), claim)

	var found bool
	for _, u := range api.getStatusUpdates() {
		if u.status == "FAILED" {
			found = true
			if u.metadata == nil || u.metadata["orphan_risk"] != true {
				t.Errorf("expected orphan_risk=true in FAILED metadata, got %v", u.metadata)
			}
			if u.metadata != nil {
				if _, ok := u.metadata["orphan_risk_reason"].(string); !ok {
					t.Errorf("expected orphan_risk_reason string in FAILED metadata, got %v", u.metadata["orphan_risk_reason"])
				}
			}
		}
	}
	if !found {
		t.Fatal("expected a FAILED status update")
	}
}

// TestExecuteJob_FailedWithoutOrphanRiskNilMeta proves the regression guard: a plain FAILED
// (no orphan risk marked — e.g. a normal tofu apply error that never cancelled the context)
// carries NO orphan_risk, so it does not over-alert.
func TestExecuteJob_FailedWithoutOrphanRiskNilMeta(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{ID: "job-fail-clean", JobType: "BOGUS_TYPE", ConfigSnapshot: map[string]any{}},
	}
	_ = w.executeJob(t.Context(), claim)

	var found bool
	for _, u := range api.getStatusUpdates() {
		if u.status == "FAILED" {
			found = true
			if u.metadata != nil && u.metadata["orphan_risk"] == true {
				t.Errorf("did not expect orphan_risk on a plain failure, got %v", u.metadata)
			}
		}
	}
	if !found {
		t.Fatal("expected a FAILED status update")
	}
}

// TestShouldMarkOrphanRisk covers the pure interruption-decision helper used by executeDeploy:
// any context cancellation (user cancel, 2h deadline, shutdown-drain) at/after the apply phase
// flags orphan risk; a plain apply failure (ctx still live) and a pre-apply interruption do not.
func TestShouldMarkOrphanRisk(t *testing.T) {
	cases := []struct {
		name      string
		phase     string
		wasCancel bool
		ctxErr    error
		want      bool
	}{
		{"apply+user-cancel", "apply", true, nil, true},
		{"apply+deadline", "apply", false, context.DeadlineExceeded, true},
		{"apply+ctx-canceled", "apply", false, context.Canceled, true},
		{"apply+clean-failure", "apply", false, nil, false},
		{"pre-apply+deadline", "", false, context.DeadlineExceeded, false},
		{"pre-apply+user-cancel", "", true, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldMarkOrphanRisk(tc.phase, tc.wasCancel, tc.ctxErr); got != tc.want {
				t.Errorf("shouldMarkOrphanRisk(%q, %v, %v) = %v, want %v",
					tc.phase, tc.wasCancel, tc.ctxErr, got, tc.want)
			}
		})
	}
}

// TestExecuteJob_CancelledWithOrphanRiskFlags proves a cancelled job whose apply had started
// posts CANCELLED with orphan_risk=true.
func TestExecuteJob_CancelledWithOrphanRiskFlags(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.cancels.cancel("job-orphan")
	w.cancels.markOrphanRisk("job-orphan")

	claim := &ClaimResponse{
		Job: &Job{ID: "job-orphan", JobType: "BOGUS_TYPE", ConfigSnapshot: map[string]any{}},
	}
	_ = w.executeJob(t.Context(), claim)

	var found bool
	for _, u := range api.getStatusUpdates() {
		if u.status == "CANCELLED" {
			found = true
			if u.metadata == nil || u.metadata["orphan_risk"] != true {
				t.Errorf("expected orphan_risk=true in CANCELLED metadata, got %v", u.metadata)
			}
		}
	}
	if !found {
		t.Fatal("expected a CANCELLED status update")
	}
}

func TestDeployValidation_PlanNotSuccess(t *testing.T) {
	planHash := "abc123"
	planJobID := "plan-1"
	api := &mockAPI{
		jobs: map[string]*Job{
			"plan-1": {
				ID:                "plan-1",
				Status:            "FAILED",
				ConfigurationHash: &planHash,
			},
		},
	}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{
			ID:                "deploy-1",
			JobType:           "DEPLOY",
			PlanJobID:         &planJobID,
			ConfigurationHash: &planHash,
			ConfigSnapshot: map[string]any{
				"project_name":      "test",
				"region":            "eu-west-1",
				"environment_stage": "dev",
			},
		},
		CloudIdentity: &CloudIdentity{Provider: "aws"},
	}

	err := w.executeJob(t.Context(), claim)
	if err == nil {
		t.Fatal("expected error when plan job status is FAILED")
	}

	updates := api.getStatusUpdates()
	found := false
	for _, u := range updates {
		if u.status == "FAILED" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected FAILED status for deploy with non-SUCCESS plan")
	}
}

func TestDeployValidation_HashMismatch(t *testing.T) {
	planHash := "old-hash"
	currentHash := "new-hash"
	planJobID := "plan-2"
	api := &mockAPI{
		jobs: map[string]*Job{
			"plan-2": {
				ID:                "plan-2",
				Status:            "SUCCESS",
				ConfigurationHash: &planHash,
			},
		},
	}
	w := NewWithAPI(Config{Operator: "self"}, api)

	claim := &ClaimResponse{
		Job: &Job{
			ID:                "deploy-2",
			JobType:           "DEPLOY",
			PlanJobID:         &planJobID,
			ConfigurationHash: &currentHash,
			ConfigSnapshot: map[string]any{
				"project_name":      "test",
				"region":            "eu-west-1",
				"environment_stage": "dev",
			},
		},
		CloudIdentity: &CloudIdentity{Provider: "aws"},
	}

	err := w.executeJob(t.Context(), claim)
	if err == nil {
		t.Fatal("expected error when config hash changed since plan")
	}

	updates := api.getStatusUpdates()
	found := false
	for _, u := range updates {
		if u.status == "FAILED" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected FAILED status for hash mismatch")
	}
}
