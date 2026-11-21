// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The three switches the CLI throws on the API client — the request log, the version headers and
// the credential renewal — driven through the command tree, so each test fails when the wiring in
// root.go, printer.go or auth_utils.go is removed, not only when the client misbehaves.

// The values a test must never find in what the CLI printed.
const (
	wiringTokenCanary  = "supplied-token-canary-4d81e6"
	wiringCookieCanary = "cookie-canary-a07f53"
	wiringBodyCanary   = "body-secret-canary-9c2e17"
)

// headerRecorder is a control plane that answers whoami and keeps the headers of every request.
type headerRecorder struct {
	mu      sync.Mutex
	headers []http.Header
}

// newHeaderRecorder starts the recorder and points the CLI at it with a supplied token. Its whoami
// answer carries wiringBodyCanary, so a log that wrote response bodies would be caught.
func newHeaderRecorder(t *testing.T) *headerRecorder {
	t.Helper()
	isolatedHome(t)
	rec := &headerRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		rec.headers = append(rec.headers, r.Header.Clone())
		rec.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "session="+wiringCookieCanary)
		w.Header().Set("X-Request-Id", "req-wiring-1")
		_, _ = w.Write([]byte(`{"user":{"id":"u1","email":"ada@x.com","name":"` + wiringBodyCanary + `"}}`))
	}))
	t.Cleanup(srv.Close)
	authCovOrigin(t, srv.URL)
	t.Setenv(ServiceTokenEnv, wiringTokenCanary)
	t.Setenv(DebugEnv, "")
	t.Cleanup(func() { api.SetDebugOutput(nil) })
	return rec
}

// requests returns the headers of every request received so far.
func (r *headerRecorder) requests() []http.Header {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]http.Header{}, r.headers...)
}

// TestTransportWiring_EveryRequestNamesTheCLIBuild pins SetCLIVersion in root.go: a command's
// request carries the build in both headers.
func TestTransportWiring_EveryRequestNamesTheCLIBuild(t *testing.T) {
	rec := newHeaderRecorder(t)
	_, stderr, code := authRun(t, "whoami", "-o", "json")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	got := rec.requests()
	if len(got) == 0 {
		t.Fatal("the command sent no request")
	}
	wantAgent := "alethia-cli/" + version.Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
	for i, h := range got {
		if ua := h.Get("User-Agent"); ua != wantAgent {
			t.Errorf("request %d: User-Agent = %q, want %q", i, ua, wantAgent)
		}
		if v := h.Get("X-Alethia-CLI-Version"); v != version.Version {
			t.Errorf("request %d: X-Alethia-CLI-Version = %q, want %q", i, v, version.Version)
		}
	}
}

// TestTransportWiring_DebugLogsRequestsOnStderrOnly pins SetDebugOutput: --debug and ALETHIA_DEBUG
// each turn the request log on, it lands on stderr and never on stdout, and it carries neither the
// token, nor a cookie, nor a response body.
func TestTransportWiring_DebugLogsRequestsOnStderrOnly(t *testing.T) {
	cases := []struct {
		name string
		env  string
		args []string
	}{
		{"the --debug flag", "", []string{"whoami", "-o", "json", "--debug"}},
		{"ALETHIA_DEBUG=api", "api", []string{"whoami", "-o", "json"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			newHeaderRecorder(t)
			// The mode reads its environment through lookupEnv, which the suite empties. Only that
			// lookup carries the value, never the process environment, so the API client's own
			// fallback cannot be what turns the log on: without the wiring, this fails.
			modeEnv(t, map[string]string{DebugEnv: tc.env})
			stdout, stderr, code := authRun(t, tc.args...)
			if code != 0 {
				t.Fatalf("whoami exited %d\n%s", code, stderr)
			}
			// The log has to be there, or every assertion below would pass on silence.
			for _, want := range []string{
				"debug: api > GET ",
				"/api/cli/whoami",
				"Authorization: [redacted]",
				"X-Alethia-Cli-Version: " + version.Version,
				"debug: api < 200 request_id=req-wiring-1",
			} {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr has no %q:\n%s", want, stderr)
				}
			}
			if strings.Contains(stdout, "debug:") {
				t.Errorf("the request log reached stdout: %q", stdout)
			}
			if !strings.Contains(stdout, wiringBodyCanary) {
				t.Errorf("the result is not on stdout, so the stream split is untested: %q", stdout)
			}
			if found := leaked([]string{wiringTokenCanary, wiringCookieCanary, wiringBodyCanary}, stderr); len(found) > 0 {
				t.Errorf("the request log printed %d value(s) it must withhold: %v", len(found), found)
			}
		})
	}
}

// TestTransportWiring_NoDebugNoLog pins the off arm: without --debug or ALETHIA_DEBUG nothing is
// logged, even directly after a run that asked for the log.
func TestTransportWiring_NoDebugNoLog(t *testing.T) {
	newHeaderRecorder(t)
	if _, stderr, code := authRun(t, "whoami", "-o", "json", "--debug"); code != 0 || !strings.Contains(stderr, "debug: api") {
		t.Fatalf("the --debug run did not log (exit %d):\n%s", code, stderr)
	}
	_, stderr, code := authRun(t, "whoami", "-o", "json")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	if strings.Contains(stderr, "debug:") {
		t.Errorf("a run without --debug inherited the request log:\n%s", stderr)
	}
}

// storeExpiringCredential writes a stored sign-in for the fake whose access token is still live by
// its expiry but which the fake refuses, and returns that access token.
func storeExpiringCredential(t *testing.T, fake *authFake, credsPath string) string {
	t.Helper()
	refused := makeToken(t, time.Now().Add(time.Hour))
	cred := storedCredential{
		ExchangeResponse: types.ExchangeResponse{
			AccessToken: refused, RefreshToken: keychainRefreshCanary,
			ProviderToken: keychainProviderCanary, UserEmail: "ada@x.com",
		},
		Origin: normalizeOrigin(fake.srv.URL),
	}
	if err := writeCredentialFile(credsPath, cred); err != nil {
		t.Fatalf("write the stored credential: %v", err)
	}
	return refused
}

// TestTransportWiring_A401RenewsTheStoredCredentialOnceAndResends pins SetTokenRefresher in
// auth_utils.go: a stored credential the control plane refuses mid-command is renewed once, the
// same request is sent again with the new token, the command succeeds, and the debug log of it
// carries none of the credentials.
func TestTransportWiring_A401RenewsTheStoredCredentialOnceAndResends(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	t.Setenv(DebugEnv, "")
	t.Cleanup(func() { api.SetDebugOutput(nil) })
	refused := storeExpiringCredential(t, fake, credsPath)
	renewed := fake.renews(t)

	stdout, stderr, code := authRun(t, "whoami", "-o", "json", "--debug")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	refresh, whoami := fake.counts()
	if refresh != 1 || whoami != 2 {
		t.Errorf("refresh requests = %d, whoami requests = %d; want 1 and 2", refresh, whoami)
	}
	if !strings.Contains(stdout, "ada@x.com") {
		t.Errorf("the resent request's answer is not the result: %q", stdout)
	}
	if !strings.Contains(stderr, "credential renewed, sending again") {
		t.Errorf("the request log does not show the renewal:\n%s", stderr)
	}
	if found := leaked([]string{refused, renewed, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("the renewal printed %d credential(s)", len(found))
	}
}

// TestTransportWiring_ASuppliedTokenIsNeverRenewed pins the other arm: a token the caller supplied
// has nothing to renew it with, so a 401 is the answer — no refresh request, one whoami request,
// and the authentication exit code.
func TestTransportWiring_ASuppliedTokenIsNeverRenewed(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	storeExpiringCredential(t, fake, credsPath)
	fake.renews(t)
	t.Setenv(ServiceTokenEnv, wiringTokenCanary)

	stdout, stderr, code := authRun(t, "whoami", "-o", "json")
	if code != clierr.ExitAuth {
		t.Errorf("exit = %d, want %d\n%s", code, clierr.ExitAuth, stderr)
	}
	refresh, whoami := fake.counts()
	if refresh != 0 || whoami != 1 {
		t.Errorf("refresh requests = %d, whoami requests = %d; want 0 and 1", refresh, whoami)
	}
	if stdout != "" {
		t.Errorf("a refusal wrote on stdout: %q", stdout)
	}
}
