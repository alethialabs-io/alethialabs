// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// --- Helpers ---

// resetTransportSettings puts the process-wide settings back to their zero state when the test
// ends, so a version, a log writer or a refresher set by one test is not seen by the next.
func resetTransportSettings(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		settings.mu.Lock()
		defer settings.mu.Unlock()
		settings.cliVersion = ""
		settings.agentTool = ""
		settings.debugSet = false
		settings.debug = nil
		settings.refresh = nil
	})
}

// recordWaits replaces the wait between attempts with a recorder and returns what it recorded.
func recordWaits(t *testing.T) *[]time.Duration {
	t.Helper()
	waits := &[]time.Duration{}
	previous := retrySleep
	retrySleep = func(d time.Duration) { *waits = append(*waits, d) }
	t.Cleanup(func() { retrySleep = previous })
	return waits
}

// dropConnection ends a request without answering it, which the client sees as a failed round trip.
func dropConnection(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		t.Fatal("the test server cannot hijack its connection")
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		t.Fatalf("hijack: %v", err)
	}
	_ = conn.Close()
}

// everyVerb is one call through each place a request leaves the client: the five verb helpers, the
// two verbs that build their own request, the repositories read, and the two sibling files.
var everyVerb = []struct {
	name   string
	method string
	call   func(*Client) error
}{
	{"doGet", http.MethodGet, func(c *Client) error { _, err := c.GetRunners(); return err }},
	{"doPost", http.MethodPost, func(c *Client) error { _, err := c.CreateBootstrapJob(); return err }},
	{"doPut", http.MethodPut, func(c *Client) error {
		_, err := c.SetFleetPool("aws", FleetPoolUpdate{})
		return err
	}},
	{"doDelete", http.MethodDelete, func(c *Client) error { return c.RemoveRunner("r1") }},
	{"doDeleteWithBody", http.MethodDelete, func(c *Client) error { return c.DetachChart("p", "e", "c1") }},
	{"GetRepositories", http.MethodGet, func(c *Client) error { _, err := c.GetRepositories("github"); return err }},
	{"UpdateBootstrapJobStatus", http.MethodPut, func(c *Client) error {
		return c.UpdateBootstrapJobStatus("j1", "RUNNING", "")
	}},
	{"UnregisterCluster", http.MethodDelete, func(c *Client) error { return c.UnregisterCluster("c1", "") }},
	{"doComponentWrite", http.MethodPatch, func(c *Client) error {
		_, err := c.UpdateComponent("p", "database", "db", "e", nil, "")
		return err
	}},
	{"doMint", http.MethodPost, func(c *Client) error {
		_, err := c.RequestKubeconfigMint("c1", types.KubeconfigMintRequest{})
		return err
	}},
}

// --- Retries ---

// TestSend_ReadIsRetriedThroughTransientStatuses: a read that meets a 502, 503 or 504 is sent
// again, twice at most, and succeeds when the control plane recovers. The waits grow and stay
// inside the backoff's bounds.
func TestSend_ReadIsRetriedThroughTransientStatuses(t *testing.T) {
	for _, status := range []int{http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			isolateConfigDir(t)
			waits := recordWaits(t)
			var hits atomic.Int32
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if hits.Add(1) < 3 {
					w.WriteHeader(status)
					return
				}
				_, _ = io.WriteString(w, `{"runners":[{"id":"r1"}]}`)
			}))

			runners, err := c.GetRunners()
			if err != nil {
				t.Fatalf("want the third attempt's answer, got %v", err)
			}
			if len(runners) != 1 || hits.Load() != 3 {
				t.Fatalf("got %d runners after %d requests, want 1 after 3", len(runners), hits.Load())
			}
			if len(*waits) != 2 {
				t.Fatalf("got %d waits, want 2", len(*waits))
			}
			for i, wait := range *waits {
				ceiling := retryBaseDelay << i
				if wait < ceiling/2 || wait > ceiling {
					t.Errorf("wait %d is %s, want between %s and %s", i+1, wait, ceiling/2, ceiling)
				}
			}
		})
	}
}

// TestSend_ReadGivesUpAfterThreeAttempts: the attempts are bounded, and the last answer is the
// error the caller gets.
func TestSend_ReadGivesUpAfterThreeAttempts(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"restarting"}`)
	}))

	_, err := c.GetRunners()
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want a 503 APIError, got %v", err)
	}
	if hits.Load() != maxAttempts || len(*waits) != maxAttempts-1 {
		t.Fatalf("got %d requests and %d waits, want %d and %d", hits.Load(), len(*waits), maxAttempts, maxAttempts-1)
	}
}

// TestSend_WriteIsNeverRetried: every request that is not a read is sent exactly once, whether it
// meets a transient status or gets no answer at all.
func TestSend_WriteIsNeverRetried(t *testing.T) {
	failures := []struct {
		name string
		fail func(*testing.T, http.ResponseWriter)
	}{
		{"503", func(_ *testing.T, w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) }},
		{"no answer", dropConnection},
	}
	for _, verb := range everyVerb {
		if verb.method == http.MethodGet {
			continue
		}
		for _, failure := range failures {
			t.Run(verb.name+"/"+failure.name, func(t *testing.T) {
				isolateConfigDir(t)
				waits := recordWaits(t)
				var hits atomic.Int32
				c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits.Add(1)
					failure.fail(t, w)
				}))

				if err := verb.call(c); err == nil {
					t.Fatal("want an error")
				}
				if hits.Load() != 1 || len(*waits) != 0 {
					t.Fatalf("got %d requests and %d waits, want 1 and 0", hits.Load(), len(*waits))
				}
			})
		}
	}
}

// TestSend_ReadIsRetriedWhenThereIsNoAnswer: a read whose connection is dropped is sent again.
func TestSend_ReadIsRetriedWhenThereIsNoAnswer(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			dropConnection(t, w)
			return
		}
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))

	if _, err := c.GetRunners(); err != nil {
		t.Fatalf("want the third attempt's answer, got %v", err)
	}
	if hits.Load() != 3 || len(*waits) != 2 {
		t.Fatalf("got %d requests and %d waits, want 3 and 2", hits.Load(), len(*waits))
	}
}

// TestSend_NoAnswerIsATransportErrorFromEveryVerb: when the control plane cannot be reached, every
// place a request leaves the client returns the typed error, with the message it always had.
func TestSend_NoAnswerIsATransportErrorFromEveryVerb(t *testing.T) {
	for _, verb := range everyVerb {
		t.Run(verb.name, func(t *testing.T) {
			isolateConfigDir(t)
			err := verb.call(newDeadClient(t))
			var transport *TransportError
			if !errors.As(err, &transport) {
				t.Fatalf("want a *TransportError, got %T: %v", err, err)
			}
			if !strings.Contains(err.Error(), "failed to send request: ") {
				t.Errorf("message lost its prefix: %v", err)
			}
		})
	}
}

// TestSend_RetryAfterIsHonoured: the server's wait replaces the client's backoff.
func TestSend_RetryAfterIsHonoured(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))

	if _, err := c.GetRunners(); err != nil {
		t.Fatalf("want the second attempt's answer, got %v", err)
	}
	if len(*waits) != 1 || (*waits)[0] != 7*time.Second {
		t.Fatalf("got waits %v, want exactly 7s", *waits)
	}
}

// TestSend_LongRetryAfterIsReturnedNotWaitedFor: a wait longer than the client will sit out ends
// the call, and the error carries the wait.
func TestSend_LongRetryAfterIsReturnedNotWaitedFor(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))

	_, err := c.GetRunners()
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.RetryAfter != time.Hour {
		t.Fatalf("want a 503 carrying a one-hour wait, got %v", err)
	}
	if hits.Load() != 1 || len(*waits) != 0 {
		t.Fatalf("got %d requests and %d waits, want 1 and 0", hits.Load(), len(*waits))
	}
}

// TestResponseError_RetryAfterOnARateLimitFromAnyVerb: a 429's wait reaches the caller of a verb
// helper, and a write that is rate limited is still sent once.
func TestResponseError_RetryAfterOnARateLimitFromAnyVerb(t *testing.T) {
	isolateConfigDir(t)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))

	for _, call := range []func() error{
		func() error { _, err := c.GetRunners(); return err },
		func() error { _, err := c.CreateBootstrapJob(); return err },
	} {
		var apiErr *APIError
		if err := call(); !errors.As(err, &apiErr) || apiErr.RetryAfter != 30*time.Second {
			t.Fatalf("want a 429 carrying a 30s wait, got %v", err)
		}
	}
	if hits.Load() != 2 {
		t.Fatalf("got %d requests, want one per call", hits.Load())
	}
}

// TestSend_TimedOutReadIsNotRetried: an attempt that used its whole timeout is the last one.
func TestSend_TimedOutReadIsNotRetried(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	release := make(chan struct{})
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		<-release
	}))
	t.Cleanup(func() { close(release) })
	c.httpClient.Timeout = 50 * time.Millisecond

	_, err := c.GetRunners()
	var transport *TransportError
	if !errors.As(err, &transport) {
		t.Fatalf("want a *TransportError, got %v", err)
	}
	if hits.Load() != 1 || len(*waits) != 0 {
		t.Fatalf("got %d requests and %d waits, want 1 and 0", hits.Load(), len(*waits))
	}
}

// TestSend_RefusedRedirectIsNotRetried: a redirect the client refuses would be refused again.
func TestSend_RefusedRedirectIsNotRetried(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(elsewhere.Close)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, elsewhere.URL+"/api/cli/runners", http.StatusFound)
	}))

	_, err := c.GetRunners()
	if err == nil || !strings.Contains(err.Error(), "refusing redirect") {
		t.Fatalf("want the redirect refusal, got %v", err)
	}
	if hits.Load() != 1 || len(*waits) != 0 {
		t.Fatalf("got %d requests and %d waits, want 1 and 0", hits.Load(), len(*waits))
	}
}

// TestSend_UntrustedCertificateIsNotRetried: a certificate the client does not trust fails the same
// way every time.
func TestSend_UntrustedCertificateIsNotRetried(t *testing.T) {
	isolateConfigDir(t)
	waits := recordWaits(t)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	// The refused handshake is the point of the test, not something to print.
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", server.URL)

	_, err := NewClient("test-token").GetRunners()
	var transport *TransportError
	if !errors.As(err, &transport) {
		t.Fatalf("want a *TransportError, got %v", err)
	}
	if len(*waits) != 0 {
		t.Fatalf("got %d waits, want none", len(*waits))
	}
}

// TestRepeatable: only the two read methods may be sent twice.
func TestRepeatable(t *testing.T) {
	want := map[string]bool{
		http.MethodGet: true, http.MethodHead: true,
		http.MethodPost: false, http.MethodPut: false, http.MethodPatch: false, http.MethodDelete: false,
	}
	for method, repeat := range want {
		req, err := http.NewRequest(method, "https://example.test/api", nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		if got := repeatable(req); got != repeat {
			t.Errorf("repeatable(%s) = %v, want %v", method, got, repeat)
		}
	}
}

// TestBackoff_StaysInsideItsBounds: every wait is between half of its ceiling and the ceiling.
func TestBackoff_StaysInsideItsBounds(t *testing.T) {
	for n := 1; n < maxAttempts; n++ {
		ceiling := retryBaseDelay << (n - 1)
		for range 500 {
			if wait := backoff(n); wait < ceiling/2 || wait > ceiling {
				t.Fatalf("backoff(%d) = %s, want between %s and %s", n, wait, ceiling/2, ceiling)
			}
		}
	}
}

// failingBody is a request body that cannot be read.
type failingBody struct{}

// Read always fails.
func (failingBody) Read([]byte) (int, error) { return 0, errors.New("unreadable") }

// TestNextAttempt: a request with no body, or one whose body can be produced again, can be sent
// again; one whose body is spent cannot.
func TestNextAttempt(t *testing.T) {
	bare, _ := http.NewRequest(http.MethodGet, "https://example.test/api", nil)
	if _, ok := nextAttempt(bare); !ok {
		t.Error("a request with no body must be repeatable")
	}

	withBody, _ := http.NewRequest(http.MethodPost, "https://example.test/api", bytes.NewBufferString("payload"))
	next, ok := nextAttempt(withBody)
	if !ok {
		t.Fatal("a request with a rewindable body must be repeatable")
	}
	if got, _ := io.ReadAll(next.Body); string(got) != "payload" {
		t.Errorf("the copy's body is %q, want the original payload", got)
	}

	spent, _ := http.NewRequest(http.MethodPost, "https://example.test/api", failingBody{})
	if _, ok := nextAttempt(spent); ok {
		t.Error("a request whose body cannot be produced again must not be repeatable")
	}

	broken, _ := http.NewRequest(http.MethodPost, "https://example.test/api", bytes.NewBufferString("payload"))
	broken.GetBody = func() (io.ReadCloser, error) { return nil, errors.New("gone") }
	if _, ok := nextAttempt(broken); ok {
		t.Error("a request whose GetBody fails must not be repeatable")
	}
}

// --- Credential renewal ---

// TestSend_RenewsTheCredentialOnceOnA401: a 401 is answered by renewing the token and sending the
// same request again, with its body intact, for a read and for a write.
func TestSend_RenewsTheCredentialOnceOnA401(t *testing.T) {
	calls := []struct {
		name string
		call func(*Client) error
		body string
	}{
		{"read", func(c *Client) error { _, err := c.GetRunners(); return err }, ""},
		{"write", func(c *Client) error { _, err := c.RegisterRunner("r1", "ci1"); return err }, `"name":"r1"`},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			isolateConfigDir(t)
			resetTransportSettings(t)
			var renewals, hits atomic.Int32
			SetTokenRefresher(func() (string, error) {
				renewals.Add(1)
				return "renewed-token", nil
			})
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), tc.body) {
					t.Errorf("request %d carried body %q, want it to contain %q", hits.Load(), body, tc.body)
				}
				if r.Header.Get("Authorization") != "Bearer renewed-token" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				_, _ = io.WriteString(w, `{"runners":[],"runner_id":"r1"}`)
			}))

			if err := tc.call(c); err != nil {
				t.Fatalf("want the answer to the renewed request, got %v", err)
			}
			if renewals.Load() != 1 || hits.Load() != 2 {
				t.Fatalf("got %d renewals and %d requests, want 1 and 2", renewals.Load(), hits.Load())
			}
			// The client keeps the renewed token: its next call does not meet the 401 again.
			if err := tc.call(c); err != nil || renewals.Load() != 1 || hits.Load() != 3 {
				t.Fatalf("second call: err %v, %d renewals, %d requests; want nil, 1, 3", err, renewals.Load(), hits.Load())
			}
		})
	}
}

// TestSend_A401IsReturnedWhenRenewalCannotHelp: with no refresher, a refresher that fails, one that
// returns nothing or the refused token again, or a control plane that refuses the renewed token
// too, the caller gets the 401 and the refresher has run at most once.
func TestSend_A401IsReturnedWhenRenewalCannotHelp(t *testing.T) {
	cases := []struct {
		name         string
		refresh      func() (string, error)
		wantRequests int32
	}{
		{"no refresher", nil, 1},
		{"refresher fails", func() (string, error) { return "", errors.New("refresh token expired") }, 1},
		{"refresher returns nothing", func() (string, error) { return "", nil }, 1},
		{"refresher returns the refused token", func() (string, error) { return "test-token", nil }, 1},
		{"renewed token refused too", func() (string, error) { return "renewed-token", nil }, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateConfigDir(t)
			resetTransportSettings(t)
			var renewals, hits atomic.Int32
			if tc.refresh != nil {
				SetTokenRefresher(func() (string, error) {
					renewals.Add(1)
					return tc.refresh()
				})
			}
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				w.WriteHeader(http.StatusUnauthorized)
			}))

			_, err := c.GetRunners()
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnauthorized {
				t.Fatalf("want a 401 APIError, got %v", err)
			}
			if hits.Load() != tc.wantRequests || renewals.Load() > 1 {
				t.Fatalf("got %d requests and %d renewals, want %d and at most 1", hits.Load(), renewals.Load(), tc.wantRequests)
			}
		})
	}
}

// TestSetTokenRefresher_NilRemovesIt: a refresher that was removed is not called.
func TestSetTokenRefresher_NilRemovesIt(t *testing.T) {
	isolateConfigDir(t)
	resetTransportSettings(t)
	SetTokenRefresher(func() (string, error) {
		t.Error("a removed refresher was called")
		return "renewed-token", nil
	})
	SetTokenRefresher(nil)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	if _, err := c.GetRunners(); err == nil {
		t.Fatal("want the 401")
	}
}

// --- Identity headers ---

// TestSend_VersionHeadersOnEveryRequest: once the CLI has named its build, every place a request
// leaves the client carries both headers.
func TestSend_VersionHeadersOnEveryRequest(t *testing.T) {
	wantAgent := "alethia-cli/1.4.2 (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
	for _, verb := range everyVerb {
		t.Run(verb.name, func(t *testing.T) {
			isolateConfigDir(t)
			resetTransportSettings(t)
			SetCLIVersion(" 1.4.2 ")
			var seen atomic.Int32
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen.Add(1)
				if got := r.Header.Get("User-Agent"); got != wantAgent {
					t.Errorf("User-Agent = %q, want %q", got, wantAgent)
				}
				if got := r.Header.Get("X-Alethia-CLI-Version"); got != "1.4.2" {
					t.Errorf("X-Alethia-CLI-Version = %q, want 1.4.2", got)
				}
				w.WriteHeader(http.StatusTeapot)
			}))
			_ = verb.call(c)
			if seen.Load() != 1 {
				t.Fatalf("the control plane saw %d requests, want 1", seen.Load())
			}
		})
	}
}

// TestSend_NoVersionHeadersUntilTheCLINamesItself: a program that never named a CLI build does not
// claim to be one.
func TestSend_NoVersionHeadersUntilTheCLINamesItself(t *testing.T) {
	isolateConfigDir(t)
	resetTransportSettings(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Alethia-CLI-Version"); got != "" {
			t.Errorf("X-Alethia-CLI-Version = %q, want it absent", got)
		}
		if got := r.Header.Get("User-Agent"); strings.Contains(got, "alethia-cli") {
			t.Errorf("User-Agent = %q, want no CLI claim", got)
		}
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))
	if _, err := c.GetRunners(); err != nil {
		t.Fatalf("GetRunners: %v", err)
	}
}

// TestSend_AgentHeadersOnEveryRequestOnceMarked: a process `alethia mcp` started for a tool call
// marks every request it sends, wherever it leaves the client, and names the tool.
func TestSend_AgentHeadersOnEveryRequestOnceMarked(t *testing.T) {
	for _, verb := range everyVerb {
		t.Run(verb.name, func(t *testing.T) {
			isolateConfigDir(t)
			resetTransportSettings(t)
			SetAgentTool(" projects_list ")
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("X-Alethia-Agent"); got != "alethia-mcp" {
					t.Errorf("X-Alethia-Agent = %q, want alethia-mcp", got)
				}
				if got := r.Header.Get("X-Alethia-Agent-Tool"); got != "projects_list" {
					t.Errorf("X-Alethia-Agent-Tool = %q, want projects_list", got)
				}
				w.WriteHeader(http.StatusTeapot)
			}))
			_ = verb.call(c)
		})
	}
}

// TestSend_NoAgentHeadersUnlessMarked: a request made for a person carries neither header, so the
// control plane treats it as it always has.
func TestSend_NoAgentHeadersUnlessMarked(t *testing.T) {
	isolateConfigDir(t)
	resetTransportSettings(t)
	SetCLIVersion("1.4.2")
	SetAgentTool("projects_list")
	SetAgentTool("")
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range []string{"X-Alethia-Agent", "X-Alethia-Agent-Tool"} {
			if got := r.Header.Get(h); got != "" {
				t.Errorf("%s = %q, want it absent", h, got)
			}
		}
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))
	if _, err := c.GetRunners(); err != nil {
		t.Fatalf("GetRunners: %v", err)
	}
}

// --- The request log ---

// The values below are the ones the request log must never print. Each is distinct, so a leak
// names the place it came from.
const (
	secretToken         = "tok-AUTH-5f1c"
	secretRenewedToken  = "tok-RENEWED-9d2e"
	secretProviderToken = "tok-PROVIDER-77aa"
	secretCursor        = "cur-OPAQUE-31bb"
	secretRequestBody   = "req-BODY-c0de"
	secretResponseBody  = "resp-BODY-beef"
	secretCookie        = "cookie-SESSION-4242"
)

// allSecrets is every value above.
var allSecrets = []string{
	secretToken, secretRenewedToken, secretProviderToken, secretCursor,
	secretRequestBody, secretResponseBody, secretCookie,
}

// assertNoSecrets fails when the log contains any of the values it must never print.
func assertNoSecrets(t *testing.T, log string) {
	t.Helper()
	for _, secret := range allSecrets {
		if strings.Contains(log, secret) {
			t.Errorf("the request log contains %q:\n%s", secret, log)
		}
	}
}

// writeProviderToken stores a git-provider token where GetRepositories reads it from.
func writeProviderToken(t *testing.T, dir string) {
	t.Helper()
	creds := `{"provider_token":"` + secretProviderToken + `"}`
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(creds), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
}

// TestRequestLog_PrintsTheRequestAndNeverASecret drives a read with a provider token, a read with
// an opaque query value, a write with a body, and a 401 that renews the credential, then checks the
// log names each request and contains none of the secrets that passed through.
func TestRequestLog_PrintsTheRequestAndNeverASecret(t *testing.T) {
	dir := isolateConfigDir(t)
	resetTransportSettings(t)
	writeProviderToken(t, dir)
	var logged bytes.Buffer
	SetDebugOutput(&logged)
	SetCLIVersion("1.4.2")
	SetTokenRefresher(func() (string, error) { return secretRenewedToken, nil })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", "req_123")
		w.Header().Set("Set-Cookie", "session="+secretCookie)
		if r.Header.Get("Authorization") != "Bearer "+secretRenewedToken {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"`+secretResponseBody+`"}`)
			return
		}
		_, _ = io.WriteString(w, `{"note":"`+secretResponseBody+`","clusters":[],"repositories":[],"runner_id":"r1"}`)
	}))
	t.Cleanup(server.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", server.URL)
	c := NewClient(secretToken)

	if _, err := c.GetRepositories("github"); err != nil {
		t.Fatalf("GetRepositories: %v", err)
	}
	if _, err := c.GetClustersPage(PageOpts{Limit: 5, Cursor: secretCursor}); err != nil {
		t.Fatalf("GetClustersPage: %v", err)
	}
	if _, err := c.RegisterRunner(secretRequestBody, "ci1"); err != nil {
		t.Fatalf("RegisterRunner: %v", err)
	}

	got := logged.String()
	assertNoSecrets(t, got)
	for _, want := range []string{
		"debug: api > GET " + server.URL + "/api/cli/repositories/github (attempt 1 of 3)",
		"debug: api > GET " + server.URL + "/api/cli/clusters?cursor=[redacted]&limit=5 (attempt 1 of 3)",
		"debug: api > POST " + server.URL + "/api/cli/runners/register (attempt 1 of 3)",
		"debug: api >   Authorization: [redacted]",
		"debug: api >   X-Provider-Token: [redacted]",
		"debug: api >   Content-Type: application/json",
		"debug: api >   X-Alethia-Cli-Version: 1.4.2",
		"debug: api < 401 request_id=req_123 in ",
		"; credential renewed, sending again",
		"debug: api < 200 request_id=req_123 in ",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the request log is missing %q:\n%s", want, got)
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if !strings.HasPrefix(line, "debug: api ") {
			t.Errorf("a log line does not carry the log's prefix: %q", line)
		}
	}
}

// TestRequestLog_HeadersAreShownByAllowlist ranges over every header the log is allowed to show and
// over ones nobody has decided about. A header's value is printed only when its name is on the
// list, so one added to the client later is withheld by default.
func TestRequestLog_HeadersAreShownByAllowlist(t *testing.T) {
	resetTransportSettings(t)
	var logged bytes.Buffer
	SetDebugOutput(&logged)

	req, err := http.NewRequest(http.MethodGet, "https://example.test/api/cli/runners", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	for name := range loggedHeaders {
		req.Header.Set(name, "shown-"+name)
	}
	withheld := []string{"Authorization", "Cookie", "Proxy-Authorization", "X-Provider-Token", "X-Api-Key", "X-Added-Next-Year"}
	for _, name := range withheld {
		req.Header.Set(name, "hidden-"+name)
	}
	// A header written past the canonical form is matched on its canonical name.
	req.Header["x-alethia-org"] = []string{"shown-lowercase"}
	req.Header["x-provider-token"] = []string{"hidden-lowercase"}

	logRequest(req, 1)
	got := logged.String()
	for name := range loggedHeaders {
		if !strings.Contains(got, name+": shown-"+name) {
			t.Errorf("an allowlisted header is not shown: %s\n%s", name, got)
		}
	}
	for _, name := range withheld {
		if !strings.Contains(got, name+": "+redacted) {
			t.Errorf("a header off the allowlist is not listed as redacted: %s\n%s", name, got)
		}
	}
	if strings.Contains(got, "hidden-") {
		t.Errorf("a header off the allowlist had its value printed:\n%s", got)
	}
	if !strings.Contains(got, "x-alethia-org: shown-lowercase") {
		t.Errorf("a lower-case allowlisted header is not shown:\n%s", got)
	}
}

// TestLogURL: the address is printed without credentials or fragment, and a query value is printed
// only for a key on the allowlist.
func TestLogURL(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"https://example.test/api/cli/runners", "https://example.test/api/cli/runners"},
		{"https://user:" + secretToken + "@example.test:8443/api/cli/jobs?limit=20&status=RUNNING#frag", "https://example.test:8443/api/cli/jobs?limit=20&status=RUNNING"},
		{"https://example.test/api/cli/x?token=" + secretToken + "&env=prod+eu", "https://example.test/api/cli/x?env=prod+eu&token=[redacted]"},
		{"https://example.test/api/cli/x?cursor=" + secretCursor + "&cursor=" + secretCursor, "https://example.test/api/cli/x?cursor=[redacted]&cursor=[redacted]"},
		{"https://example.test/api/cli/projects/a%2Fb/components", "https://example.test/api/cli/projects/a%2Fb/components"},
	}
	for _, tc := range tests {
		u, err := url.Parse(tc.raw)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.raw, err)
		}
		got := logURL(u)
		if got != tc.want {
			t.Errorf("logURL(%q) = %q, want %q", tc.raw, got, tc.want)
		}
		assertNoSecrets(t, got)
	}
}

// TestRequestLog_NoAnswer: a round trip that got no answer is logged with the wait before the next
// attempt, and without the address the HTTP client's own error repeats.
func TestRequestLog_NoAnswer(t *testing.T) {
	isolateConfigDir(t)
	resetTransportSettings(t)
	var logged bytes.Buffer
	SetDebugOutput(&logged)
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	c := NewClient(secretToken)

	if _, err := c.GetClustersPage(PageOpts{Cursor: secretCursor}); err == nil {
		t.Fatal("want a transport error")
	}
	got := logged.String()
	assertNoSecrets(t, got)
	if n := strings.Count(got, "debug: api ! no answer in "); n != maxAttempts {
		t.Errorf("got %d failure lines, want %d:\n%s", n, maxAttempts, got)
	}
	if n := strings.Count(got, "; retrying in "); n != maxAttempts-1 {
		t.Errorf("got %d retry notices, want %d:\n%s", n, maxAttempts-1, got)
	}
	if !strings.Contains(got, "(attempt 3 of 3)") {
		t.Errorf("the last attempt is not numbered:\n%s", got)
	}
}

// TestRequestLog_TransientStatus: a retried status is logged with its wait, and an answer with no
// request id says so.
func TestRequestLog_TransientStatus(t *testing.T) {
	isolateConfigDir(t)
	resetTransportSettings(t)
	var logged bytes.Buffer
	SetDebugOutput(&logged)
	var hits atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))

	if _, err := c.GetRunners(); err != nil {
		t.Fatalf("GetRunners: %v", err)
	}
	got := logged.String()
	if !strings.Contains(got, "debug: api < 503 request_id=- in ") || !strings.Contains(got, "; retrying in 2s") {
		t.Errorf("the retried answer is not logged with its wait:\n%s", got)
	}
}

// captureStreams points the process's two standard streams at files for the length of a test and
// returns a function that reads back what was written to each.
func captureStreams(t *testing.T) func() (stdout, stderr string) {
	t.Helper()
	dir := t.TempDir()
	open := func(name string) *os.File {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		t.Cleanup(func() { _ = f.Close() })
		return f
	}
	out, errFile := open("stdout"), open("stderr")
	previousOut, previousErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = out, errFile
	t.Cleanup(func() { os.Stdout, os.Stderr = previousOut, previousErr })
	read := func(name string) string {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(data)
	}
	return func() (string, string) { return read("stdout"), read("stderr") }
}

// TestRequestLog_EnvironmentTurnsItOnAndItGoesToStderr: with the variable naming the api topic the
// log is written to standard error and nothing is written to standard output; without it, and with
// an explicit nil writer over it, nothing is written anywhere.
func TestRequestLog_EnvironmentTurnsItOnAndItGoesToStderr(t *testing.T) {
	tests := []struct {
		name    string
		env     string
		silence bool
		wantLog bool
	}{
		{"variable names the topic", "api", false, true},
		{"variable unset", "", false, false},
		{"variable names another topic", "render", false, false},
		{"explicit nil writer wins over the variable", "api", true, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			isolateConfigDir(t)
			resetTransportSettings(t)
			t.Setenv(DebugEnv, tc.env)
			if tc.silence {
				SetDebugOutput(nil)
			}
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"runners":[]}`)
			}))
			c.authToken = secretToken
			streams := captureStreams(t)

			if _, err := c.GetRunners(); err != nil {
				t.Fatalf("GetRunners: %v", err)
			}
			stdout, stderr := streams()
			if stdout != "" {
				t.Errorf("standard output is not empty: %q", stdout)
			}
			if logged := strings.Contains(stderr, "debug: api > GET "); logged != tc.wantLog {
				t.Errorf("logged on standard error = %v, want %v: %q", logged, tc.wantLog, stderr)
			}
			if !tc.wantLog && stderr != "" {
				t.Errorf("standard error is not empty: %q", stderr)
			}
			assertNoSecrets(t, stderr)
		})
	}
}

// TestDebugRequested: the variable asks for the log when it lists the api topic, lists all, or is a
// plain true.
func TestDebugRequested(t *testing.T) {
	tests := map[string]bool{
		"":           false,
		"api":        true,
		"API":        true,
		"render,api": true,
		" all ":      true,
		"1":          true,
		"true":       true,
		"0":          false,
		"false":      false,
		"render":     false,
		"apiary":     false,
	}
	for raw, want := range tests {
		if got := DebugRequested(raw); got != want {
			t.Errorf("DebugRequested(%q) = %v, want %v", raw, got, want)
		}
	}
}
