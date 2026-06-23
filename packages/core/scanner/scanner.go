// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	"path/filepath"
	"sort"
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

	if log != nil {
		log(fmt.Sprintf("Scanned %d files — %d manifests, %d Dockerfiles, %d compose, %d k8s, %d CI, %d signals",
			d.FileCount, len(d.Manifests), len(d.Dockerfiles), len(d.Compose),
			len(d.K8sManifests), len(d.CIConfigs), len(d.Signals)))
	}
	return d, nil
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
