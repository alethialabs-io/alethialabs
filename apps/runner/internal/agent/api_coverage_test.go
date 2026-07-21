// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// These tests cover the RunnerAPIClient methods left uncovered after api_test.go /
// api_helpers_test.go: the SSE wake stream, the git-token / addon-secrets fetchers, the four
// keyless cloud-token mints, and the runner metadata/delete calls. Each exercises the real
// request (path, method, body) against an httptest server plus the non-2xx error path.

func TestStreamWake_DeliversTypedEventsAndIgnoresComments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runners/wake" {
			t.Errorf("path = %s, want /runners/wake", r.URL.Path)
		}
		if r.Header.Get("Accept") != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", r.Header.Get("Accept"))
		}
		// A comment (heartbeat, ignored), a typed cancel event, and a legacy bare wake.
		fmt.Fprint(w, ": heartbeat\n")
		fmt.Fprint(w, `data: {"type":"cancel","job_id":"job-9"}`+"\n")
		fmt.Fprint(w, "data: wake\n")
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	var got []WakeEvent
	if err := client.StreamWake(context.Background(), func(ev WakeEvent) { got = append(got, ev) }); err != nil {
		t.Fatalf("StreamWake: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d events, want 2 (comment ignored): %#v", len(got), got)
	}
	if got[0].Type != "cancel" || got[0].JobID != "job-9" {
		t.Errorf("event 0 = %#v, want {cancel job-9}", got[0])
	}
	if got[1].Type != "wake" {
		t.Errorf("event 1 = %#v, want legacy wake", got[1])
	}
}

func TestStreamWake_IdleStreamUnblocks(t *testing.T) {
	// A half-open stream: headers + one heartbeat, then the server hangs without closing. The idle
	// watchdog must cancel the read so StreamWake returns instead of blocking forever (#953).
	origIdle := wakeIdleTimeout
	wakeIdleTimeout = 100 * time.Millisecond
	defer func() { wakeIdleTimeout = origIdle }()

	block := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		fmt.Fprint(w, ": heartbeat\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-block // hang until the test releases us
	}))
	defer server.Close()
	defer close(block)

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	done := make(chan error, 1)
	go func() { done <- client.StreamWake(context.Background(), func(WakeEvent) {}) }()

	select {
	case <-done:
		// Returned (idle watchdog fired) — the exact error value doesn't matter, only that it unblocked.
	case <-time.After(2 * time.Second):
		t.Fatal("StreamWake did not unblock on an idle stream")
	}
}

func TestStreamWake_NonOKStatusErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := NewRunnerAPIClient(server.URL, "w1", "tok1")
	err := client.StreamWake(context.Background(), func(WakeEvent) { t.Fatal("onEvent must not fire on error") })
	if err == nil {
		t.Fatal("expected error on non-OK status")
	}
}

func TestFetchGitToken_SuccessNullAndError(t *testing.T) {
	t.Run("token + repo query", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/jobs/job-1/git-token" {
				t.Errorf("path = %s", r.URL.Path)
			}
			if r.URL.Query().Get("repo") != "https://github.com/o/r" {
				t.Errorf("repo query = %q", r.URL.Query().Get("repo"))
			}
			json.NewEncoder(w).Encode(map[string]any{"token": "gho_abc"})
		}))
		defer server.Close()
		tok, err := NewRunnerAPIClient(server.URL, "w1", "tok1").FetchGitToken("job-1", "https://github.com/o/r")
		if err != nil || tok != "gho_abc" {
			t.Fatalf("token=%q err=%v", tok, err)
		}
	})

	t.Run("null token → empty string", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{"token": nil})
		}))
		defer server.Close()
		tok, err := NewRunnerAPIClient(server.URL, "w1", "tok1").FetchGitToken("job-1", "")
		if err != nil || tok != "" {
			t.Fatalf("token=%q err=%v (want empty, nil)", tok, err)
		}
	})

	t.Run("non-OK errors", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer server.Close()
		if _, err := NewRunnerAPIClient(server.URL, "w1", "tok1").FetchGitToken("job-1", ""); err == nil {
			t.Fatal("expected error on 403")
		}
	})
}

func TestFetchAddonSecrets_SuccessAndError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/job-1/addon-secrets" || r.Method != "POST" {
			t.Errorf("path/method = %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"secrets": map[string]map[string]string{"grafana": {"admin-password": "s3cr3t"}},
		})
	}))
	defer server.Close()
	got, err := NewRunnerAPIClient(server.URL, "w1", "tok1").FetchAddonSecrets("job-1")
	if err != nil {
		t.Fatalf("FetchAddonSecrets: %v", err)
	}
	if got["grafana"]["admin-password"] != "s3cr3t" {
		t.Fatalf("secrets = %#v", got)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	if _, err := NewRunnerAPIClient(bad.URL, "w1", "tok1").FetchAddonSecrets("job-1"); err == nil {
		t.Fatal("expected error on 500")
	}
}

func TestFetchAwsToken_SuccessIncompleteAndError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runners/aws-token" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["job_id"] != "job-1" {
			t.Errorf("job_id body = %q", body["job_id"])
		}
		json.NewEncoder(w).Encode(map[string]any{"token": "web-id", "region": "us-east-1"})
	}))
	defer server.Close()
	fed, err := NewRunnerAPIClient(server.URL, "w1", "tok1").FetchAwsToken("job-1")
	if err != nil {
		t.Fatalf("FetchAwsToken: %v", err)
	}
	if fed.Token != "web-id" || fed.Region != "us-east-1" {
		t.Fatalf("federation = %#v", fed)
	}

	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"region": "us-east-1"}) // no token
	}))
	defer empty.Close()
	if _, err := NewRunnerAPIClient(empty.URL, "w1", "tok1").FetchAwsToken("job-1"); err == nil {
		t.Fatal("expected error on incomplete (no token) response")
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer bad.Close()
	if _, err := NewRunnerAPIClient(bad.URL, "w1", "tok1").FetchAwsToken("job-1"); err == nil {
		t.Fatal("expected error on 502")
	}
}

// The azure/alibaba/gcp mints share one shape: POST /runners/<cloud>-token with a {job_id}
// body → {token}. Table-drive them, asserting success, empty-token error, and non-OK error.
func TestFetchSingleTokenClouds(t *testing.T) {
	clouds := []struct {
		name string
		path string
		call func(*RunnerAPIClient) (string, error)
	}{
		{"azure", "/api/runners/azure-token", func(c *RunnerAPIClient) (string, error) { return c.FetchAzureToken("job-1") }},
		{"alibaba", "/api/runners/alibaba-token", func(c *RunnerAPIClient) (string, error) { return c.FetchAlibabaToken("job-1") }},
		{"gcp", "/api/runners/gcp-token", func(c *RunnerAPIClient) (string, error) { return c.FetchGcpToken("job-1") }},
	}
	for _, tc := range clouds {
		t.Run(tc.name+" success", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path || r.Method != "POST" {
					t.Errorf("path/method = %s %s, want POST %s", r.Method, r.URL.Path, tc.path)
				}
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				if body["job_id"] != "job-1" {
					t.Errorf("job_id = %q", body["job_id"])
				}
				json.NewEncoder(w).Encode(map[string]any{"token": "assertion-" + tc.name})
			}))
			defer server.Close()
			tok, err := tc.call(NewRunnerAPIClient(server.URL, "w1", "tok1"))
			if err != nil || tok != "assertion-"+tc.name {
				t.Fatalf("token=%q err=%v", tok, err)
			}
		})

		t.Run(tc.name+" empty errors", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"token": ""})
			}))
			defer server.Close()
			if _, err := tc.call(NewRunnerAPIClient(server.URL, "w1", "tok1")); err == nil {
				t.Fatalf("%s: expected error on empty token", tc.name)
			}
		})

		t.Run(tc.name+" non-OK errors", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer server.Close()
			if _, err := tc.call(NewRunnerAPIClient(server.URL, "w1", "tok1")); err == nil {
				t.Fatalf("%s: expected error on 401", tc.name)
			}
		})
	}
}

func TestUpdateRunnerMetadata_SuccessAndError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" || r.URL.Path != "/api/runners/r-1/metadata" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["slots"] != float64(4) {
			t.Errorf("body slots = %v", body["slots"])
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := NewRunnerAPIClient(server.URL, "w1", "tok1").UpdateRunnerMetadata("r-1", map[string]any{"slots": 4}); err != nil {
		t.Fatalf("UpdateRunnerMetadata: %v", err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	defer bad.Close()
	if err := NewRunnerAPIClient(bad.URL, "w1", "tok1").UpdateRunnerMetadata("r-1", map[string]any{}); err == nil {
		t.Fatal("expected error on 409")
	}
}

func TestDeleteRunner_AcceptsOKAndNoContentRejectsOthers(t *testing.T) {
	for _, code := range []int{http.StatusOK, http.StatusNoContent} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "DELETE" || r.URL.Path != "/api/runners/r-1" {
				t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
			}
			w.WriteHeader(code)
		}))
		if err := NewRunnerAPIClient(server.URL, "w1", "tok1").DeleteRunner("r-1"); err != nil {
			t.Errorf("DeleteRunner on %d: %v", code, err)
		}
		server.Close()
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer bad.Close()
	if err := NewRunnerAPIClient(bad.URL, "w1", "tok1").DeleteRunner("r-1"); err == nil {
		t.Fatal("expected error on 404")
	}
}

func TestJobIDBody_EncodesJobID(t *testing.T) {
	var got map[string]string
	if err := json.NewDecoder(jobIDBody("job-42")).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["job_id"] != "job-42" {
		t.Fatalf("job_id = %q", got["job_id"])
	}
}
