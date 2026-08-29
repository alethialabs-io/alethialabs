// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunConfigExportRaw(t *testing.T) {
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "apiVersion: v1", Filename: "acme.yaml", Format: "legacy-yaml"}}
	var buf bytes.Buffer
	if err := runConfigExport(c, &buf, "table", "acme", "legacy-yaml", ""); err != nil {
		t.Fatalf("runConfigExport: %v", err)
	}
	if !strings.Contains(buf.String(), "apiVersion: v1") {
		t.Errorf("expected raw content, got: %q", buf.String())
	}
}

func TestRunConfigExportJSON(t *testing.T) {
	c := &fakeClient{configExport: &api.ConfigurationExport{Content: "x", Filename: "acme.yaml", Format: "legacy-yaml"}}
	var buf bytes.Buffer
	if err := runConfigExport(c, &buf, "json", "acme", "legacy-yaml", ""); err != nil {
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
	if err := runConfigExport(c, &buf, "table", "acme", "legacy-yaml", path); err != nil {
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
	if err := runConfigExport(c, &bytes.Buffer{}, "table", "acme", "legacy-yaml", ""); err == nil {
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
		t.Errorf("--format default = %q; want json (apps/docs/content/docs/cli/configuration.mdx documents json, and the export route accepts json alone)", f.DefValue)
	}
}
