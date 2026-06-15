// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

import (
	"fmt"
	"sync"
	"testing"
)

type mockAPI struct {
	mu              sync.Mutex
	statusUpdates   []statusUpdate
	logChunks       []logEntry
	heartbeatCount  int
	claimResponse   *ClaimResponse
	claimErr        error
	jobs            map[string]*Job
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
	return m.claimResponse, m.claimErr
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

func (m *mockAPI) UploadPlanArtifact(jobID, filePath string) error {
	return nil
}

func (m *mockAPI) DownloadPlanArtifact(jobID, destPath string) error {
	return fmt.Errorf("not implemented in mock")
}

func (m *mockAPI) UpdateWorkerMetadata(workerID string, metadata map[string]any) error {
	return nil
}

func (m *mockAPI) DeleteWorker(workerID string) error {
	return nil
}

func (m *mockAPI) getStatusUpdates() []statusUpdate {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]statusUpdate, len(m.statusUpdates))
	copy(result, m.statusUpdates)
	return result
}

func TestSnapshotToVineConfig(t *testing.T) {
	tests := []struct {
		name     string
		snapshot map[string]any
		wantName string
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
			name: "legacy aws_region fallback",
			snapshot: map[string]any{
				"project_name":      "legacy",
				"aws_region":        "us-east-1",
				"environment_stage": "prod",
			},
			wantName:   "legacy",
			wantRegion: "us-east-1",
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
			vc, err := snapshotToVineConfig(tt.snapshot)
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
	w := NewWithAPI(Config{Mode: "self-hosted"}, api)

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

func TestExecuteJob_UnknownType(t *testing.T) {
	api := &mockAPI{}
	w := NewWithAPI(Config{Mode: "self-hosted"}, api)

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
	w := NewWithAPI(Config{Mode: "self-hosted"}, api)

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
	w := NewWithAPI(Config{Mode: "self-hosted"}, api)

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
