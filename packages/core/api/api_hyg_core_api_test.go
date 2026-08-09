// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --- #2045: every control-plane request is bounded ---

// TestHygCoreAPI_NewClientBoundsEveryRequest pins the fix: the client NewClient hands out carries a
// non-zero Timeout, which is what bounds dial, TLS, write, response header and body read. A zero
// Timeout — what shipped before #2045 — means "wait forever".
func TestHygCoreAPI_NewClientBoundsEveryRequest(t *testing.T) {
	client := NewClient("test-token")

	if client.httpClient.Timeout == 0 {
		t.Fatal("the control-plane client has NO timeout: a server that accepts the connection and never answers hangs the command forever")
	}
	if client.httpClient.Timeout != requestTimeout {
		t.Errorf("expected the documented %s bound, got %s", requestTimeout, client.httpClient.Timeout)
	}
}

// TestHygCoreAPI_StalledControlPlaneGivesUp proves the bound is real and not merely set: a handler
// that never writes a response makes the call return an error rather than block.
//
// The 50ms is a deliberate mutation AFTER the precondition below is asserted — the shipped 60s is
// sized for a cloud health probe the server runs inline, not for a unit test. The release channel
// exists because httptest.Server.Close blocks until every handler has returned and a CLIENT-side
// timeout does not cancel the SERVER's request context; a handler parked on r.Context().Done()
// alone wedges Close for the whole package timeout.
func TestHygCoreAPI_StalledControlPlaneGivesUp(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); srv.Close() })
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)

	client := NewClient("test-token")
	if client.httpClient.Timeout == 0 {
		t.Fatal("precondition: the client must arrive with a timeout, otherwise this test proves nothing")
	}
	client.httpClient.Timeout = 50 * time.Millisecond

	start := time.Now()
	_, err := client.GetRunners()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("expected the client to give up on a stalled control plane, but it waited %s and succeeded", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Errorf("the client waited %s before giving up; the timeout is not bounding the request", elapsed)
	}
}

// --- #2046: no verb may return a non-nil error with an empty message ---

// hygCoreAPIVerbs is every helper that turns a non-success response into an error. Kept local to
// this file so the lane owns it.
var hygCoreAPIVerbs = []struct {
	name string
	call func(*Client) error
}{
	{name: "doGet", call: func(c *Client) error { _, err := c.GetRunners(); return err }},
	{name: "doPost", call: func(c *Client) error { _, err := c.CreateBootstrapJob(); return err }},
	{name: "doPut", call: func(c *Client) error { _, err := c.SetFleetPool("aws", FleetPoolUpdate{}); return err }},
	{name: "doDelete", call: func(c *Client) error { return c.DeleteRole("r1") }},
	{name: "GetRepositories", call: func(c *Client) error { _, err := c.GetRepositories("github"); return err }},
}

// TestHygCoreAPI_ErrorBodyWithoutErrorKeyKeepsReasonAndStatus is the #2046 regression. A well-formed
// JSON body carrying `message` rather than `error` — what a Next.js route handler and any fronting
// proxy emit — used to decode cleanly into "" and surface as `failed to get runners: `, with the
// status code thrown away too.
func TestHygCoreAPI_ErrorBodyWithoutErrorKeyKeepsReasonAndStatus(t *testing.T) {
	for _, tt := range hygCoreAPIVerbs {
		t.Run(tt.name, func(t *testing.T) {
			isolateConfigDir(t)
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				w.Write([]byte(`{"message":"forbidden: missing permission runner:read"}`))
			}))

			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error for a 403 response")
			}
			if !strings.Contains(err.Error(), "403") {
				t.Errorf("the status code was discarded: %q", err.Error())
			}
			if !strings.Contains(err.Error(), "missing permission runner:read") {
				t.Errorf("the server's own explanation was discarded: %q", err.Error())
			}
		})
	}
}

// TestHygCoreAPI_NoVerbEverReturnsAnEmptyMessage walks the bodies that used to produce a non-nil
// error rendering as nothing at all, and asserts every verb still says something.
func TestHygCoreAPI_NoVerbEverReturnsAnEmptyMessage(t *testing.T) {
	bodies := []struct {
		name string
		body string
	}{
		{name: "json without an error key", body: `{"message":""}`},
		{name: "json with an empty error key", body: `{"error":""}`},
		{name: "json with unrelated keys", body: `{"code":"E_NOPE"}`},
		{name: "empty body", body: ""},
		{name: "whitespace body", body: "  \n\t "},
		{name: "html body", body: "<html><body>502 Bad Gateway</body></html>"},
	}

	for _, b := range bodies {
		for _, tt := range hygCoreAPIVerbs {
			t.Run(b.name+"/"+tt.name, func(t *testing.T) {
				isolateConfigDir(t)
				client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(http.StatusInternalServerError)
					w.Write([]byte(b.body))
				}))

				err := tt.call(client)
				if err == nil {
					t.Fatal("expected an error for a 500 response")
				}
				if strings.TrimSpace(err.Error()) == "" {
					t.Fatal("the verb returned a non-nil error that renders as nothing")
				}
				if !strings.Contains(err.Error(), "500") {
					t.Errorf("expected the status code in %q", err.Error())
				}
			})
		}
	}
}

// TestHygCoreAPI_ResponseErrorMessageSources pins the precedence of the keys responseError reads and
// the fallback when none of them carries text.
func TestHygCoreAPI_ResponseErrorMessageSources(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "error wins", body: `{"error":"first","message":"second","error_description":"third"}`, want: "first"},
		{name: "message when error is absent", body: `{"message":"second","error_description":"third"}`, want: "second"},
		{name: "error_description last", body: `{"error":"  ","error_description":"third"}`, want: "third"},
		{name: "snippet when no key carries text", body: `{"detail":"nothing usable"}`, want: `{"detail":"nothing usable"}`},
		{name: "snippet collapses whitespace", body: "<html>\n\n  upstream   died\t</html>", want: "<html> upstream died </html>"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
				w.Write([]byte(tt.body))
			}))

			_, err := client.GetRunners()
			if err == nil {
				t.Fatal("expected an error for a 502 response")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("expected %q in %q", tt.want, err.Error())
			}
		})
	}
}

// TestHygCoreAPI_EmptyBodyStillNamesTheStatus covers APIError.Error's empty-message branch: when the
// body carried nothing at all the status code is the whole message, and it is never blank.
func TestHygCoreAPI_EmptyBodyStillNamesTheStatus(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))

	_, err := client.GetRunners()
	if err == nil {
		t.Fatal("expected an error for a 401 response")
	}
	if got, want := err.Error(), "request failed with status 401"; !strings.Contains(got, want) {
		t.Errorf("expected %q in %q", want, got)
	}
}

// TestHygCoreAPI_LongErrorBodyIsTruncated covers the snippet's truncation branch. A fronting proxy
// can stream megabytes at a 502; the message must stay one readable line.
func TestHygCoreAPI_LongErrorBodyIsTruncated(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html>" + strings.Repeat("A", 200_000) + "</html>"))
	}))

	_, err := client.GetRunners()
	if err == nil {
		t.Fatal("expected an error for a 502 response")
	}
	if n := len([]rune(err.Error())); n > errorSnippetRunes+64 {
		t.Errorf("the error message is %d runes; the body snippet is not bounded", n)
	}
	if !strings.HasSuffix(strings.TrimSuffix(err.Error(), " (status 502)"), "…") {
		t.Errorf("expected a truncation marker in %q", err.Error())
	}
}

// TestHygCoreAPI_MultibyteBodyIsNotSplit proves the truncation cuts on runes: a body of multibyte
// characters must not leave a broken UTF-8 sequence in the message.
func TestHygCoreAPI_MultibyteBodyIsNotSplit(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(strings.Repeat("é", 400)))
	}))

	_, err := client.GetRunners()
	if err == nil {
		t.Fatal("expected an error for a 502 response")
	}
	if strings.ContainsRune(err.Error(), '�') {
		t.Errorf("truncation split a UTF-8 sequence: %q", err.Error())
	}
}

// TestHygCoreAPI_StatusCodeIsRecoverableWithErrorsAs is the point of the typed error: a caller can
// tell an expired token from a missing permission from a server fault, through the caller's own
// prefix, without matching on a message.
func TestHygCoreAPI_StatusCodeIsRecoverableWithErrorsAs(t *testing.T) {
	tests := []struct {
		name string
		call func(*Client) error
		want int
	}{
		{name: "doGet", call: func(c *Client) error { _, err := c.GetConfigurations(); return err }, want: http.StatusUnauthorized},
		{name: "GetRepositories", call: func(c *Client) error { _, err := c.GetRepositories("github"); return err }, want: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateConfigDir(t)
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"token expired"}`))
			}))

			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error for a 401 response")
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("expected an *APIError to survive the caller's prefix, got %q", err.Error())
			}
			if apiErr.StatusCode != tt.want {
				t.Errorf("expected status %d, got %d", tt.want, apiErr.StatusCode)
			}
			if apiErr.Message != "token expired" {
				t.Errorf("expected the server message, got %q", apiErr.Message)
			}
		})
	}
}

// --- verb helpers reached directly, for the paths no exported call can produce ---

// TestHygCoreAPI_UnmarshalablePayloadIsReported covers doPost's and doPut's marshal-failure arms. No
// exported method can reach them — every one of them builds its own serialisable payload — so the
// helpers are called directly with a channel, which encoding/json refuses.
func TestHygCoreAPI_UnmarshalablePayloadIsReported(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request must never leave the client when the payload cannot be marshalled")
	}))

	tests := []struct {
		name string
		call func() error
	}{
		{name: "doPost", call: func() error { return client.doPost(client.baseURL+"/cli/x", make(chan int), nil) }},
		{name: "doPut", call: func() error { return client.doPut(client.baseURL+"/cli/x", make(chan int), nil) }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			if err == nil {
				t.Fatal("expected a marshal error")
			}
			if !strings.Contains(err.Error(), "failed to marshal request body") {
				t.Errorf("expected a marshal error, got %q", err.Error())
			}
		})
	}
}

// TestHygCoreAPI_DoPutDiscardsTheBodyWhenNoResultIsWanted covers doPut's nil-result return, the arm
// taken by every caller that only wants the status.
func TestHygCoreAPI_DoPutDiscardsTheBodyWhenNoResultIsWanted(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		w.Write([]byte(`{"ignored":true}`))
	}))

	if err := client.doPut(client.baseURL+"/cli/x", map[string]string{"a": "b"}, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
