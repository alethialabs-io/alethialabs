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

const kanikoTestDest = "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web"

func TestParseKanikoDigest(t *testing.T) {
	logs := `INFO[0042] Taking snapshot of full filesystem...
INFO[0055] Pushing image to 123.dkr.ecr.eu-west-1.amazonaws.com/proj-web:3f1a9c2b
INFO[0058] Pushed 123.dkr.ecr.eu-west-1.amazonaws.com/proj-web@sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff`
	want := "sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"
	if got := parseKanikoDigest(logs, kanikoTestDest); got != want {
		t.Errorf("parseKanikoDigest = %q, want %q", got, want)
	}
	if got := parseKanikoDigest("no digest here", kanikoTestDest); got != "" {
		t.Errorf("parseKanikoDigest on digest-less logs = %q, want empty", got)
	}
}

// THE REASON THE MATCH IS ANCHORED. A Dockerfile that pins its base by digest is the recommended
// supply-chain practice, and kaniko logs that base digest in EVERY attempt — including the ones
// that failed — before it logs anything about the push. `kubectl logs -l` emits selector-matched
// pods in Go MAP order, so a failed attempt's log routinely comes first.
//
// An unanchored `sha256:[a-f0-9]{64}` with FindString returns the base image's digest here. That
// is not a visible failure: `dest@sha256:<base>` passes isValidImageRef, passes verify's IMAGE-001
// because it IS digest-pinned, is persisted to resolved_image, renders into the Deployment, and
// dies at ImagePullBackOff with nothing saying the digest was wrong.
func TestParseKanikoDigestIgnoresABaseImageDigestFromAFailedAttempt(t *testing.T) {
	const base = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	const pushed = "sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"

	// Attempt 1 failed after resolving the digest-pinned base; attempt 2 succeeded. Map order put
	// the failure first, which is the arrangement that makes the unanchored read wrong.
	logs := "[pod/build-web-aaaaa] INFO[0001] Retrieving image manifest node@" + base + "\n" +
		"[pod/build-web-aaaaa] error building image: unexpected EOF\n" +
		"[pod/build-web-bbbbb] INFO[0001] Retrieving image manifest node@" + base + "\n" +
		"[pod/build-web-bbbbb] INFO[0058] Pushed " + kanikoTestDest + "@" + pushed

	got := parseKanikoDigest(logs, kanikoTestDest)
	if got == base {
		t.Fatalf("returned the BASE IMAGE digest %q — this ships a digest-pinned reference to an "+
			"image that was never built, and every downstream check passes it", got)
	}
	if got != pushed {
		t.Fatalf("parseKanikoDigest = %q, want the pushed digest %q", got, pushed)
	}
}

// A digest for a DIFFERENT destination must not answer for this one. The Job name
// (`job-name=build-<svc>`) is identical across runs and `delete job --wait=true` waits for the Job
// rather than its pods, so a previous run's pod can still be in the selector's result.
func TestParseKanikoDigestIgnoresAnotherDestinationsPush(t *testing.T) {
	const other = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	logs := "INFO[0058] Pushed 123.dkr.ecr.eu-west-1.amazonaws.com/proj-api@" + other

	if got := parseKanikoDigest(logs, kanikoTestDest); got != "" {
		t.Fatalf("parseKanikoDigest = %q for a push to a different repository — want empty so the "+
			"caller degrades to the git-SHA tag rather than pinning another service's image", got)
	}
}

// An empty destination cannot anchor anything, so it must answer nothing rather than match the
// first digest in the text.
func TestParseKanikoDigestWithNoDestinationAnswersNothing(t *testing.T) {
	logs := "INFO[0058] Pushed anything@sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"
	if got := parseKanikoDigest(logs, ""); got != "" {
		t.Fatalf("parseKanikoDigest with an empty dest = %q, want empty", got)
	}
}

// The destination is interpolated into a regexp, and a registry host carries dots. Unescaped, `.`
// matches any character, so a lookalike host would satisfy the anchor.
func TestParseKanikoDigestEscapesTheDestination(t *testing.T) {
	const d = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
	logs := "INFO[0058] Pushed 123Xdkr!ecr!eu-west-1!amazonaws!com/proj-web@" + d
	if got := parseKanikoDigest(logs, kanikoTestDest); got != "" {
		t.Fatalf("parseKanikoDigest = %q — the dots in the destination were treated as wildcards", got)
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
		// The length budget. This table held only short names, which is why #2032 survived: the
		// renderer caps the stem at 63-len("build-")=57 and the runner's hand-written copy did not,
		// so past 57 chars the watcher addressed a Job that does not exist. The authoritative
		// agreement test lives beside both derivations in packages/core/imagebuild.
		strings.Repeat("a", 58): "build-" + strings.Repeat("a", 57),
	}
	for in, want := range cases {
		if got := buildJobName(in); got != want {
			t.Errorf("buildJobName(%q) = %q, want %q", in, got, want)
		}
	}
}
