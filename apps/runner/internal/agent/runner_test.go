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
	mu             sync.Mutex
	statusUpdates  []statusUpdate
	logChunks      []logEntry
	heartbeatCount int
	claimResponse  *ClaimResponse
	claimErr       error
	claimCount     int
	jobs           map[string]*Job
}

type statusUpdate struct {
	jobID    string
	status   string
	errMsg   string
	metadata map[string]any
}

type logEntry struct {
	jobID      string
	chunk      string
	streamType string
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

// StreamWake fires one wake immediately (simulating an enqueue), then holds until
// the context is cancelled.
func (m *mockAPI) StreamWake(ctx context.Context, onWake func()) error {
	onWake()
	<-ctx.Done()
	return ctx.Err()
}

func (m *mockAPI) UpdateJobStatus(jobID, status, errMsg string, metadata map[string]any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.statusUpdates = append(m.statusUpdates, statusUpdate{jobID, status, errMsg, metadata})
	return nil
}

func (m *mockAPI) SendLog(jobID, chunk, streamType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logChunks = append(m.logChunks, logEntry{jobID, chunk, streamType})
	return nil
}

func (m *mockAPI) Heartbeat() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.heartbeatCount++
	return nil
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

func (m *mockAPI) FetchAzureToken() (string, error) {
	return "test-azure-token", nil
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
