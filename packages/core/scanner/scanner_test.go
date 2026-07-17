// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

func TestScan_DetectsMonorepoServices(t *testing.T) {
	root := t.TempDir()
	// A monorepo: a Go API service + a Node web service under apps/, each with its own
	// Dockerfile + manifest, and a root manifest (the workspace root).
	write(t, root, "package.json", `{"name":"mono","workspaces":["apps/*"]}`)
	write(t, root, "apps/api/go.mod", "module api\n")
	write(t, root, "apps/api/Dockerfile", "FROM golang:1.25\nEXPOSE 8080\n")
	write(t, root, "apps/web/package.json", `{"name":"web"}`)
	write(t, root, "apps/web/Dockerfile", "FROM node:20\nEXPOSE 3000/tcp\n")

	d, err := Scan(root, "https://github.com/acme/mono.git", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	byPath := map[string]struct {
		runtime string
		port    int
		docker  bool
		name    string
	}{}
	for _, s := range d.Services {
		byPath[s.Path] = struct {
			runtime string
			port    int
			docker  bool
			name    string
		}{s.Runtime, s.Port, s.HasDockerfile, s.Name}
	}

	api, ok := byPath["apps/api"]
	if !ok || api.runtime != "go" || api.port != 8080 || !api.docker || api.name != "api" {
		t.Errorf("apps/api service wrong: %+v", byPath["apps/api"])
	}
	web, ok := byPath["apps/web"]
	if !ok || web.runtime != "node" || web.port != 3000 || !web.docker || web.name != "web" {
		t.Errorf("apps/web service wrong: %+v (port should strip /tcp)", byPath["apps/web"])
	}
	// The workspace root manifest yields a root service named from the repo.
	if root, ok := byPath[""]; !ok || root.name != "mono" {
		t.Errorf("root service should be named from the repo (.git stripped): %+v", byPath[""])
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

// TestLooksLikeK8s_Cases drives the YAML sniffer across kind/apiVersion edge cases.
func TestLooksLikeK8s_Cases(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"both markers", "apiVersion: apps/v1\nkind: Deployment\n", true},
		{"only apiVersion", "apiVersion: v1\nfoo: bar\n", false},
		{"only kind", "kind: Service\nfoo: bar\n", false},
		{"neither", "name: hello\nvalue: 3\n", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			write(t, root, tc.name+".yaml", tc.content)
			got := looksLikeK8s(filepath.Join(root, tc.name+".yaml"))
			if got != tc.want {
				t.Errorf("looksLikeK8s(%q) = %v, want %v", tc.content, got, tc.want)
			}
		})
	}
}

// TestLooksLikeK8s_MissingFile ensures an unreadable path is reported as not-k8s, not a panic.
func TestLooksLikeK8s_MissingFile(t *testing.T) {
	if looksLikeK8s(filepath.Join(t.TempDir(), "does-not-exist.yaml")) {
		t.Error("missing file must not look like k8s")
	}
}

// TestReadCapped_NoTruncation reads a small file fully and reports no truncation.
func TestReadCapped_NoTruncation(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "small.txt")
	body := "hello world"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	content, truncated := readCapped(p)
	if truncated || content != body {
		t.Errorf("readCapped(small) = (%q, %v), want (%q, false)", content, truncated, body)
	}
}

// TestReadCapped_ExactBoundary verifies a file of exactly maxFileBytes is NOT truncated.
func TestReadCapped_ExactBoundary(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "exact.txt")
	if err := os.WriteFile(p, make([]byte, maxFileBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	content, truncated := readCapped(p)
	if truncated || len(content) != maxFileBytes {
		t.Errorf("readCapped(exact) = (len %d, %v), want (len %d, false)", len(content), truncated, maxFileBytes)
	}
}

// TestReadCapped_MissingFile returns empty/no-truncation for an unreadable path.
func TestReadCapped_MissingFile(t *testing.T) {
	content, truncated := readCapped(filepath.Join(t.TempDir(), "nope.txt"))
	if content != "" || truncated {
		t.Errorf("readCapped(missing) = (%q, %v), want (\"\", false)", content, truncated)
	}
}

// TestScan_PerBucketCap asserts a bucket never exceeds maxFilesPerBucket even with more matches.
func TestScan_PerBucketCap(t *testing.T) {
	root := t.TempDir()
	const n = maxFilesPerBucket + 10
	for i := range n {
		write(t, root, filepath.Join("dockerfiles", "Dockerfile."+itoa(i)), "FROM scratch\n")
	}
	d, err := Scan(root, "u", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(d.Dockerfiles) != maxFilesPerBucket {
		t.Errorf("Dockerfiles bucket = %d, want capped at %d", len(d.Dockerfiles), maxFilesPerBucket)
	}
	// Every file is still walked / counted even when the capture bucket is full.
	if d.FileCount != n {
		t.Errorf("FileCount = %d, want %d", d.FileCount, n)
	}
}

// TestScan_SignalAliases verifies keyword→normalized-signal mapping (aliases collapse).
func TestScan_SignalAliases(t *testing.T) {
	root := t.TempDir()
	// Captured via .env.example content; aliases should normalize to canonical signals.
	write(t, root, ".env.example", "valkey mariadb minio celery opensearch\n")
	d, err := Scan(root, "u", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	want := []string{"mysql", "object-storage", "redis", "task-queue", "elasticsearch"}
	for _, sig := range want {
		if !slices.Contains(d.Signals, sig) {
			t.Errorf("alias not normalized: missing %q in %v", sig, d.Signals)
		}
	}
	// Signals must be sorted & de-duplicated.
	if !slices.IsSorted(d.Signals) {
		t.Errorf("signals not sorted: %v", d.Signals)
	}
}

// TestScan_SkipDirsExcluded confirms files under skipped dirs are not walked, classified, or signalled.
func TestScan_SkipDirsExcluded(t *testing.T) {
	root := t.TempDir()
	write(t, root, "go.mod", "module example.com/app\n")
	for dir := range skipDirs {
		write(t, root, filepath.Join(dir, "package.json"), `{"deps":"redis"}`)
	}
	d, err := Scan(root, "u", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	// Only the single top-level go.mod is real; everything under skipDirs is ignored.
	if d.FileCount != 1 {
		t.Errorf("FileCount = %d, want 1 (skipDirs ignored)", d.FileCount)
	}
	if len(d.Manifests) != 1 {
		t.Errorf("Manifests = %d, want 1", len(d.Manifests))
	}
	if len(d.Signals) != 0 {
		t.Errorf("Signals = %v, want none (skipDir content not read)", d.Signals)
	}
}

// TestScan_Classification table-drives filename → expected bucket placement.
func TestScan_Classification(t *testing.T) {
	cases := []struct {
		name string // relative path written
		get  func(d k8sDigest) int
		desc string
	}{
		{"go.mod", func(d k8sDigest) int { return d.manifests }, "manifest"},
		{"Cargo.toml", func(d k8sDigest) int { return d.manifests }, "manifest"},
		{"Dockerfile", func(d k8sDigest) int { return d.dockerfiles }, "dockerfile"},
		{"Dockerfile.prod", func(d k8sDigest) int { return d.dockerfiles }, "dockerfile prefix"},
		{"docker-compose.yaml", func(d k8sDigest) int { return d.compose }, "compose"},
		{"compose.yml", func(d k8sDigest) int { return d.compose }, "compose bare"},
		{"fly.toml", func(d k8sDigest) int { return d.ci }, "ci config"},
		{"vercel.json", func(d k8sDigest) int { return d.ci }, "ci config"},
		{".env.sample", func(d k8sDigest) int { return d.env }, "env example"},
	}
	for _, tc := range cases {
		t.Run(tc.desc+"/"+tc.name, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, tc.name, "x: y\n")
			d, err := Scan(root, "u", "main", nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			kd := k8sDigest{
				manifests:   len(d.Manifests),
				dockerfiles: len(d.Dockerfiles),
				compose:     len(d.Compose),
				ci:          len(d.CIConfigs),
				env:         len(d.EnvExamples),
			}
			if got := tc.get(kd); got != 1 {
				t.Errorf("%q not classified into %s bucket (count=%d, digest=%+v)", tc.name, tc.desc, got, kd)
			}
		})
	}
}

// TestScan_GithubWorkflowAsCI verifies .github/workflows/*.yml lands in CIConfigs.
func TestScan_GithubWorkflowAsCI(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".github/workflows/release.yaml", "on: push\n")
	d, err := Scan(root, "u", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(d.CIConfigs) != 1 {
		t.Errorf("CIConfigs = %d, want 1 (github workflow)", len(d.CIConfigs))
	}
}

// k8sDigest is a tiny flattened view of bucket sizes for table assertions.
type k8sDigest struct {
	manifests, dockerfiles, compose, ci, env int
}

// itoa is a dependency-free int→string for fixture filenames.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// W6 Path-B (#649): env-var KEY names from a service's .env.example land on THAT service's
// Env (values dropped), attributed per-service like needs. Comments, `export`, value-less keys,
// duplicates, and invalid names are handled.
func TestScan_AttributesEnvKeysPerService(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", `{"name":"mono"}`)
	write(t, root, "apps/api/Dockerfile", "FROM node:20\nEXPOSE 3000\n")
	write(t, root, "apps/api/.env.example", "# database\nDATABASE_URL=postgres://x\nexport PORT=3000\nPORT=3000\n\n1BAD=nope\n=alsobad\n")
	write(t, root, "apps/worker/Dockerfile", "FROM node:20\n")
	write(t, root, "apps/worker/.env.sample", "AMQP_URL=\nQUEUE_NAME=jobs\n")

	d, err := Scan(root, "https://github.com/acme/mono.git", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	envByPath := map[string][]string{}
	for _, s := range d.Services {
		envByPath[s.Path] = s.Env
	}
	// api: DATABASE_URL + PORT (export stripped, PORT deduped, sorted); comment/blank/1BAD/=alsobad dropped.
	if got := envByPath["apps/api"]; len(got) != 2 || got[0] != "DATABASE_URL" || got[1] != "PORT" {
		t.Errorf("apps/api env = %v, want [DATABASE_URL PORT]", got)
	}
	// worker: a value-less key (AMQP_URL=) is still a declared key.
	if got := envByPath["apps/worker"]; len(got) != 2 || got[0] != "AMQP_URL" || got[1] != "QUEUE_NAME" {
		t.Errorf("apps/worker env = %v, want [AMQP_URL QUEUE_NAME]", got)
	}
}

// W3 Path-B seed (#620): backing-service signals must land on the SERVICE whose files
// carry them (per-service `needs`), not just on the repo-wide Signals list.
func TestScan_AttributesNeedsPerService(t *testing.T) {
	root := t.TempDir()
	// Monorepo: api (postgres + redis in its own compose) and worker (rabbitmq via a
	// nested env example); a root service exists via the workspace manifest, and the
	// repo root carries a kafka signal in CI config that no sub-service encloses.
	write(t, root, "package.json", `{"name":"mono"}`)
	write(t, root, "apps/api/Dockerfile", "FROM golang:1.25\nEXPOSE 8080\n")
	write(t, root, "apps/api/docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n")
	write(t, root, "apps/worker/Dockerfile", "FROM node:20\n")
	write(t, root, "apps/worker/.env.example", "AMQP_URL=amqp://guest@localhost\n")
	write(t, root, ".github/workflows/ci.yml", "name: ci\n# talks to kafka in integration tests\n")

	d, err := Scan(root, "https://github.com/acme/mono.git", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	needsByPath := map[string][]string{}
	for _, s := range d.Services {
		needsByPath[s.Path] = s.Needs
	}
	if got := needsByPath["apps/api"]; len(got) != 2 || got[0] != "postgresql" || got[1] != "redis" {
		t.Errorf("apps/api needs = %v, want [postgresql redis] (sorted)", got)
	}
	if got := needsByPath["apps/worker"]; len(got) != 1 || got[0] != "rabbitmq" {
		t.Errorf("apps/worker needs = %v, want [rabbitmq]", got)
	}
	// The CI file is enclosed by no sub-service → falls back to the root service.
	if got := needsByPath[""]; len(got) != 1 || got[0] != "kafka" {
		t.Errorf("root needs = %v, want [kafka] (unattributed fallback)", got)
	}
	// The repo-wide Signals union is unchanged by attribution.
	if len(d.Signals) != 4 {
		t.Errorf("repo-wide signals = %v, want 4 (kafka postgresql rabbitmq redis)", d.Signals)
	}
}

// Without a root service, signals enclosed by no service stay repo-wide only (never
// dropped silently into a wrong service).
func TestScan_UnattributedNeedsStayRepoWide(t *testing.T) {
	root := t.TempDir()
	write(t, root, "apps/api/Dockerfile", "FROM golang:1.25\n")
	// A root-level compose no service encloses (no root manifest → no root service).
	write(t, root, "docker-compose.yml", "services:\n  search:\n    image: elasticsearch:8\n")

	d, err := Scan(root, "https://github.com/acme/one.git", "main", nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	for _, s := range d.Services {
		if s.Path == "apps/api" && len(s.Needs) != 0 {
			t.Errorf("apps/api must not inherit the root compose signal, got %v", s.Needs)
		}
	}
	if len(d.Signals) != 1 || d.Signals[0] != "elasticsearch" {
		t.Errorf("repo-wide signals = %v, want [elasticsearch]", d.Signals)
	}
}
