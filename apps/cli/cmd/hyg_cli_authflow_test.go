// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/golang-jwt/jwt/v5"
)

// --- lane fixtures -----------------------------------------------------------
//
// Every identifier here carries the hygCliAuthflow prefix so it cannot collide
// with another lane's helpers in this package.

// hygCliAuthflowHome points the user config dir at a fresh temp dir and returns the
// resolved credentials path (with its parent directory created).
func hygCliAuthflowHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	p, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("creds path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return p
}

// hygCliAuthflowToken returns a signed JWT with the given expiry. The CLI parses
// tokens unverified, so the signing key is irrelevant here.
func hygCliAuthflowToken(t *testing.T, exp time.Time) string {
	t.Helper()
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"exp": exp.Unix(), "sub": "u1",
	}).SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return s
}

// hygCliAuthflowMode reports the permission bits of path.
func hygCliAuthflowMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return st.Mode().Perm()
}

// hygCliAuthflowFastPoll shrinks the poll interval and the overall poll budget so a
// terminating-loop test runs in milliseconds instead of minutes.
func hygCliAuthflowFastPoll(t *testing.T, interval, throttle, budget time.Duration) {
	t.Helper()
	prevI, prevT, prevB := loginPollInterval, loginPollThrottleInterval, loginPollTimeout
	loginPollInterval, loginPollThrottleInterval, loginPollTimeout = interval, throttle, budget
	t.Cleanup(func() {
		loginPollInterval, loginPollThrottleInterval, loginPollTimeout = prevI, prevT, prevB
	})
}

// hygCliAuthflowServer starts a fake control plane and points the CLI at it.
func hygCliAuthflowServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	return srv
}

// hygCliAuthflowCaptureStdout runs fn with os.Stdout redirected to a pipe and returns
// everything it printed.
func hygCliAuthflowCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	fn()
	os.Stdout = prev
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// --- #2017 · the credentials file must not be world-readable -----------------

// TestHygCliAuthflowCredentialsAreOwnerOnly pins that both writers of
// credentials.json — saveTokens on the login path and saveCredentials on the token
// refresh path — leave the file holding the live bearer, the 90-day refresh token
// and the git provider token readable by its owner only, and that they REPAIR a
// file an older CLI left loose rather than inheriting its mode.
func TestHygCliAuthflowCredentialsAreOwnerOnly(t *testing.T) {
	t.Run("saveTokens creates 0600", func(t *testing.T) {
		credsPath := hygCliAuthflowHome(t)
		saveTokens(&types.ExchangeResponse{
			AccessToken: "eyJ-live-bearer", RefreshToken: "live-refresh", UserEmail: "x@y.com",
		})
		if got := hygCliAuthflowMode(t, credsPath); got != credentialsFileMode {
			t.Errorf("credentials.json mode = %#o, want %#o", got, credentialsFileMode)
		}
	})

	t.Run("saveCredentials creates 0600", func(t *testing.T) {
		credsPath := hygCliAuthflowHome(t)
		if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: "a"}); err != nil {
			t.Fatalf("saveCredentials: %v", err)
		}
		if got := hygCliAuthflowMode(t, credsPath); got != credentialsFileMode {
			t.Errorf("credentials.json mode = %#o, want %#o", got, credentialsFileMode)
		}
	})

	// The umask makes a fresh-file assertion environment-dependent, so prove the
	// tightening deterministically: plant a world-readable/writable file first,
	// assert the precondition, then write through each path.
	for name, write := range map[string]func(string){
		"saveTokens": func(p string) {
			saveTokens(&types.ExchangeResponse{AccessToken: "a", RefreshToken: "r"})
		},
		"saveCredentials": func(p string) {
			if err := saveCredentials(p, types.ExchangeResponse{AccessToken: "a"}); err != nil {
				t.Fatalf("saveCredentials: %v", err)
			}
		},
	} {
		t.Run(name+" tightens an existing loose file", func(t *testing.T) {
			credsPath := hygCliAuthflowHome(t)
			if err := os.WriteFile(credsPath, []byte("{}"), 0o666); err != nil {
				t.Fatalf("plant: %v", err)
			}
			if err := os.Chmod(credsPath, 0o666); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			if got := hygCliAuthflowMode(t, credsPath); got != 0o666 {
				t.Fatalf("precondition: planted mode = %#o, want 0666", got)
			}
			write(credsPath)
			if got := hygCliAuthflowMode(t, credsPath); got != credentialsFileMode {
				t.Errorf("mode after write = %#o, want %#o", got, credentialsFileMode)
			}
		})
	}
}

// --- #2018 · a 2xx with no access_token must fail closed ---------------------

// TestHygCliAuthflowRefreshRejectsEmptyAccessToken pins that a 2xx refresh response
// carrying no access_token is an error, not a success — and, crucially, that the
// stored credential survives it. Before the fix refreshAccessToken returned
// ("", nil), getAuthTokenInternal took its success branch and saveCredentials wrote
// the empty token over the user's valid refresh token.
func TestHygCliAuthflowRefreshRejectsEmptyAccessToken(t *testing.T) {
	credsPath := hygCliAuthflowHome(t)
	hygCliAuthflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		// A 2xx that does not populate access_token: a captive portal, a proxy, a
		// schema change. The CLI must not treat it as a refreshed session.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token_type":"bearer"}`))
	})

	if _, err := refreshAccessToken("refresh-tok"); err == nil {
		t.Error("refreshAccessToken accepted a 2xx response carrying no access_token")
	}

	expired := hygCliAuthflowToken(t, time.Now().Add(-time.Hour))
	stored := types.ExchangeResponse{AccessToken: expired, RefreshToken: "refresh-tok", UserEmail: "x@y.com"}
	if err := saveCredentials(credsPath, stored); err != nil {
		t.Fatal(err)
	}
	// Precondition: the credential we are about to protect is really on disk.
	before, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(before), "refresh-tok") {
		t.Fatalf("precondition: stored credential missing the refresh token: %s", before)
	}

	if _, err := getAuthTokenInternal(false); err == nil {
		t.Error("getAuthTokenInternal returned success after a refresh that produced no token")
	}

	after, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	var got types.ExchangeResponse
	if err := json.Unmarshal(after, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.AccessToken != expired || got.RefreshToken != "refresh-tok" {
		t.Errorf("stored credential was overwritten by the failed refresh: %+v", got)
	}
}

// --- #2044 · the poll loop must terminate ------------------------------------

// TestHygCliAuthflowPollForTokenHonoursOverallDeadline pins that a control plane
// which answers "pending" forever no longer hangs `alethia login`: the poll gives up
// once loginPollTimeout elapses. Before the fix the only timeout was per-request, so
// the loop retried indefinitely and the process had to be killed.
func TestHygCliAuthflowPollForTokenHonoursOverallDeadline(t *testing.T) {
	hygCliAuthflowFastPoll(t, time.Millisecond, time.Millisecond, 30*time.Millisecond)

	var polls atomic.Int32
	srv := hygCliAuthflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"pending"}`))
	})

	done := make(chan tea.Msg, 1)
	go func() { done <- pollForToken("device-code", srv.URL+"/api/auth/cli/exchange")() }()

	select {
	case msg := <-done:
		bad, is := msg.(authErrorMsg)
		if !is {
			t.Fatalf("msg = %#v, want authErrorMsg", msg)
		}
		if !strings.Contains(bad.err.Error(), "timed out") {
			t.Errorf("error should name the timeout, got %v", bad.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pollForToken never returned: the poll loop is still unbounded")
	}
	// Precondition for the assertion above: the loop really did poll and retry,
	// so it stopped on the deadline rather than on the first response.
	if got := polls.Load(); got < 2 {
		t.Errorf("expected the poll to retry before the deadline, got %d polls", got)
	}
}

// TestHygCliAuthflowPollForTokenBacksOffOn429 pins that a throttled poll (429) is
// treated as "keep waiting", not as a fatal error. pollForToken used to treat any
// non-404 as fatal, so the new rate limit on the exchange route would have killed a
// perfectly legitimate login.
func TestHygCliAuthflowPollForTokenBacksOffOn429(t *testing.T) {
	hygCliAuthflowFastPoll(t, time.Millisecond, 2*time.Millisecond, 5*time.Second)

	var calls atomic.Int32
	srv := hygCliAuthflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"slow_down"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(types.ExchangeResponse{
			AccessToken: "access-tok", RefreshToken: "refresh-tok", UserEmail: "ada@x.com",
		})
	})

	msg := pollForToken("device-code", srv.URL+"/api/auth/cli/exchange")()
	ok, is := msg.(authSuccessMsg)
	if !is {
		t.Fatalf("msg = %#v, want authSuccessMsg — a 429 must not kill the login", msg)
	}
	if ok.response.UserEmail != "ada@x.com" {
		t.Errorf("response = %+v", ok.response)
	}
	if got := calls.Load(); got != 3 {
		t.Errorf("expected 3 polls (two throttled), got %d", got)
	}
}

// TestHygCliAuthflowPollForTokenReportsGone pins that a 410 — the status the console
// now returns for an expired or already-redeemed device code — surfaces as a clear
// terminal message telling the user to log in again.
func TestHygCliAuthflowPollForTokenReportsGone(t *testing.T) {
	srv := hygCliAuthflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte(`{"error":"expired_token"}`))
	})

	msg := pollForToken("device-code", srv.URL+"/api/auth/cli/exchange")()
	bad, is := msg.(authErrorMsg)
	if !is {
		t.Fatalf("msg = %#v, want authErrorMsg", msg)
	}
	for _, want := range []string{"expired", "alethia login", "expired_token"} {
		if !strings.Contains(bad.err.Error(), want) {
			t.Errorf("410 message should contain %q, got %v", want, bad.err)
		}
	}
}

// --- #2213 · the RFC 8628 user_code ------------------------------------------

// hygCliAuthflowUserCodePattern is the shape the console page validates against.
var hygCliAuthflowUserCodePattern = regexp.MustCompile(`^[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}$`)

// TestHygCliAuthflowUserCodeShape pins the user_code contract the console depends on:
// an unambiguous alphabet (no 0/O, 1/I/L), a fixed hyphenated shape, and a fresh
// value per call.
func TestHygCliAuthflowUserCodeShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code := newUserCode()
		if !hygCliAuthflowUserCodePattern.MatchString(code) {
			t.Fatalf("user_code %q does not match the RFC 8628 shape", code)
		}
		if strings.ContainsAny(code, "0O1IL") {
			t.Fatalf("user_code %q contains an ambiguous character", code)
		}
		if url.QueryEscape(code) != code {
			t.Fatalf("user_code %q is not URL-safe", code)
		}
		seen[code] = true
	}
	if len(seen) < 100 {
		t.Errorf("user_code is not random enough: %d distinct values in 200 draws", len(seen))
	}
}

// TestHygCliAuthflowLoginPrintsAndSendsUserCode pins the CLI half of the takeover
// fix: the device-login URL carries a user_code AND the terminal prints the same
// code, so the browser has something to display and the user something to compare
// it against. Before the fix the URL carried only a client-chosen device_code and
// the page approved it on mount, with nothing for the user to check.
func TestHygCliAuthflowLoginPrintsAndSendsUserCode(t *testing.T) {
	hygCliAuthflowHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	hygCliAuthflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(types.ExchangeResponse{
			AccessToken: "access-tok", RefreshToken: "refresh-tok", UserEmail: "ada@x.com",
		})
	})

	var opened string
	prevBrowser, prevOpts := openBrowser, loginProgramOptions
	openBrowser = func(u string) error { opened = u; return nil }
	loginProgramOptions = []tea.ProgramOption{
		tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutSignalHandler(),
	}
	t.Cleanup(func() { openBrowser, loginProgramOptions = prevBrowser, prevOpts })

	var flowErr error
	printed := hygCliAuthflowCaptureStdout(t, func() { flowErr = performLoginFlow() })
	if flowErr != nil {
		t.Fatalf("performLoginFlow: %v", flowErr)
	}

	parsed, err := url.Parse(opened)
	if err != nil {
		t.Fatalf("parse login URL %q: %v", opened, err)
	}
	if parsed.Query().Get("device_code") == "" {
		t.Errorf("login URL carries no device_code: %s", opened)
	}
	userCode := parsed.Query().Get("user_code")
	if !hygCliAuthflowUserCodePattern.MatchString(userCode) {
		t.Fatalf("login URL carries no well-formed user_code: %s", opened)
	}
	if !strings.Contains(printed, userCode) {
		t.Errorf("the terminal never printed the user_code %q it sent to the browser:\n%s", userCode, printed)
	}
}
