// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package scanner produces a deterministic, STATIC RepoDigest from a cloned
// repository — it walks + reads + parses files only. It NEVER executes repo code.
// Bounded by file-count / per-file-byte / per-bucket caps so an untrusted repo
// can't blow up memory or time.
package scanner

import (
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	maxWalkFiles      = 20000
	maxFileBytes      = 64 * 1024
	maxFilesPerBucket = 25
	k8sSniffBytes     = 2048
)

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, ".next": true, "target": true, "__pycache__": true,
	".venv": true, "venv": true, ".terraform": true, "coverage": true,
	".idea": true, ".vscode": true, "bin": true, "obj": true, ".cache": true,
}

var manifestNames = map[string]bool{
	"package.json": true, "go.mod": true, "requirements.txt": true,
	"pyproject.toml": true, "Pipfile": true, "Gemfile": true,
	"pom.xml": true, "build.gradle": true, "build.gradle.kts": true,
	"Cargo.toml": true, "composer.json": true, "mix.exs": true,
}

var ciNames = map[string]bool{
	".gitlab-ci.yml": true, "Procfile": true, "fly.toml": true,
	"vercel.json": true, "render.yaml": true, "app.yaml": true,
	"nixpacks.toml": true,
}

var envNames = map[string]bool{
	".env.example": true, ".env.sample": true, ".env.template": true,
	".env.dist": true,
}

// keyword → normalized service signal (matched case-insensitively in captured content).
var serviceSignals = []struct{ kw, signal string }{
	{"postgres", "postgresql"}, {"postgresql", "postgresql"},
	{"mysql", "mysql"}, {"mariadb", "mysql"},
	{"redis", "redis"}, {"valkey", "redis"},
	{"rabbitmq", "rabbitmq"}, {"amqp", "rabbitmq"},
	{"kafka", "kafka"},
	{"mongodb", "mongodb"}, {"mongo:", "mongodb"},
	{"elasticsearch", "elasticsearch"}, {"opensearch", "elasticsearch"},
	{"memcached", "memcached"},
	{"dynamodb", "dynamodb"},
	{"minio", "object-storage"}, {"s3://", "object-storage"}, {"s3_bucket", "object-storage"},
	{"celery", "task-queue"}, {"sidekiq", "task-queue"}, {"bullmq", "task-queue"},
	{"clickhouse", "clickhouse"},
}

// Scan walks root and returns a RepoDigest. `log` (optional) receives progress lines.
func Scan(root, repoURL, ref string, log func(string)) (*types.RepoDigest, error) {
	d := &types.RepoDigest{
		RepoURL:   repoURL,
		Ref:       ref,
		ScannedAt: time.Now().UTC().Format(time.RFC3339),
		Languages: map[string]int{},
	}
	signalSet := map[string]bool{}
	walked := 0

	capture := func(bucket *[]types.RepoFile, path string) {
		if len(*bucket) >= maxFilesPerBucket {
			return
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = path
		}
		content, truncated := readCapped(path)
		*bucket = append(*bucket, types.RepoFile{Path: rel, Content: content, Truncated: truncated})
		lower := strings.ToLower(content)
		for _, s := range serviceSignals {
			if strings.Contains(lower, s.kw) {
				signalSet[s.signal] = true
			}
		}
	}

	err := filepath.WalkDir(root, func(path string, e os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip unreadable entries
		}
		if e.IsDir() {
			if skipDirs[e.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		walked++
		if walked > maxWalkFiles {
			d.Truncated = true
			return filepath.SkipAll
		}
		d.FileCount++
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != "" {
			d.Languages[ext]++
		}

		slash := filepath.ToSlash(path)
		switch {
		case manifestNames[name]:
			capture(&d.Manifests, path)
		case name == "Dockerfile" || strings.HasPrefix(name, "Dockerfile."):
			capture(&d.Dockerfiles, path)
		case (ext == ".yml" || ext == ".yaml") &&
			(strings.HasPrefix(name, "docker-compose") || strings.HasPrefix(name, "compose")):
			capture(&d.Compose, path)
		case ciNames[name]:
			capture(&d.CIConfigs, path)
		case strings.Contains(slash, "/.github/workflows/") && (ext == ".yml" || ext == ".yaml"):
			capture(&d.CIConfigs, path)
		case envNames[name]:
			capture(&d.EnvExamples, path)
		case (ext == ".yaml" || ext == ".yml") && looksLikeK8s(path):
			capture(&d.K8sManifests, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	for s := range signalSet {
		d.Signals = append(d.Signals, s)
	}
	sort.Strings(d.Signals)

	d.Services = detectServices(d, repoURL)

	if log != nil {
		log(fmt.Sprintf("Scanned %d files — %d manifests, %d Dockerfiles, %d compose, %d k8s, %d CI, %d signals, %d services",
			d.FileCount, len(d.Manifests), len(d.Dockerfiles), len(d.Compose),
			len(d.K8sManifests), len(d.CIConfigs), len(d.Signals), len(d.Services)))
	}
	return d, nil
}

// detectServices groups the captured Dockerfiles + language manifests by directory
// into deployable services (monorepo-aware): each distinct directory carrying a
// Dockerfile or a manifest is one service (path "" = repo root). Derived from the
// already-captured files, so it adds no extra filesystem walk.
func detectServices(d *types.RepoDigest, repoURL string) []types.DetectedService {
	byPath := map[string]*types.DetectedService{}
	get := func(p string) *types.DetectedService {
		s, ok := byPath[p]
		if !ok {
			name := path.Base(p)
			if p == "" {
				name = repoName(repoURL)
			}
			s = &types.DetectedService{Path: p, Name: name}
			byPath[p] = s
		}
		return s
	}
	for _, f := range d.Dockerfiles {
		s := get(dirKey(f.Path))
		s.HasDockerfile = true
		if s.Port == 0 {
			s.Port = parseExpose(f.Content)
		}
	}
	for _, f := range d.Manifests {
		s := get(dirKey(f.Path))
		if s.Runtime == "" {
			s.Runtime = runtimeForManifest(filepath.Base(f.Path))
		}
	}
	out := make([]types.DetectedService, 0, len(byPath))
	for _, s := range byPath {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// dirKey normalizes a captured file's directory to a service path ("" = repo root).
func dirKey(filePath string) string {
	dir := filepath.ToSlash(filepath.Dir(filePath))
	if dir == "." {
		return ""
	}
	return dir
}

// runtimeForManifest maps a manifest filename to a coarse runtime label.
func runtimeForManifest(name string) string {
	switch name {
	case "package.json":
		return "node"
	case "go.mod":
		return "go"
	case "requirements.txt", "pyproject.toml", "Pipfile":
		return "python"
	case "Gemfile":
		return "ruby"
	case "pom.xml", "build.gradle", "build.gradle.kts":
		return "java"
	case "Cargo.toml":
		return "rust"
	case "composer.json":
		return "php"
	case "mix.exs":
		return "elixir"
	}
	return ""
}

// parseExpose returns the first EXPOSE port declared in a Dockerfile, or 0.
func parseExpose(content string) int {
	for line := range strings.SplitSeq(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 2 && strings.EqualFold(fields[0], "EXPOSE") {
			p := fields[1]
			if i := strings.IndexByte(p, '/'); i >= 0 {
				p = p[:i] // strip "/tcp"
			}
			if n, err := strconv.Atoi(p); err == nil {
				return n
			}
		}
	}
	return 0
}

// repoName derives a fallback service name from a repo URL (last path segment,
// ".git" stripped).
func repoName(repoURL string) string {
	s := strings.TrimSuffix(strings.TrimRight(repoURL, "/"), ".git")
	if i := strings.LastIndexAny(s, "/:"); i >= 0 {
		s = s[i+1:]
	}
	if s == "" {
		return "app"
	}
	return s
}

// readCapped reads up to maxFileBytes of a file (never loads more), returning the
// content + whether it was truncated.
func readCapped(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return "", false
	}
	if len(b) > maxFileBytes {
		return string(b[:maxFileBytes]), true
	}
	return string(b), false
}

// looksLikeK8s cheaply sniffs the head of a YAML file for k8s manifest markers.
func looksLikeK8s(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, k8sSniffBytes))
	if err != nil {
		return false
	}
	s := string(b)
	return strings.Contains(s, "apiVersion:") && strings.Contains(s, "kind:")
}
