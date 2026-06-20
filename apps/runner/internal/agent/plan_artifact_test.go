// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadPlanArtifact_Success(t *testing.T) {
	var receivedBody []byte
	var receivedPath string
	var receivedContentType string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedContentType = r.Header.Get("Content-Type")
		body, _ := io.ReadAll(r.Body)
		receivedBody = body
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"key":"job-1/tofu.plan.out"}`))
	}))
	defer server.Close()

	tmpFile := filepath.Join(t.TempDir(), "test.plan.out")
	planData := []byte("fake-tofu-plan-binary-content")
	os.WriteFile(tmpFile, planData, 0644)

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.UploadPlanArtifact("job-1", tmpFile)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedPath != "/api/jobs/job-1/plan-artifact" {
		t.Errorf("path = %q, want /api/jobs/job-1/plan-artifact", receivedPath)
	}
	if receivedContentType != "application/octet-stream" {
		t.Errorf("content-type = %q, want application/octet-stream", receivedContentType)
	}
	if string(receivedBody) != string(planData) {
		t.Errorf("body mismatch: got %d bytes, want %d", len(receivedBody), len(planData))
	}
}

func TestUploadPlanArtifact_FileNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not reach server")
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.UploadPlanArtifact("job-1", "/nonexistent/path")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestUploadPlanArtifact_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	tmpFile := filepath.Join(t.TempDir(), "test.plan.out")
	os.WriteFile(tmpFile, []byte("data"), 0644)

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.UploadPlanArtifact("job-1", tmpFile)
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestDownloadPlanArtifact_Success(t *testing.T) {
	planData := []byte("downloaded-plan-binary")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/plan-1/plan-artifact" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(planData)
	}))
	defer server.Close()

	destPath := filepath.Join(t.TempDir(), "downloaded.plan.out")
	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.DownloadPlanArtifact("plan-1", destPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	content, _ := os.ReadFile(destPath)
	if string(content) != string(planData) {
		t.Errorf("downloaded content mismatch")
	}
}

func TestDownloadPlanArtifact_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	destPath := filepath.Join(t.TempDir(), "downloaded.plan.out")
	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.DownloadPlanArtifact("plan-1", destPath)
	if err == nil {
		t.Fatal("expected error for 404")
	}
}

func TestDownloadPlanArtifact_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	destPath := filepath.Join(t.TempDir(), "downloaded.plan.out")
	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.DownloadPlanArtifact("plan-1", destPath)
	if err == nil {
		t.Fatal("expected error for 500")
	}
}
