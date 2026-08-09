// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRedirectDoesNotLeakProviderTokenToForeignHost is #2024's repro, kept.
//
// Go strips Authorization/Www-Authenticate/Cookie on a cross-host redirect and NOTHING else, so
// X-Provider-Token — the user's GitHub/GitLab OAuth token — was copied verbatim to whatever host a
// 3xx pointed at. The assertion is on what the foreign host actually RECEIVED, not on the client's
// return value: a fix that merely made the call fail while still sending the header would be no fix.
func TestRedirectDoesNotLeakProviderTokenToForeignHost(t *testing.T) {
	var got http.Header
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = w.Write([]byte(`[]`))
	}))
	defer foreign.Close()

	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, foreign.URL+r.URL.Path, http.StatusFound)
	}))
	defer control.Close()

	// The provider token is read from a credentials FILE under os.UserConfigDir(), not an env var.
	// Planting it there is what makes this test non-vacuous — with no token on the request there is
	// no secret to leak, and the assertions below would pass against the unfixed code.
	// HOME and XDG_CONFIG_HOME are both redirected so the path resolves inside the sandbox on macOS
	// (~/Library/Application Support) and on CI's Linux (XDG_CONFIG_HOME) alike, and so the run can
	// never read or write the real developer's credentials.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("resolve user config dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(cfgDir, "alethia"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "alethia", "credentials.json"),
		[]byte(`{"access_token":"a","provider_token":"gho_supersecret"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	c := &Client{
		baseURL:    control.URL + "/api",
		authToken:  "bearer-secret",
		httpClient: &http.Client{CheckRedirect: refuseCrossOriginRedirect},
	}

	// Guard the guard: if the token is not actually on the outgoing request, this test proves nothing.
	if tok := c.getProviderToken(); tok != "gho_supersecret" {
		t.Fatalf("test setup did not plant the provider token (got %q) — the leak assertions below would be vacuous", tok)
	}

	_, _ = c.GetRepositories("github")

	if got == nil {
		return // never reached the foreign host at all — the strongest possible pass
	}
	if v := got.Get("X-Provider-Token"); v != "" {
		t.Errorf("provider token leaked to the foreign host: %q", v)
	}
	if v := got.Get("X-Alethia-Org"); v != "" {
		t.Errorf("org header (the tenancy boundary) leaked to the foreign host: %q", v)
	}
	if v := got.Get("Authorization"); v != "" {
		t.Errorf("bearer token leaked to the foreign host: %q", v)
	}
}

// TestRefuseCrossOriginRedirect drives the policy directly, including the cases a live server cannot
// easily produce.
func TestRefuseCrossOriginRedirect(t *testing.T) {
	mk := func(raw string) *http.Request {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		return &http.Request{URL: u}
	}

	refused := []struct{ from, to, why string }{
		{"https://alethialabs.io/api/x", "https://evil.example/api/x", "different host"},
		{"https://alethialabs.io/api/x", "http://alethialabs.io/api/x", "https→http downgrade puts the token on the wire in clear"},
		{"https://alethialabs.io/api/x", "https://alethialabs.io:8443/api/x", "different port is a different service"},
		{"https://alethialabs.io/api/x", "https://sub.alethialabs.io/api/x", "a subdomain is still another host"},
	}
	for _, c := range refused {
		if err := refuseCrossOriginRedirect(mk(c.to), []*http.Request{mk(c.from)}); err == nil {
			t.Errorf("redirect %s → %s was allowed; want refused (%s)", c.from, c.to, c.why)
		}
	}

	allowed := []struct{ from, to string }{
		{"https://alethialabs.io/api/x", "https://alethialabs.io/api/x/"},    // trailing slash
		{"https://alethialabs.io/api/x", "https://ALETHIALABS.IO/api/y"},     // host case
		{"https://alethialabs.io/api/x", "https://alethialabs.io:443/api/y"}, // explicit default port
		{"http://localhost:3000/api/x", "http://localhost:3000/api/y"},       // local dev origin
	}
	for _, c := range allowed {
		if err := refuseCrossOriginRedirect(mk(c.to), []*http.Request{mk(c.from)}); err != nil {
			t.Errorf("same-origin redirect %s → %s was refused: %v", c.from, c.to, err)
		}
	}

	// The cap applies even when every hop is same-origin.
	from := mk("https://alethialabs.io/api/x")
	via := []*http.Request{from, from, from}
	if err := refuseCrossOriginRedirect(mk("https://alethialabs.io/api/y"), via); err == nil {
		t.Errorf("a chain of %d same-origin hops was allowed; want capped at %d", len(via), maxAPIRedirects)
	}
}

func TestRequestOrigin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://example.com/a", "https://example.com:443"},
		{"https://example.com:443/a", "https://example.com:443"},
		{"http://example.com/a", "http://example.com:80"},
		{"http://example.com:80/a", "http://example.com:80"},
		{"https://EXAMPLE.com/a", "https://example.com:443"},
		{"http://localhost:3000/a", "http://localhost:3000"},
	}
	for _, c := range cases {
		u, err := url.Parse(c.in)
		if err != nil {
			t.Fatalf("parse %q: %v", c.in, err)
		}
		if got := requestOrigin(u); got != c.want {
			t.Errorf("requestOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	// The property the policy rests on: http and https are never the same origin, even on one host.
	h, _ := url.Parse("http://example.com/a")
	s, _ := url.Parse("https://example.com/a")
	if requestOrigin(h) == requestOrigin(s) {
		t.Error("http and https compare as one origin; an https→http downgrade would be allowed")
	}
}

// TestNewClientInstallsTheRedirectPolicy pins the wiring. Without it the policy could be left
// defined-but-unused and every test above would still pass.
func TestNewClientInstallsTheRedirectPolicy(t *testing.T) {
	c := NewClient("t")
	if c.httpClient.CheckRedirect == nil {
		t.Fatal("NewClient built an http.Client with no CheckRedirect; the credentialed headers are unprotected on a redirect")
	}
	from, _ := url.Parse("https://alethialabs.io/api/x")
	to, _ := url.Parse("https://evil.example/api/x")
	err := c.httpClient.CheckRedirect(&http.Request{URL: to}, []*http.Request{{URL: from}})
	if err == nil {
		t.Error("the installed policy allowed a cross-origin redirect")
	} else if !strings.Contains(err.Error(), "refusing redirect") {
		t.Errorf("refused, but not by the policy under test: %v", err)
	}
}
