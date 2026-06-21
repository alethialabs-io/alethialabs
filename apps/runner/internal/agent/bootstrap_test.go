// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBootstrapRunner(t *testing.T) {
	var gotAuth, gotBody, gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"runner_id":"rid-1","runner_token":"tok-1"}`))
	}))
	defer server.Close()

	id, token, err := BootstrapRunner(server.URL, "boot-secret", []string{"aws"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "rid-1" || token != "tok-1" {
		t.Fatalf("got id=%q token=%q", id, token)
	}
	if gotPath != "/api/runners/bootstrap" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer boot-secret" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"aws"`) {
		t.Fatalf("body missing providers: %s", gotBody)
	}
}

func TestBootstrapRunner_ErrorStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
	}))
	defer server.Close()

	if _, _, err := BootstrapRunner(server.URL, "bad", nil); err == nil {
		t.Fatal("expected error on 401 response")
	}
}
