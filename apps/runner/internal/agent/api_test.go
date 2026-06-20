// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClaimJob_WithJob(t *testing.T) {
	job := Job{
		ID:             "job-123",
		JobType:        "PLAN",
		Status:         "CLAIMED",
		ConfigSnapshot: map[string]any{"project_name": "test"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/claim" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("X-Runner-ID") != "w1" {
			t.Errorf("missing runner ID header")
		}
		json.NewEncoder(w).Encode(ClaimResponse{Job: &job})
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	resp, err := client.ClaimJob()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Job == nil {
		t.Fatal("expected a job")
	}
	if resp.Job.ID != "job-123" {
		t.Errorf("expected job-123, got %s", resp.Job.ID)
	}
}

func TestClaimJob_NoJob(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(ClaimResponse{Job: nil})
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	resp, err := client.ClaimJob()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Job != nil {
		t.Error("expected no job")
	}
}

func TestClaimJob_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	_, err := client.ClaimJob()
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestUpdateJobStatus_Success(t *testing.T) {
	var receivedPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/job-123/status" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "PUT" {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.UpdateJobStatus("job-123", "SUCCESS", "", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receivedPayload["status"] != "SUCCESS" {
		t.Errorf("expected SUCCESS status, got %v", receivedPayload["status"])
	}
}

func TestUpdateJobStatus_WithMetadata(t *testing.T) {
	var receivedPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	meta := map[string]any{"phase": "tofu_plan"}
	err := client.UpdateJobStatus("job-123", "PROCESSING", "", meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	execMeta, ok := receivedPayload["execution_metadata"].(map[string]any)
	if !ok {
		t.Fatal("expected execution_metadata in payload")
	}
	if execMeta["phase"] != "tofu_plan" {
		t.Errorf("expected tofu_plan, got %v", execMeta["phase"])
	}
}

func TestUpdateJobStatus_WithError(t *testing.T) {
	var receivedPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.UpdateJobStatus("job-123", "FAILED", "tofu crashed", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receivedPayload["error_message"] != "tofu crashed" {
		t.Errorf("expected error message in payload")
	}
}

func TestSendLog_Success(t *testing.T) {
	var receivedPayload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/job-123/logs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.SendLog("job-123", "hello world", "STDOUT")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receivedPayload["log_chunk"] != "hello world" {
		t.Errorf("expected log chunk")
	}
	if receivedPayload["stream_type"] != "STDOUT" {
		t.Errorf("expected STDOUT stream type")
	}
}

func TestHeartbeat_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runners/heartbeat" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.Heartbeat()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHeartbeat_Failure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "bad-token")
	err := client.Heartbeat()
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
}

func TestGetJob_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/plan-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(Job{ID: "plan-1", Status: "SUCCESS", JobType: "PLAN"})
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	job, err := client.GetJob("plan-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.ID != "plan-1" {
		t.Errorf("expected plan-1, got %s", job.ID)
	}
	if job.Status != "SUCCESS" {
		t.Errorf("expected SUCCESS, got %s", job.Status)
	}
}

func TestGetJob_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	_, err := client.GetJob("nonexistent")
	if err == nil {
		t.Fatal("expected error for 404 response")
	}
}

func TestHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Runner-ID") != "w-abc" {
			t.Errorf("expected runner ID w-abc, got %s", r.Header.Get("X-Runner-ID"))
		}
		if r.Header.Get("X-Runner-Token") != "secret-tok" {
			t.Errorf("expected runner token")
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json content type")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w-abc", "secret-tok")
	client.Heartbeat()
}
