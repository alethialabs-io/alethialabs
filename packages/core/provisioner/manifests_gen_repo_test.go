// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// imageService builds a prebuilt-image service — the minimal renderable shape
// manifests.FromServices accepts (no BUILD job, so ResolvedImage is not needed).
func imageService(name, image string) types.ProjectServiceConfig {
	return types.ProjectServiceConfig{
		Name:   name,
		Source: types.ProjectServiceSource{Kind: "image", Image: image},
		Ports:  []types.ServicePort{{ContainerPort: 8080}},
	}
}

// generateAppManifests scaffolds into an EMPTY apps repo, and returns without touching a repo
// that already holds manifests at its root (the bring-your-own guard).
func TestGenerateAppManifests_ScaffoldAndByoGuard(t *testing.T) {
	tests := []struct {
		name        string
		seedFiles   map[string]string
		services    []types.ProjectServiceConfig
		wantFiles   []string
		wantCommits int
	}{
		{
			name:        "scaffolds and pushes into an empty apps repo",
			services:    []types.ProjectServiceConfig{imageService("web", "nginx:1.27")},
			wantFiles:   []string{"web.yaml"},
			wantCommits: 2,
		},
		{
			name:        "two services each get a manifest",
			services:    []types.ProjectServiceConfig{imageService("web", "nginx:1.27"), imageService("api", "api:1.0")},
			wantFiles:   []string{"web.yaml", "api.yaml"},
			wantCommits: 2,
		},
		{
			name:        "a bring-your-own repo with root manifests is left untouched",
			seedFiles:   map[string]string{"deployment.yaml": "kind: Deployment\n"},
			services:    []types.ProjectServiceConfig{imageService("web", "nginx:1.27")},
			wantCommits: 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			bare := newBareAppsRepo(t, tc.seedFiles)
			vc := &types.ProjectConfig{ProjectName: "acme"}
			vc.Repositories.AppsDestinationRepo = "file://" + bare
			vc.Services = tc.services

			var out, errb bytes.Buffer
			warnings, keyless, err := generateAppManifests(t.Context(), vc, nil, "tok", nil, &out, &errb)
			if err != nil {
				t.Fatalf("generateAppManifests: %v", err)
			}
			if len(keyless) != 0 {
				t.Errorf("no keyless binding was configured, got %v", keyless)
			}
			if len(warnings) != 0 {
				t.Errorf("every service is renderable, so no warnings expected: %v", warnings)
			}

			files := readBareRepo(t, bare)
			for _, want := range tc.wantFiles {
				if _, ok := files[want]; !ok {
					t.Errorf("expected %s in the apps repo, got %v", want, keysOf(files))
				}
			}
			if got := commitCount(t, bare); got != tc.wantCommits {
				t.Errorf("commit count = %d, want %d", got, tc.wantCommits)
			}
		})
	}
}

// A service that cannot be rendered is REPORTED as a warning, never silently dropped —
// and with nothing renderable the repo is never cloned or committed to.
func TestGenerateAppManifests_UnrenderableServicesAreReported(t *testing.T) {
	bare := newBareAppsRepo(t, nil)
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.Services = []types.ProjectServiceConfig{
		{Name: "unbuilt", Source: types.ProjectServiceSource{Kind: "repo"}},
		{Name: "worker", Type: "cronjob", Source: types.ProjectServiceSource{Kind: "image", Image: "w:1"}},
	}

	var out, errb bytes.Buffer
	warnings, _, err := generateAppManifests(t.Context(), vc, nil, "tok", nil, &out, &errb)
	if err != nil {
		t.Fatalf("generateAppManifests: %v", err)
	}
	if len(warnings) != 2 {
		t.Fatalf("expected one warning per skipped service, got %v", warnings)
	}
	if !strings.Contains(strings.Join(warnings, " "), "not built yet") {
		t.Errorf("the unbuilt service's reason should be reported, got %v", warnings)
	}
	if got := commitCount(t, bare); got != 1 {
		t.Errorf("nothing renderable must produce no commit, got %d commits", got)
	}
}

// No apps repo (or no token) is a silent no-op: there is nowhere to scaffold to.
func TestGenerateAppManifests_NoRepoOrTokenIsNoOp(t *testing.T) {
	tests := []struct {
		name  string
		repo  string
		token string
	}{
		{name: "no apps repo", repo: "", token: "tok"},
		{name: "no git token", repo: "https://github.com/acme/apps.git", token: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			vc := &types.ProjectConfig{ProjectName: "acme"}
			vc.Repositories.AppsDestinationRepo = tc.repo
			vc.Services = []types.ProjectServiceConfig{imageService("web", "nginx:1.27")}

			var out, errb bytes.Buffer
			warnings, keyless, err := generateAppManifests(t.Context(), vc, nil, tc.token, nil, &out, &errb)
			if err != nil || warnings != nil || keyless != nil {
				t.Fatalf("expected a silent no-op, got warnings=%v keyless=%v err=%v", warnings, keyless, err)
			}
		})
	}
}

// hasManifests is the bring-your-own guard: any root-level .yaml/.yml means "occupied", and an
// unreadable directory is treated conservatively as occupied.
func TestHasManifestsEdgeCases(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  bool
	}{
		{name: "empty dir", want: false},
		{name: "a yml", files: []string{"deploy.yml"}, want: true},
		{name: "uppercase extension", files: []string{"Deploy.YAML"}, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range tc.files {
				writeFileT(t, dir, f, "x")
			}
			if got := hasManifests(dir); got != tc.want {
				t.Errorf("hasManifests(%v) = %v, want %v", tc.files, got, tc.want)
			}
		})
	}

	if !hasManifests(t.TempDir() + "/missing") {
		t.Error("an unreadable directory must be treated as occupied (conservative)")
	}
}

// The summary suffixes render only when there is something to count.
func TestCountSuffixes(t *testing.T) {
	tests := []struct {
		n                int
		wantES, wantJobs string
	}{
		{n: 0, wantES: "", wantJobs: ""},
		{n: 1, wantES: " + 1 ExternalSecret(s)", wantJobs: " + 1 keyless bootstrap Job(s)"},
		{n: 3, wantES: " + 3 ExternalSecret(s)", wantJobs: " + 3 keyless bootstrap Job(s)"},
	}
	for _, tc := range tests {
		if got := esCountSuffix(tc.n); got != tc.wantES {
			t.Errorf("esCountSuffix(%d) = %q, want %q", tc.n, got, tc.wantES)
		}
		if got := jobCountSuffix(tc.n); got != tc.wantJobs {
			t.Errorf("jobCountSuffix(%d) = %q, want %q", tc.n, got, tc.wantJobs)
		}
	}
}
