// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	os.Setenv("ALETHIA_WEB_ORIGIN", server.URL)
	t.Cleanup(func() { os.Unsetenv("ALETHIA_WEB_ORIGIN") })
	return NewClient("test-token")
}

func assertAuth(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
		t.Errorf("expected Bearer test-token, got %s", got)
	}
}

// --- GetRunners ---

func TestGetRunners_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"runners": []map[string]any{
				{"id": "w1", "name": "runner-a", "operator": "self", "provisioning": "registered", "status": "ONLINE", "is_default": true},
				{"id": "w2", "name": "runner-b", "operator": "managed", "status": "OFFLINE", "is_default": false},
			},
		})
	}))

	runners, err := client.GetRunners()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runners) != 2 {
		t.Fatalf("expected 2 runners, got %d", len(runners))
	}
	if runners[0].Name != "runner-a" {
		t.Errorf("expected runner-a, got %s", runners[0].Name)
	}
	if !runners[0].IsDefault {
		t.Error("expected first runner to be default")
	}
	if runners[1].Operator != "managed" {
		t.Errorf("expected managed, got %s", runners[1].Operator)
	}
}

func TestGetRunners_ServerError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "db down"})
	}))

	_, err := client.GetRunners()
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

// --- RemoveRunner ---

func TestRemoveRunner_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners/w1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "DELETE" {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.RemoveRunner("w1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRemoveRunner_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
	}))

	if err := client.RemoveRunner("bad-id"); err == nil {
		t.Fatal("expected error for 404 response")
	}
}

// --- DeployRunner ---

func TestDeployRunner_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners/deploy" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "my-runner" {
			t.Errorf("expected name my-runner, got %s", body["name"])
		}
		if body["cloud_identity_id"] != "ci-1" {
			t.Errorf("expected cloud_identity_id ci-1, got %s", body["cloud_identity_id"])
		}
		if body["region"] != "eu-west-1" {
			t.Errorf("expected region eu-west-1, got %s", body["region"])
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"runner": map[string]string{"id": "t1", "name": "my-runner"},
			"job":    map[string]string{"id": "j1", "status": "QUEUED", "created_at": "2026-01-01T00:00:00Z"},
		})
	}))

	resp, err := client.DeployRunner("my-runner", "ci-1", "eu-west-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Runner.ID != "t1" {
		t.Errorf("expected runner id t1, got %s", resp.Runner.ID)
	}
	if resp.Job.ID != "j1" {
		t.Errorf("expected job id j1, got %s", resp.Job.ID)
	}
}

func TestDeployRunner_WithAssigned(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["assigned_runner_id"] != "w-exec" {
			t.Errorf("expected assigned_runner_id w-exec, got %s", body["assigned_runner_id"])
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"runner": map[string]string{"id": "t1", "name": "t"},
			"job":    map[string]string{"id": "j1", "status": "QUEUED"},
		})
	}))

	_, err := client.DeployRunner("t", "ci", "us-east-1", "w-exec")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- GetSpecClusters ---

func TestGetSpecClusters_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/clusters" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"clusters": []map[string]any{
				{
					"id":                "vc1",
					"cluster_name":      "prod-eks",
					"cluster_version":   "1.29",
					"status":            "ACTIVE",
					"node_min_size":     2,
					"node_max_size":     10,
					"node_desired_size": 3,
					"spec_project_name": "my-app",
					"spec_environment":  "production",
					"spec_region":       "eu-west-1",
				},
			},
		})
	}))

	clusters, err := client.GetSpecClusters()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(clusters))
	}
	if clusters[0].ClusterName != "prod-eks" {
		t.Errorf("expected prod-eks, got %s", clusters[0].ClusterName)
	}
	if clusters[0].SpecProjectName != "my-app" {
		t.Errorf("expected my-app, got %s", clusters[0].SpecProjectName)
	}
}

// --- GetCloudIdentities ---

func TestGetCloudIdentities_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/cloud-identities" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"cloud_identities": []map[string]any{
				{"id": "ci1", "provider": "aws", "label": "AWS (123456)"},
				{"id": "ci2", "provider": "gcp", "label": "GCP (my-project)"},
			},
		})
	}))

	ids, err := client.GetCloudIdentities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 identities, got %d", len(ids))
	}
	if ids[0].Provider != "aws" {
		t.Errorf("expected aws, got %s", ids[0].Provider)
	}
	if ids[1].Label != "GCP (my-project)" {
		t.Errorf("expected GCP label, got %s", ids[1].Label)
	}
}

func TestGetCloudIdentities_Empty(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"cloud_identities": []any{}})
	}))

	ids, err := client.GetCloudIdentities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected 0, got %d", len(ids))
	}
}

// --- QueueJobWithParams ---

func TestQueueJob_Plan(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/jobs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["job_type"] != "PLAN" {
			t.Errorf("expected PLAN, got %v", body["job_type"])
		}
		if body["configuration_id"] != "spec-1" {
			t.Errorf("expected spec-1, got %v", body["configuration_id"])
		}
		if _, ok := body["plan_job_id"]; ok {
			t.Error("plan_job_id should not be sent when empty")
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{"id": "job-1", "status": "QUEUED", "job_type": "PLAN"},
		})
	}))

	job, err := client.QueueJobWithParams(QueueJobParams{
		JobType:         "PLAN",
		ZoneID:          "vy-1",
		ConfigurationID: "spec-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.ID != "job-1" {
		t.Errorf("expected job-1, got %s", job.ID)
	}
}

func TestQueueJob_DeployWithAssigned(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["assigned_runner_id"] != "w-1" {
			t.Errorf("expected assigned_runner_id w-1, got %v", body["assigned_runner_id"])
		}
		if body["plan_job_id"] != "plan-1" {
			t.Errorf("expected plan_job_id plan-1, got %v", body["plan_job_id"])
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{"id": "job-2", "status": "QUEUED", "job_type": "DEPLOY"},
		})
	}))

	_, err := client.QueueJobWithParams(QueueJobParams{
		JobType:          "DEPLOY",
		ZoneID:           "vy-1",
		ConfigurationID:  "spec-1",
		AssignedRunnerID: "w-1",
		PlanJobID:        "plan-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- GetJobs ---

func TestGetJobs_WithFilters(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/jobs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("status") != "SUCCESS" {
			t.Errorf("expected status=SUCCESS, got %s", r.URL.Query().Get("status"))
		}
		if r.URL.Query().Get("zone_id") != "vy-1" {
			t.Errorf("expected zone_id=vy-1, got %s", r.URL.Query().Get("zone_id"))
		}
		if r.URL.Query().Get("limit") != "20" {
			t.Errorf("expected limit=20, got %s", r.URL.Query().Get("limit"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"jobs":   []map[string]any{{"id": "j1", "status": "SUCCESS", "job_type": "PLAN", "spec_name": "my-app"}},
			"total":  1,
			"limit":  20,
			"offset": 0,
		})
	}))

	page, err := client.GetJobs("SUCCESS", "vy-1", 20, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(page.Jobs))
	}
	if page.Total != 1 {
		t.Errorf("expected total 1, got %d", page.Total)
	}
	if page.Jobs[0].SpecName != "my-app" {
		t.Errorf("expected spec_name my-app, got %s", page.Jobs[0].SpecName)
	}
}

func TestGetJobs_Pagination(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("offset") != "20" {
			t.Errorf("expected offset=20, got %s", r.URL.Query().Get("offset"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"jobs": []any{}, "total": 50, "limit": 20, "offset": 20,
		})
	}))

	page, err := client.GetJobs("", "", 20, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if page.Total != 50 {
		t.Errorf("expected total 50, got %d", page.Total)
	}
}

// --- GetJob ---

func TestGetJob_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/job-abc" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "job-abc", "status": "PROCESSING", "job_type": "DEPLOY",
		})
	}))

	job, err := client.GetJob("job-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.Status != "PROCESSING" {
		t.Errorf("expected PROCESSING, got %s", job.Status)
	}
}

func TestGetJob_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
	}))

	_, err := client.GetJob("bad")
	if err == nil {
		t.Fatal("expected error for 404")
	}
}

// --- GetJobLogs ---

func TestGetJobLogs_WithAfterID(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/j1/logs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("after") != "42" {
			t.Errorf("expected after=42, got %s", r.URL.Query().Get("after"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"logs": []map[string]any{
				{"id": 43, "job_id": "j1", "log_chunk": "hello", "stream_type": "STDOUT"},
			},
		})
	}))

	logs, err := client.GetJobLogs("j1", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].LogChunk != "hello" {
		t.Errorf("expected hello, got %s", logs[0].LogChunk)
	}
}

func TestGetJobLogs_NoAfter(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("after") != "" {
			t.Errorf("expected no after param, got %s", r.URL.Query().Get("after"))
		}
		json.NewEncoder(w).Encode(map[string]any{"logs": []any{}})
	}))

	_, err := client.GetJobLogs("j1", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- CancelJob ---

func TestCancelJob_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/j1/cancel" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.CancelJob("j1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCancelJob_Failed(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "job already completed"})
	}))

	if err := client.CancelJob("j1"); err == nil {
		t.Fatal("expected error for completed job")
	}
}

// --- GetConfiguration ---

func TestGetConfiguration_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/configurations/by-project-name/my-app" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"configuration": map[string]any{
				"id":                "cfg-1",
				"project_name":      "my-app",
				"environment_stage": "production",
			},
		})
	}))

	config, err := client.GetConfiguration("my-app")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.ProjectName != "my-app" {
		t.Errorf("expected my-app, got %s", config.ProjectName)
	}
}

// --- ExportConfiguration ---

func TestExportConfiguration_DefaultFormat(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("format") != "legacy-yaml" {
			t.Errorf("expected format=legacy-yaml, got %s", r.URL.Query().Get("format"))
		}
		json.NewEncoder(w).Encode(map[string]string{
			"content": "yaml-content", "filename": "config.yaml", "format": "legacy-yaml",
		})
	}))

	export, err := client.ExportConfiguration("my-app", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if export.Content != "yaml-content" {
		t.Errorf("expected yaml-content, got %s", export.Content)
	}
}

// --- Cloud Provider Connections ---

func TestInitProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/gcp/init" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id": "id-123",
			"external_id": "ext-abc",
		})
	}))

	resp, err := client.InitProviderIdentity("gcp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.IdentityID != "id-123" {
		t.Errorf("expected identity id-123, got %s", resp.IdentityID)
	}
	if resp.ExternalID != "ext-abc" {
		t.Errorf("expected external ext-abc, got %s", resp.ExternalID)
	}
}

func TestConnectProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/connect" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body struct {
			IdentityID  string                 `json:"identity_id"`
			Credentials map[string]interface{} `json:"credentials"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode body: %v", err)
		}
		if body.IdentityID != "id-123" {
			t.Errorf("expected identity_id id-123, got %s", body.IdentityID)
		}
		if body.Credentials["role_arn"] != "arn:aws:iam::123456789012:role/Alethia" {
			t.Errorf("unexpected credentials: %v", body.Credentials)
		}

		json.NewEncoder(w).Encode(map[string]any{
			"job_id":      "job-9",
			"identity_id": "id-123",
		})
	}))

	resp, err := client.ConnectProviderIdentity("aws", "id-123", map[string]interface{}{
		"role_arn": "arn:aws:iam::123456789012:role/Alethia",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.JobID != "job-9" {
		t.Errorf("expected job-9, got %s", resp.JobID)
	}
	if resp.IdentityID != "id-123" {
		t.Errorf("expected id-123, got %s", resp.IdentityID)
	}
}

func TestVerifyProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/azure/verify" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body struct {
			IdentityID string `json:"identity_id"`
			JobID      string `json:"job_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode body: %v", err)
		}
		if body.IdentityID != "id-7" || body.JobID != "job-7" {
			t.Errorf("unexpected body: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	if err := client.VerifyProviderIdentity("azure", "id-7", "job-7"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDisconnectProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/gcp/disconnect" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	if err := client.DisconnectProviderIdentity("gcp", "id-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetProviderStatus_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/status" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"connected": true,
			"accountId": "123456789012",
			"roleArn":   "arn:aws:iam::123456789012:role/Alethia",
		})
	}))

	status, err := client.GetProviderStatus("aws")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !status.Connected {
		t.Errorf("expected connected=true")
	}
	if status.AccountID != "123456789012" {
		t.Errorf("expected accountId 123456789012, got %s", status.AccountID)
	}
	if status.RoleArn != "arn:aws:iam::123456789012:role/Alethia" {
		t.Errorf("unexpected roleArn: %s", status.RoleArn)
	}
}

func TestConnectProviderIdentity_ErrorPropagates(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": "Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName",
		})
	}))

	_, err := client.ConnectProviderIdentity("aws", "id-123", map[string]interface{}{
		"role_arn": "bad-arn",
	})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "Invalid format") {
		t.Errorf("expected error to contain the server message, got %q", err.Error())
	}
}
