// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchStateToken(t *testing.T) {
	var gotMethod, gotPath, gotRunnerID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotRunnerID = r.Method, r.URL.Path, r.Header.Get("X-Runner-ID")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "mint-abc"})
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "runner-1", "runner-tok")
	got, err := c.FetchStateToken("job-1")
	if err != nil {
		t.Fatalf("FetchStateToken: %v", err)
	}
	if got != "mint-abc" {
		t.Errorf("token = %q, want mint-abc", got)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/jobs/job-1/state-token" {
		t.Errorf("path = %q, want /api/jobs/job-1/state-token", gotPath)
	}
	if gotRunnerID != "runner-1" {
		t.Errorf("X-Runner-ID = %q, want runner-1", gotRunnerID)
	}
}

func TestFetchStateTokenNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "runner-1", "runner-tok")
	if _, err := c.FetchStateToken("job-1"); err == nil {
		t.Fatal("expected an error on non-200 mint response")
	}
}

func TestFetchStateTokenEmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{})
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "runner-1", "runner-tok")
	if _, err := c.FetchStateToken("job-1"); err == nil {
		t.Fatal("expected an error when the mint response has no token")
	}
}

func TestPurgeProjectStateUsesBasicAuth(t *testing.T) {
	var gotMethod, gotPath, gotAuthPassword string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		// The state proxy authorizes on the state token as the HTTP Basic password.
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Basic ") {
			if dec, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(h, "Basic ")); err == nil {
				if i := strings.IndexByte(string(dec), ':'); i >= 0 {
					gotAuthPassword = string(dec)[i+1:]
				}
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "runner-1", "runner-tok")
	if err := c.PurgeProjectState("job-1", "state-tok-xyz"); err != nil {
		t.Fatalf("PurgeProjectState: %v", err)
	}
	if gotMethod != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", gotMethod)
	}
	if gotPath != "/api/jobs/job-1/state" {
		t.Errorf("path = %q, want /api/jobs/job-1/state", gotPath)
	}
	if gotAuthPassword != "state-tok-xyz" {
		t.Errorf("basic-auth password = %q, want the state token", gotAuthPassword)
	}
}
