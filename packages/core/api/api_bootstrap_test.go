// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- GetConfigurations / GetCluster ---

func TestGetConfigurations_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "GET" || r.URL.Path != "/api/cli/configurations" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"configurations": []map[string]any{
				{"id": "c1", "project_name": "web"},
				{"id": "c2", "project_name": "api"},
			},
		})
	}))

	configs, err := client.GetConfigurations()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(configs) != 2 {
		t.Fatalf("expected 2 configurations, got %d", len(configs))
	}
}

func TestGetConfigurations_ServerError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "db down"})
	}))

	if _, err := client.GetConfigurations(); err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestGetCluster_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/clusters/cl-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"cluster": map[string]any{
				"id": "cl-1", "cluster_name": "prod", "status": "ACTIVE",
				"instance_types": []string{"t3.medium"},
			},
			"gitops": map[string]any{
				"mode": "argocd", "total": 3, "synced": 3, "healthy": 2,
				"status_available": true, "last_deploy_failed": false,
			},
		})
	}))

	detail, err := client.GetCluster("cl-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.Cluster.ClusterName != "prod" {
		t.Errorf("expected cluster prod, got %s", detail.Cluster.ClusterName)
	}
	if detail.Gitops == nil || detail.Gitops.Healthy != 2 {
		t.Errorf("unexpected gitops: %+v", detail.Gitops)
	}
}

func TestGetCluster_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
	}))

	if _, err := client.GetCluster("nope"); err == nil {
		t.Fatal("expected error for 404 response")
	}
}

// --- Legacy: deployment logs + bootstrap jobs ---

func TestSendLog_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/deployments/d-1/logs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body LogEntry
		json.NewDecoder(r.Body).Decode(&body)
		if body.Message != "applying" || body.Level != "info" || body.Step != "apply" {
			t.Errorf("unexpected log entry: %+v", body)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.SendLog("d-1", LogEntry{Message: "applying", Level: "info", Step: "apply"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCreateBootstrapJob_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/bootstrap-jobs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{"id": "bj-1", "status": "QUEUED", "created_at": "2026-01-01T00:00:00Z"},
		})
	}))

	job, err := client.CreateBootstrapJob()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.ID != "bj-1" || job.Status != "QUEUED" {
		t.Errorf("unexpected job: %+v", job)
	}
}

func TestCreateBootstrapJob_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "not allowed"})
	}))

	if _, err := client.CreateBootstrapJob(); err == nil {
		t.Fatal("expected error for 403 response")
	}
}

func TestUpdateBootstrapJobStatus(t *testing.T) {
	tests := []struct {
		name         string
		status       string
		errorMessage string
		responseCode int
		wantErrField bool
		wantErr      bool
	}{
		{name: "success without error message", status: "COMPLETED", responseCode: http.StatusOK},
		{
			name: "failure carries the error message", status: "FAILED",
			errorMessage: "tofu apply failed", responseCode: http.StatusOK, wantErrField: true,
		},
		{name: "server rejects the update", status: "COMPLETED", responseCode: http.StatusConflict, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.Method != "PUT" || r.URL.Path != "/api/cli/bootstrap-jobs/bj-1" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				if ct := r.Header.Get("Content-Type"); ct != "application/json" {
					t.Errorf("expected JSON content type, got %s", ct)
				}
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				if body["status"] != tt.status {
					t.Errorf("expected status %s, got %s", tt.status, body["status"])
				}
				if _, ok := body["error_message"]; ok != tt.wantErrField {
					t.Errorf("error_message present = %v, want %v", ok, tt.wantErrField)
				}
				w.WriteHeader(tt.responseCode)
			}))

			err := client.UpdateBootstrapJobStatus("bj-1", tt.status, tt.errorMessage)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for status %d", tt.responseCode)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestSendBootstrapLog_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/bootstrap-jobs/bj-1/logs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["log_chunk"] != "hello" || body["stream_type"] != "stdout" {
			t.Errorf("unexpected payload: %+v", body)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.SendBootstrapLog("bj-1", "hello", "stdout"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Cluster registration ---

func TestRegisterCluster_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/clusters" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "prod" || body["vpc_id"] != "vpc-1" ||
			body["vpc_cidr"] != "10.0.0.0/16" || body["region"] != "eu-west-1" {
			t.Errorf("unexpected payload: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"cluster_id": "cl-9", "agent_token": "at-9"})
	}))

	resp, err := client.RegisterCluster("prod", "vpc-1", "10.0.0.0/16", "eu-west-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.ClusterID != "cl-9" || resp.AgentToken != "at-9" {
		t.Errorf("unexpected response: %+v", resp)
	}
}

func TestRegisterCluster_Conflict(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "cluster exists"})
	}))

	if _, err := client.RegisterCluster("prod", "vpc-1", "10.0.0.0/16", "eu-west-1"); err == nil {
		t.Fatal("expected error for 409 response")
	}
}

func TestUnregisterCluster(t *testing.T) {
	tests := []struct {
		name         string
		id           string
		clusterName  string
		wantQuery    string
		responseCode int
		wantErr      bool
	}{
		{name: "by id", id: "cl-1", wantQuery: "id=cl-1", responseCode: http.StatusOK},
		{name: "by name", clusterName: "prod", wantQuery: "name=prod", responseCode: http.StatusOK},
		{name: "by both", id: "cl-1", clusterName: "prod", wantQuery: "id=cl-1&name=prod", responseCode: http.StatusOK},
		{name: "neither", wantQuery: "", responseCode: http.StatusOK},
		{name: "server refuses", id: "cl-1", wantQuery: "id=cl-1", responseCode: http.StatusNotFound, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.Method != "DELETE" || r.URL.Path != "/api/cli/clusters" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				if r.URL.RawQuery != tt.wantQuery {
					t.Errorf("expected query %q, got %q", tt.wantQuery, r.URL.RawQuery)
				}
				w.WriteHeader(tt.responseCode)
			}))

			err := client.UnregisterCluster(tt.id, tt.clusterName)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for status %d", tt.responseCode)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
