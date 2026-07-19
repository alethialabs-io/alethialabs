// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

// --- GetClusters ---

func TestGetClusters_Success(t *testing.T) {
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
					"project_name":      "my-app",
					"environment":       "production",
					"region":            "eu-west-1",
				},
			},
		})
	}))

	clusters, err := client.GetClusters()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(clusters))
	}
	if clusters[0].ClusterName != "prod-eks" {
		t.Errorf("expected prod-eks, got %s", clusters[0].ClusterName)
	}
	if clusters[0].ProjectName != "my-app" {
		t.Errorf("expected my-app, got %s", clusters[0].ProjectName)
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
		if body["configuration_id"] != "project-1" {
			t.Errorf("expected project-1, got %v", body["configuration_id"])
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
		ConfigurationID: "project-1",
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
		ConfigurationID:  "project-1",
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
		if r.URL.Query().Get("limit") != "20" {
			t.Errorf("expected limit=20, got %s", r.URL.Query().Get("limit"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"jobs":   []map[string]any{{"id": "j1", "status": "SUCCESS", "job_type": "PLAN", "project_name": "my-app"}},
			"total":  1,
			"limit":  20,
			"offset": 0,
		})
	}))

	page, err := client.GetJobs("SUCCESS", 20, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(page.Jobs))
	}
	if page.Total != 1 {
		t.Errorf("expected total 1, got %d", page.Total)
	}
	if page.Jobs[0].ProjectName != "my-app" {
		t.Errorf("expected project_name my-app, got %s", page.Jobs[0].ProjectName)
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

	page, err := client.GetJobs("", 20, 20)
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

		// Synchronous verdict — no job_id.
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id":         "id-123",
			"verified":            true,
			"status":              "connected",
			"error":               nil,
			"missing_permissions": []string{},
		})
	}))

	resp, err := client.ConnectProviderIdentity("aws", "id-123", map[string]interface{}{
		"role_arn": "arn:aws:iam::123456789012:role/Alethia",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Verified || resp.Status != "connected" {
		t.Errorf("expected verified connected, got verified=%v status=%s", resp.Verified, resp.Status)
	}
	if resp.IdentityID != "id-123" {
		t.Errorf("expected id-123, got %s", resp.IdentityID)
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

func TestVerifyProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/verify" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		var body struct {
			IdentityID string `json:"identity_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode body: %v", err)
		}
		if body.IdentityID != "id-123" {
			t.Errorf("expected identity_id id-123, got %s", body.IdentityID)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id":         "id-123",
			"verified":            true,
			"status":              "connected",
			"error":               nil,
			"missing_permissions": []string{},
		})
	}))

	resp, err := client.VerifyProviderIdentity("aws", "id-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Verified || resp.Status != "connected" {
		t.Errorf("expected verified connected, got verified=%v status=%s", resp.Verified, resp.Status)
	}
}

func TestVerifyProviderIdentity_ErrorPropagates(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "identity not found"})
	}))

	if _, err := client.VerifyProviderIdentity("aws", "missing"); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestGetRepositories_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/repositories/github" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"repositories": []map[string]any{
				{"id": "1", "name": "app", "full_name": "acme/app", "url": "u", "private": true, "default_branch": "main", "provider": "github"},
			},
		})
	}))

	repos, err := client.GetRepositories("github")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "acme/app" {
		t.Errorf("unexpected repos: %+v", repos)
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

func TestGetProjectDrift_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/drift" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("env") != "production" {
			t.Errorf("expected env=production, got %q", r.URL.Query().Get("env"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"evaluated":   true,
			"in_sync":     false,
			"drifted":     1,
			"scanned_at":  "2026-01-01T00:00:00.000Z",
			"environment": "production",
			"details":     []map[string]any{{"address": "aws_s3_bucket.x", "type": "aws_s3_bucket", "kind": "modified"}},
		})
	}))

	posture, err := client.GetProjectDrift("my-proj", "production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !posture.Evaluated || posture.Drifted != 1 || len(posture.Details) != 1 {
		t.Errorf("unexpected posture: %+v", posture)
	}
	if posture.Details[0].Kind != "modified" {
		t.Errorf("unexpected detail kind: %s", posture.Details[0].Kind)
	}
}

func TestGetEnvironmentCost_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/cost" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"priced":        true,
			"total_monthly": 42.5,
			"currency":      "USD",
			"captured_at":   "2026-01-01T00:00:00.000Z",
			"plan_job_id":   "job-1",
			"environment":   "staging",
			"resources":     []map[string]any{{"address": "aws_db_instance.main", "resource_type": "aws_db_instance", "monthly_cost": 42.5}},
		})
	}))

	cost, err := client.GetEnvironmentCost("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cost.Priced || cost.TotalMonthly == nil || *cost.TotalMonthly != 42.5 {
		t.Errorf("unexpected cost: %+v", cost)
	}
	if len(cost.Resources) != 1 || cost.Resources[0].ResourceType != "aws_db_instance" {
		t.Errorf("unexpected resources: %+v", cost.Resources)
	}
}

func TestGetProjectProtection_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/protection" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"rules": []map[string]any{{
				"environment_id":       "env-1",
				"environment":          "production",
				"require_predecessor":  true,
				"require_verify_pass":  true,
				"require_approval":     true,
				"min_count":            2,
				"soak_minutes":         30,
				"cost_delta_threshold": 100.0,
			}},
		})
	}))

	rules, err := client.GetProjectProtection("my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rules) != 1 || rules[0].Environment != "production" || !rules[0].RequireApproval {
		t.Errorf("unexpected rules: %+v", rules)
	}
	if rules[0].MinCount == nil || *rules[0].MinCount != 2 {
		t.Errorf("unexpected min_count: %+v", rules[0].MinCount)
	}
}

func TestGetProjectProbes_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/probes" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"probes": []map[string]any{
				{"environment_id": "env-1", "environment": "production", "reachable": true, "message": nil, "probed_at": "2026-01-01T00:00:00.000Z"},
				{"environment_id": "env-2", "environment": "dev", "reachable": nil, "message": nil, "probed_at": nil},
			},
		})
	}))

	probes, err := client.GetProjectProbes("my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(probes) != 2 {
		t.Fatalf("expected 2 probes, got %d", len(probes))
	}
	if probes[0].Reachable == nil || !*probes[0].Reachable {
		t.Errorf("expected production reachable=true, got %+v", probes[0].Reachable)
	}
	if probes[1].Reachable != nil {
		t.Errorf("expected dev reachable=nil (never probed), got %+v", probes[1].Reachable)
	}
}

func TestGetProjectAddons_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/addons" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"addons": []map[string]any{
				{"addon_id": "cnpg", "enabled": true, "mode": "managed", "version": nil, "namespace": "cnpg", "status": "READY", "health": "Healthy", "sync": "Synced", "last_synced_at": nil},
			},
		})
	}))

	view, err := client.GetProjectAddons("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if view.Environment != "production" || len(view.Addons) != 1 || view.Addons[0].AddonID != "cnpg" {
		t.Errorf("unexpected view: %+v", view)
	}
}

func TestGetProjectByoCharts_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/byo-charts" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"charts": []map[string]any{
				{"id": "payments", "repo_url": "u", "chart_path": "charts/payments", "ref": "main", "namespace": "payments", "status": "READY", "health": nil, "sync": nil, "scan_status": "done", "scanned_at": nil},
			},
		})
	}))

	view, err := client.GetProjectByoCharts("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(view.Charts) != 1 || view.Charts[0].ID != "payments" {
		t.Errorf("unexpected charts: %+v", view.Charts)
	}
}

func TestGetProjectIacSource_Present(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/byo-iac" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"source": map[string]any{
				"id": "src-1", "environment": "production", "name": "networking", "repo_url": "u",
				"ref": nil, "path": "envs/prod", "commit_sha": nil, "deployed_commit_sha": nil,
				"enabled": true, "scan_status": "done", "scanned_at": nil, "status": "READY", "status_message": nil,
			},
		})
	}))

	src, err := client.GetProjectIacSource("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src == nil || src.Name != "networking" {
		t.Errorf("unexpected source: %+v", src)
	}
}

func TestGetProjectIacSource_None(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"source": nil})
	}))

	src, err := client.GetProjectIacSource("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src != nil {
		t.Errorf("expected nil source, got %+v", src)
	}
}

func TestGetProjectPromotions_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/promotions" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"promotions": []map[string]any{
				{"id": "p1", "source": "staging", "target": "production", "status": "DEPLOYED", "error_message": nil, "created_at": "2026-01-01T00:00:00.000Z", "completed_at": nil},
			},
		})
	}))

	promos, err := client.GetProjectPromotions("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(promos) != 1 || promos[0].Target != "production" {
		t.Errorf("unexpected promotions: %+v", promos)
	}
}

func TestGetPromotion_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/promotions/p1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"promotion": map[string]any{
				"id": "p1", "source": "staging", "target": "production", "status": "PENDING_APPROVAL",
				"initiator": "Ivo", "error_message": nil, "approved": 1, "required": 2,
				"approvals": []map[string]any{
					{"id": "a1", "status": "approved", "name": "Ivo", "required_role": "admin", "comment": nil, "decided_at": "2026-01-01T01:00:00.000Z"},
				},
				"created_at": "2026-01-01T00:00:00.000Z", "completed_at": nil,
			},
		})
	}))

	p, err := client.GetPromotion("my-proj", "p1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Approved != 1 || p.Required != 2 || len(p.Approvals) != 1 {
		t.Errorf("unexpected promotion detail: %+v", p)
	}
}

func TestGetProjectStagedChanges_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/staged" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"changes": []map[string]any{
				{"component_type": "database", "op": "create", "component_id": nil, "created_at": "2026-01-01T00:00:00.000Z"},
			},
		})
	}))

	view, err := client.GetProjectStagedChanges("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if view.Environment != "production" || len(view.Changes) != 1 || view.Changes[0].Op != "create" {
		t.Errorf("unexpected staged changes: %+v", view)
	}
}
