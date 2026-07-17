// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit proofs for the BUILD handler's pure seams (#588): the digest-map metadata shape the
// W2 contract locks (#585), the kaniko log→digest capture, the git-context pinning, the
// tofu output extraction, and — load-bearing — that the metadata scrubber KEEPS the
// (non-secret) digest map while credential-shaped keys never survive around it.
package agent

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestRepoSourcedServices(t *testing.T) {
	svcs := []types.ProjectServiceConfig{
		{Name: "web", Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/web"}},
		{Name: "worker", Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1"}},
		{Name: "api", Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api"}},
	}
	got := repoSourcedServices(svcs)
	if len(got) != 2 || got[0].Name != "web" || got[1].Name != "api" {
		t.Fatalf("repoSourcedServices = %+v, want web+api", got)
	}
}

func TestGitContextFor(t *testing.T) {
	sha := "3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3"
	cases := map[string]string{
		"https://github.com/acme/web":     "git://github.com/acme/web.git#" + sha,
		"https://github.com/acme/web.git": "git://github.com/acme/web.git#" + sha,
		"https://github.com/acme/web/":    "git://github.com/acme/web.git#" + sha,
		"git://github.com/acme/web.git":   "git://github.com/acme/web.git#" + sha,
		"http://gitea.local/acme/web":     "git://gitea.local/acme/web.git#" + sha,
	}
	for in, want := range cases {
		if got := gitContextFor(in, sha); got != want {
			t.Errorf("gitContextFor(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseKanikoDigest(t *testing.T) {
	logs := `INFO[0042] Taking snapshot of full filesystem...
INFO[0055] Pushing image to 123.dkr.ecr.eu-west-1.amazonaws.com/proj-web:3f1a9c2b
INFO[0058] Pushed 123.dkr.ecr.eu-west-1.amazonaws.com/proj-web@sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff`
	want := "sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"
	if got := parseKanikoDigest(logs); got != want {
		t.Errorf("parseKanikoDigest = %q, want %q", got, want)
	}
	if got := parseKanikoDigest("no digest here"); got != "" {
		t.Errorf("parseKanikoDigest on digest-less logs = %q, want empty", got)
	}
}

func TestExtractOutputStringMap(t *testing.T) {
	// tofu `output -json` envelope: {key: {value: {...}, type: ...}}.
	outputs := map[string]interface{}{
		"ecr_repository_urls_map": map[string]interface{}{
			"value": map[string]interface{}{
				"web": "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web",
				"api": "123.dkr.ecr.eu-west-1.amazonaws.com/proj-api",
			},
			"type": []interface{}{"map", "string"},
		},
	}
	m := extractOutputStringMap(outputs, "ecr_repository_urls_map")
	if m["web"] != "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web" || len(m) != 2 {
		t.Fatalf("enveloped map not extracted: %v", m)
	}
	// Bare (un-enveloped) map still works.
	bare := map[string]interface{}{"k": map[string]interface{}{"web": "u"}}
	if m := extractOutputStringMap(bare, "k"); m["web"] != "u" {
		t.Fatalf("bare map not extracted: %v", m)
	}
	if m := extractOutputStringMap(outputs, "missing"); m != nil {
		t.Fatalf("missing key should be nil, got %v", m)
	}
}

func TestSplitBuildServiceAccount(t *testing.T) {
	ns, sa := splitBuildServiceAccount("alethia-build:kaniko-builder")
	if ns != "alethia-build" || sa != "kaniko-builder" {
		t.Fatalf("split = %q/%q", ns, sa)
	}
	// Absent/malformed output → the fixed defaults (mirroring irsa.tf's locals).
	for _, bad := range []string{"", "nocolon", ":sa", "ns:"} {
		ns, sa := splitBuildServiceAccount(bad)
		if ns != defaultBuildNamespace || sa != defaultBuildServiceAccount {
			t.Errorf("splitBuildServiceAccount(%q) = %q/%q, want defaults", bad, ns, sa)
		}
	}
}

// TestBuildResultSurvivesScrub is the contract's security half: the per-service digest map
// is NON-SECRET and must reach the console intact, while a credential-shaped key riding in
// the same metadata blob must be dropped by the whole-tree scrubber. (The runner never
// holds a registry credential at all — the build authenticates in-cluster via IRSA — so
// this guards against a future regression that would smuggle one into metadata.)
func TestBuildResultSurvivesScrub(t *testing.T) {
	digest := "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web@sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"
	metadata := map[string]any{
		buildResultKey: map[string]any{"web": digest},
		// A cred-shaped key must never survive, wherever it rides.
		"registry_password": "hunter2",
	}
	scrubMetadataTree(metadata)

	br, ok := metadata[buildResultKey].(map[string]any)
	if !ok {
		t.Fatalf("build_result dropped by the scrubber: %v", metadata)
	}
	if br["web"] != digest {
		t.Errorf("digest mutated by the scrubber: %v", br["web"])
	}
	if _, leaked := metadata["registry_password"]; leaked {
		t.Error("credential-shaped key survived the scrubber")
	}
	if strings.Contains(digest, "password") {
		t.Error("test digest accidentally cred-shaped")
	}
}

// buildJobName must mirror the imagebuild renderer's "build-<dns1123>" naming so the
// watcher addresses the Job the manifest actually creates.
func TestBuildJobName(t *testing.T) {
	cases := map[string]string{
		"web":       "build-web",
		"My_API":    "build-my-api",
		" Web App ": "build-web-app",
	}
	for in, want := range cases {
		if got := buildJobName(in); got != want {
			t.Errorf("buildJobName(%q) = %q, want %q", in, got, want)
		}
	}
}
