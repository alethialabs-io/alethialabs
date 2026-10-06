// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunConfigExportRaw(t *testing.T) {
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "apiVersion: v1", Filename: "acme.yaml", Format: "legacy-yaml"}}
	var buf bytes.Buffer
	if err := runConfigExport(c, &buf, "table", "acme", "legacy-yaml", "", ""); err != nil {
		t.Fatalf("runConfigExport: %v", err)
	}
	if !strings.Contains(buf.String(), "apiVersion: v1") {
		t.Errorf("expected raw content, got: %q", buf.String())
	}
}

func TestRunConfigExportJSON(t *testing.T) {
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "x", Filename: "acme.yaml", Format: "legacy-yaml"}}
	var buf bytes.Buffer
	if err := runConfigExport(c, &buf, "json", "acme", "legacy-yaml", "", ""); err != nil {
		t.Fatalf("runConfigExport json: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `"filename": "acme.yaml"`) || !strings.Contains(out, `"format": "legacy-yaml"`) {
		t.Errorf("expected export envelope json, got: %q", out)
	}
}

func TestRunConfigExportToFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.yaml")
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "content-here", Format: "legacy-yaml"}}
	var buf bytes.Buffer
	if err := runConfigExport(c, &buf, "table", "acme", "legacy-yaml", "", path); err != nil {
		t.Fatalf("runConfigExport --out: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(data) != "content-here" {
		t.Errorf("file content = %q; want content-here", string(data))
	}
	if !strings.Contains(buf.String(), "Wrote "+path) {
		t.Errorf("expected write confirmation, got: %q", buf.String())
	}
}

func TestRunConfigExportError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runConfigExport(c, &bytes.Buffer{}, "table", "acme", "legacy-yaml", "", ""); err == nil {
		t.Error("expected error to propagate")
	}
}

// The FLAG DEFAULT is the thing under test, not the client's empty-string substitution.
// packages/core/api substitutes `json` only when the format is EMPTY, and the flag default was
// `legacy-yaml` — never empty — so the substitution never fired and every real invocation asked the
// server for a format it refuses by name (400). The server, the API client and the docs were all
// corrected; this flag was the renderer that was missed. Assert the default the docs promise.
func TestConfigExportFormatFlagDefaultsToJSON(t *testing.T) {
	f := configExportCmd.Flags().Lookup("format")
	if f == nil {
		t.Fatal("config export has no --format flag")
	}
	if f.DefValue != "json" {
		t.Errorf("--format default = %q; want json (apps/docs/content/docs/reference/cli/configuration.mdx documents json, and the export route accepts json alone)", f.DefValue)
	}
}

// configExportServer is an httptest control plane for the export route: it records the raw query
// string of every request and answers 404 for the environment named `missing`, the way the route does.
func configExportServer(t *testing.T) *[]string {
	t.Helper()
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("env") == "missing" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Environment \"missing\" not found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"content":"{}\n","filename":"acme.json","format":"json"}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	return &queries
}

// `config export --env` reaches the wire (#5531). The route has resolved `?env=` all along; the
// client never sent it, so `--env staging` would have exported the DEFAULT environment and said
// nothing. Asserted on the real client against an httptest server, so the query string is what
// is measured, not what a fake was handed.
func TestRunConfigExport_EnvIsSentURLEscaped(t *testing.T) {
	queries := configExportServer(t)
	if err := runConfigExport(api.NewClient("tok"), &bytes.Buffer{}, "table", "acme", "json", "qa & load", ""); err != nil {
		t.Fatalf("runConfigExport --env: %v", err)
	}
	if err := runConfigExport(api.NewClient("tok"), &bytes.Buffer{}, "table", "acme", "json", "", ""); err != nil {
		t.Fatalf("runConfigExport: %v", err)
	}
	want := []string{"format=json&env=qa+%26+load", "format=json"}
	if len(*queries) != 2 || (*queries)[0] != want[0] || (*queries)[1] != want[1] {
		t.Errorf("queries = %q, want %q — --env escaped, and no env parameter without the flag", *queries, want)
	}
}

// An environment the project does not have is the server's 404, and its message reaches the person.
func TestRunConfigExport_UnknownEnvSurfacesTheServersMessage(t *testing.T) {
	configExportServer(t)
	err := runConfigExport(api.NewClient("tok"), &bytes.Buffer{}, "table", "acme", "json", "missing", "")
	if err == nil || !strings.Contains(err.Error(), `Environment "missing" not found`) || !strings.Contains(err.Error(), "404") {
		t.Errorf("err = %v, want the server's 404 message", err)
	}
}

// The flag is wired through the cobra command to the client.
func TestConfigExport_EnvFlagReachesTheClient(t *testing.T) {
	f := configExportCmd.Flags().Lookup("env")
	if f == nil {
		t.Fatal("config export has no --env flag")
	}
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "{}"}}
	if err := runConfigExport(c, &bytes.Buffer{}, "table", "acme", "json", "staging", ""); err != nil {
		t.Fatal(err)
	}
	if c.exportEnv != "staging" {
		t.Errorf("client asked for env %q, want staging", c.exportEnv)
	}
}
