// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package scanner

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// write creates a file (and parent dirs) under root for the fixture repo.
func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScan_ClassifiesFilesAndSignals(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", `{"scripts":{"db":"uses postgres and redis"}}`)
	write(t, root, "Dockerfile", "FROM node:20\n")
	write(t, root, "docker-compose.yml", "services:\n  q:\n    image: kafka\n")
	write(t, root, ".github/workflows/ci.yml", "on: push\n")
	write(t, root, "deploy/k8s.yaml", "apiVersion: v1\nkind: Service\n")
	write(t, root, ".env.example", "DATABASE_URL=\n")
	write(t, root, "src/main.ts", "console.log('hi')\n")
	// node_modules must be skipped entirely (untrusted, huge).
	write(t, root, "node_modules/junk/index.js", "require('postgres-but-ignored')\n")

	d, err := Scan(root, "https://github.com/acme/app", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	if d.RepoURL != "https://github.com/acme/app" || d.Ref != "main" {
		t.Errorf("repo metadata not set: %+v", d)
	}
	// 7 real files; node_modules/* is skipped.
	if d.FileCount != 7 {
		t.Errorf("FileCount = %d, want 7 (node_modules skipped)", d.FileCount)
	}
	if len(d.Manifests) == 0 || len(d.Dockerfiles) == 0 || len(d.Compose) == 0 ||
		len(d.CIConfigs) == 0 || len(d.K8sManifests) == 0 || len(d.EnvExamples) == 0 {
		t.Errorf("a classification bucket is empty: %+v", d)
	}
	for _, sig := range []string{"postgresql", "redis", "kafka"} {
		if !slices.Contains(d.Signals, sig) {
			t.Errorf("missing signal %q in %v", sig, d.Signals)
		}
	}
	if d.Languages[".ts"] != 1 || d.Languages[".json"] == 0 {
		t.Errorf("language tally off: %v", d.Languages)
	}
}

func TestScan_EmptyRepo(t *testing.T) {
	d, err := Scan(t.TempDir(), "u", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if d.FileCount != 0 || len(d.Signals) != 0 {
		t.Errorf("empty repo should yield nothing: %+v", d)
	}
}

func TestReadCapped_Truncates(t *testing.T) {
	root := t.TempDir()
	big := filepath.Join(root, "big.txt")
	if err := os.WriteFile(big, make([]byte, maxFileBytes+100), 0o644); err != nil {
		t.Fatal(err)
	}
	content, truncated := readCapped(big)
	if !truncated || len(content) != maxFileBytes {
		t.Errorf("expected truncation at %d, got len=%d truncated=%v", maxFileBytes, len(content), truncated)
	}
}

func TestLooksLikeK8s(t *testing.T) {
	root := t.TempDir()
	write(t, root, "svc.yaml", "apiVersion: v1\nkind: Service\n")
	write(t, root, "plain.yaml", "just: data\n")
	if !looksLikeK8s(filepath.Join(root, "svc.yaml")) {
		t.Error("expected k8s manifest to be recognized")
	}
	if looksLikeK8s(filepath.Join(root, "plain.yaml")) {
		t.Error("plain yaml should not look like k8s")
	}
}
