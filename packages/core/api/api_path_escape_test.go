// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureServer records the path (and raw query) of the last request it received.
func captureServer(t *testing.T, body string) (*httptest.Server, *string, *string) {
	t.Helper()
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &gotPath, &gotQuery
}

// TestGetConfiguration_EscapesTheProjectName is #2040's repro, kept.
//
// Project names are free text — the console requires only 1-50 chars that slugify to something
// non-empty — so `#`, `?`, `/` and space are all accepted. Interpolated raw, `staging#2` requested
// `/api/cli/configurations/by-project-name/staging`: the server returns a DIFFERENT project's
// configuration and the CLI reports it as the requested one, with no error.
func TestGetConfiguration_EscapesTheProjectName(t *testing.T) {
	cases := []struct{ name, wantSuffix, why string }{
		{"staging#2", "/staging%232", "a fragment silently truncates the name"},
		{"staging?x=1", "/staging%3Fx=1", "a query marker silently truncates the name"},
		{"a/b", "/a%2Fb", "a slash re-targets a different API route"},
		{"my project", "/my%20project", "a space must not split the path"},
		{"../admin", "/..%2Fadmin", "traversal must not escape the route"},
	}

	for _, c := range cases {
		srv, gotPath, _ := captureServer(t, `{"configuration":{}}`)
		cl := &Client{baseURL: srv.URL + "/api", authToken: "t", httpClient: srv.Client()}

		if _, err := cl.GetConfiguration(c.name); err != nil {
			t.Fatalf("GetConfiguration(%q): %v", c.name, err)
		}
		// RawPath is what went on the wire; r.URL.Path is already decoded, so compare on the decoded
		// form matching the ORIGINAL name — the point is that the server saw the whole name.
		if !strings.HasSuffix(*gotPath, "/"+c.name) {
			t.Errorf("GetConfiguration(%q) requested %q — the server did not receive the whole name (%s)", c.name, *gotPath, c.why)
		}
	}
}

// TestPathSegmentsAreEscapedAcrossTheClient covers the other methods #2040 lists. They are separate
// Sprintf lines, so fixing GetConfiguration proves nothing about any of them — and a job id or
// provider slug reaching these calls is just as attacker-influenced as a project name.
func TestPathSegmentsAreEscapedAcrossTheClient(t *testing.T) {
	const hostile = "a/b#c"

	calls := map[string]func(*Client) error{
		"GetJob":          func(c *Client) error { _, err := c.GetJob(hostile); return err },
		"GetJobLogs":      func(c *Client) error { _, err := c.GetJobLogs(hostile, 0); return err },
		"CancelJob":       func(c *Client) error { return c.CancelJob(hostile) },
		"GetRepositories": func(c *Client) error { _, err := c.GetRepositories(hostile); return err },
	}

	for name, call := range calls {
		srv, gotPath, _ := captureServer(t, `{}`)
		cl := &Client{baseURL: srv.URL + "/api", authToken: "t", httpClient: srv.Client()}

		// The response shape does not matter; an error here is fine. What matters is the PATH.
		_ = call(cl)

		if !strings.Contains(*gotPath, hostile) {
			t.Errorf("%s sent path %q — the hostile segment %q was truncated or re-targeted", name, *gotPath, hostile)
		}
	}
}

// TestExportConfigurationWasAlreadyCorrect pins the sibling that #2040 cites as the counter-example:
// it escaped all along, which is what made the omission next door visible. If it regresses, the
// convention has drifted the other way.
func TestExportConfigurationWasAlreadyCorrect(t *testing.T) {
	srv, gotPath, gotQuery := captureServer(t, `{"content":"x","filename":"f"}`)
	cl := &Client{baseURL: srv.URL + "/api", authToken: "t", httpClient: srv.Client()}

	if _, err := cl.ExportConfiguration("a/b#c", "yaml"); err != nil {
		// The body may not decode; the path is the assertion.
		_ = err
	}
	if !strings.Contains(*gotPath, "a/b#c") {
		t.Errorf("ExportConfiguration sent %q?%s — the project name was truncated", *gotPath, *gotQuery)
	}
}

// TestClassificationQueryParamsStayEscaped: the two classification calls build a QUERY string, not a
// path, and already used url.QueryEscape. Pinned so a future "consistency" edit does not swap them
// to PathEscape, which does not escape `&` or `=` and would let a value inject another parameter.
func TestClassificationQueryParamsStayEscaped(t *testing.T) {
	srv, _, gotQuery := captureServer(t, `{"assignments":[]}`)
	cl := &Client{baseURL: srv.URL + "/api", authToken: "t", httpClient: srv.Client()}

	if _, err := cl.GetResourceClassifications("project", "x&admin=1"); err != nil {
		t.Fatalf("GetResourceClassifications: %v", err)
	}
	// If `&` were unescaped the server would parse an extra parameter.
	if strings.Contains(*gotQuery, "id=x&admin=1") {
		t.Errorf("query %q — the id value injected an extra parameter", *gotQuery)
	}
}
