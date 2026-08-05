// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package scanner

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestTail_ScanSkipsUnreadableRoot pins the walk's fail-soft rule: an entry the walker cannot
// read (here the scan root itself does not exist) is skipped rather than failing the scan, so a
// digest is still produced — an untrusted repo must never wedge the job on one bad entry.
func TestTail_ScanSkipsUnreadableRoot(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-clone")
	d, err := Scan(missing, "https://github.com/acme/app.git", "main", nil)
	if err != nil {
		t.Fatalf("Scan of a missing root = %v, want a fail-soft empty digest", err)
	}
	if d.FileCount != 0 {
		t.Errorf("FileCount = %d, want 0", d.FileCount)
	}
	if len(d.Services) != 0 {
		t.Errorf("Services = %v, want none", d.Services)
	}
}

// TestTail_ScanReportsProgressThroughTheLogHook pins that the optional log callback receives one
// summary line naming the counts the caller just got back.
func TestTail_ScanReportsProgressThroughTheLogHook(t *testing.T) {
	root := t.TempDir()
	write(t, root, "go.mod", "module example.com/app\n")
	write(t, root, "Dockerfile", "FROM scratch\nEXPOSE 8080\n")

	var lines []string
	d, err := Scan(root, "https://github.com/acme/app.git", "main", func(s string) { lines = append(lines, s) })
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("log received %d lines, want 1: %v", len(lines), lines)
	}
	if !strings.Contains(lines[0], "Scanned 2 files") {
		t.Errorf("log line = %q, want it to report the 2 scanned files", lines[0])
	}
	if !strings.Contains(lines[0], "1 services") {
		t.Errorf("log line = %q, want it to report the detected service count", lines[0])
	}
	if len(d.Services) != 1 {
		t.Fatalf("Services = %v, want exactly one", d.Services)
	}
}

// TestTail_AttributeEnvKeysIgnoresValuelessExamples pins that an env-example carrying no
// parsable KEY= declaration contributes nothing: no service gains an empty Env list from a file
// that is all comments.
func TestTail_AttributeEnvKeysIgnoresValuelessExamples(t *testing.T) {
	services := []types.DetectedService{{Name: "api", Path: "services/api"}}
	attributeEnvKeys(services, []types.RepoFile{
		{Path: "services/api/.env.example", Content: "# only a comment\n\n   \n"},
		{Path: ".env.example", Content: "NOT_AN_ASSIGNMENT\n"},
	})
	if len(services[0].Env) != 0 {
		t.Fatalf("Env = %v, want none from comment-only examples", services[0].Env)
	}
}

// TestTail_RuntimeForManifestCoversEveryEcosystem pins the manifest → runtime label mapping,
// including the default: an unrecognised manifest name yields "" rather than a guess.
func TestTail_RuntimeForManifestCoversEveryEcosystem(t *testing.T) {
	cases := map[string]string{
		"package.json":      "node",
		"go.mod":            "go",
		"requirements.txt":  "python",
		"pyproject.toml":    "python",
		"Pipfile":           "python",
		"Gemfile":           "ruby",
		"pom.xml":           "java",
		"build.gradle":      "java",
		"build.gradle.kts":  "java",
		"Cargo.toml":        "rust",
		"composer.json":     "php",
		"mix.exs":           "elixir",
		"deno.json":         "",
		"":                  "",
		"PACKAGE.JSON":      "",
		"package.json.bak":  "",
		"requirements.lock": "",
	}
	for name, want := range cases {
		if got := runtimeForManifest(name); got != want {
			t.Errorf("runtimeForManifest(%q) = %q, want %q", name, got, want)
		}
	}
}

// TestTail_RepoNameFallsBackToApp pins that a repo URL with no usable last segment yields the
// "app" fallback rather than an empty service name.
func TestTail_RepoNameFallsBackToApp(t *testing.T) {
	cases := map[string]string{
		"":                                 "app",
		"/":                                "app",
		".git":                             "app",
		"https://github.com/acme/":         "acme",
		"https://github.com/acme/repo.git": "repo",
		"git@github.com:acme/repo.git":     "repo",
	}
	for in, want := range cases {
		if got := repoName(in); got != want {
			t.Errorf("repoName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestTail_ReadCappedOnADirectory pins that a path that opens but cannot be read as a byte
// stream (a directory) degrades to empty/not-truncated instead of propagating an error.
func TestTail_ReadCappedOnADirectory(t *testing.T) {
	content, truncated := readCapped(t.TempDir())
	if content != "" || truncated {
		t.Fatalf("readCapped(dir) = (%q, %v), want (\"\", false)", content, truncated)
	}
}

// TestTail_LooksLikeK8sOnADirectory pins the same fail-soft rule for the k8s sniffer: a path it
// cannot read is simply "not a manifest".
func TestTail_LooksLikeK8sOnADirectory(t *testing.T) {
	if looksLikeK8s(t.TempDir()) {
		t.Fatal("looksLikeK8s(dir) = true, want false")
	}
}
