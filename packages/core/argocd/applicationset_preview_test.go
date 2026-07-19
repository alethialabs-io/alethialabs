// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// baseInput is a fully-wired GitHub preview input the individual tests tweak.
func baseInput() PreviewApplicationSetInput {
	return PreviewApplicationSetInput{
		AppsRepo:        "https://github.com/acme/manifests",
		SCMProvider:     "github",
		SCMOwner:        "acme",
		SCMRepo:         "manifests",
		TokenSecretName: "preview-scm-token",
		TokenSecretKey:  "token",
		PlacementMode:   "namespace",
		NamespacePrefix: "preview",
		SourcePath:      "manifests",
		RequeueSeconds:  120,
		TTLHours:        48,
		Labels: map[string]string{
			"alethia.dev/classification": "internal",
		},
	}
}

// The preview ApplicationSet must carry a github pullRequest generator with a tokenRef, run under
// the "apps" AppProject, deploy each PR's head_sha into a per-PR namespace, and emit ArgoCD's OWN
// params LITERALLY (so ArgoCD, not Alethia, resolves them per open PR).
func TestRenderPreviewApplicationSet_GitHub(t *testing.T) {
	as, err := RenderPreviewApplicationSet(baseInput())
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	for _, want := range []string{
		"kind: ApplicationSet",
		"name: preview-prs",
		"pullRequest:",
		"github:",
		"owner: acme",
		"repo: manifests",
		"tokenRef:",
		"secretName: preview-scm-token",
		"key: token",
		"requeueAfterSeconds: 120",
		"project: apps",
		"repoURL: https://github.com/acme/manifests",
		"path: manifests",
		"name: 'preview-pr-{{ .number }}'",   // literal ArgoCD param
		"targetRevision: '{{ .head_sha }}'",  // literal ArgoCD param
		"namespace: 'preview-{{ .number }}'", // literal ArgoCD param, prefixed
		"prune: true",
		"selfHeal: true",
		"CreateNamespace=true",
		`alethia.dev/preview: "true"`,
		"alethia.dev/classification: \"internal\"", // propagated sweep label
		`alethia.dev/preview-ttl-hours: "48"`,
	} {
		if !strings.Contains(as, want) {
			t.Errorf("preview ApplicationSet missing %q:\n%s", want, as)
		}
	}
	// The ArgoCD params must NOT have been resolved by Alethia's Go template.
	if strings.Contains(as, "<no value>") || strings.Contains(as, "preview-pr-120") {
		t.Errorf("ArgoCD PR params were wrongly resolved at Alethia render time:\n%s", as)
	}
	// gitlab generator must be absent for a github input.
	if strings.Contains(as, "gitlab:") {
		t.Errorf("github input must not render a gitlab generator:\n%s", as)
	}
}

// A gitlab input renders the gitlab pullRequest generator with a project path, not github.
func TestRenderPreviewApplicationSet_GitLab(t *testing.T) {
	in := baseInput()
	in.SCMProvider = "gitlab"
	in.GitlabAPIURL = "https://gitlab.example.com/api/v4"
	as, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	for _, want := range []string{
		"gitlab:",
		"project: acme/manifests",
		"api: https://gitlab.example.com/api/v4",
		"tokenRef:",
		"secretName: preview-scm-token",
	} {
		if !strings.Contains(as, want) {
			t.Errorf("gitlab preview ApplicationSet missing %q:\n%s", want, as)
		}
	}
	if strings.Contains(as, "github:") {
		t.Errorf("gitlab input must not render a github generator:\n%s", as)
	}
}

// No apps repo → the ApplicationSet is gated out entirely (empty string), the same render-gate
// convention as the always-on templates.
func TestRenderPreviewApplicationSet_GatedOnAppsRepo(t *testing.T) {
	in := baseInput()
	in.AppsRepo = ""
	as, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	if as != "" {
		t.Errorf("preview ApplicationSet must render nothing without an apps repo, got:\n%s", as)
	}
}

// Defaults: an input with only the required fields defaults provider/prefix/path/requeue.
func TestRenderPreviewApplicationSet_Defaults(t *testing.T) {
	as, err := RenderPreviewApplicationSet(PreviewApplicationSetInput{
		AppsRepo:        "https://github.com/acme/manifests",
		SCMOwner:        "acme",
		SCMRepo:         "manifests",
		TokenSecretName: "preview-scm-token",
		TokenSecretKey:  "token",
	})
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	for _, want := range []string{
		"github:",                            // default provider
		"namespace: 'preview-{{ .number }}'", // default prefix
		"path: .",                            // default source path (repo root)
		"requeueAfterSeconds: 300",           // default requeue
	} {
		if !strings.Contains(as, want) {
			t.Errorf("defaulted preview ApplicationSet missing %q:\n%s", want, as)
		}
	}
	// TTL 0 → no ttl annotation.
	if strings.Contains(as, "preview-ttl-hours") {
		t.Errorf("TTLHours=0 must not stamp a ttl annotation:\n%s", as)
	}
}

// vcluster placement is forward-scaffolded: it renders namespace-per-PR but records the requested
// placement in an annotation for the per-PR-vcluster follow-up.
func TestRenderPreviewApplicationSet_VclusterScaffold(t *testing.T) {
	in := baseInput()
	in.PlacementMode = "vcluster"
	as, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	if !strings.Contains(as, `alethia.dev/preview-placement: "vcluster"`) {
		t.Errorf("vcluster request should record its placement intent:\n%s", as)
	}
	// Still namespace-per-PR until per-PR vcluster provisioning ships.
	if !strings.Contains(as, "namespace: 'preview-{{ .number }}'") {
		t.Errorf("vcluster v1 should still render namespace-per-PR:\n%s", as)
	}
}

// Validation: missing SCM coordinates, missing tokenRef, and an unsupported provider are errors.
func TestRenderPreviewApplicationSet_Validation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*PreviewApplicationSetInput)
	}{
		{"no owner", func(in *PreviewApplicationSetInput) { in.SCMOwner = "" }},
		{"no repo", func(in *PreviewApplicationSetInput) { in.SCMRepo = "" }},
		{"no token secret", func(in *PreviewApplicationSetInput) { in.TokenSecretName = "" }},
		{"no token key", func(in *PreviewApplicationSetInput) { in.TokenSecretKey = "" }},
		{"bad provider", func(in *PreviewApplicationSetInput) { in.SCMProvider = "bitbucket" }},
		// Fail-closed charset guards (YAML-injection defense).
		{"yaml-injecting owner", func(in *PreviewApplicationSetInput) { in.SCMOwner = "acme\n        evil: true" }},
		{"colon in repo", func(in *PreviewApplicationSetInput) { in.SCMRepo = "a:b" }},
		{"unsafe namespace prefix", func(in *PreviewApplicationSetInput) { in.NamespacePrefix = "pre view" }},
		{"non-url apps repo", func(in *PreviewApplicationSetInput) { in.AppsRepo = "ftp://evil/x" }},
		{"apps repo with space", func(in *PreviewApplicationSetInput) { in.AppsRepo = "https://github.com/a b" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := baseInput()
			tc.mutate(&in)
			if _, err := RenderPreviewApplicationSet(in); err == nil {
				t.Errorf("expected an error for %s", tc.name)
			}
		})
	}
}

// Rendering never defaults-mutates the caller's struct (defaulting works on a copy).
func TestRenderPreviewApplicationSet_NoCallerMutation(t *testing.T) {
	in := PreviewApplicationSetInput{
		AppsRepo:        "https://github.com/acme/manifests",
		SCMOwner:        "acme",
		SCMRepo:         "manifests",
		TokenSecretName: "s",
		TokenSecretKey:  "k",
	}
	if _, err := RenderPreviewApplicationSet(in); err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	if in.SCMProvider != "" || in.NamespacePrefix != "" || in.SourcePath != "" || in.RequeueSeconds != 0 {
		t.Errorf("defaulting must not mutate the caller's input: %+v", in)
	}
}

// EnsurePreviewSCMSecret refuses an empty token, and the seeded Secret b64-encodes the token
// (never the raw value) — the token must never appear in plaintext in a manifest.
func TestEnsurePreviewSCMSecret_TokenHandling(t *testing.T) {
	var out, errb bytes.Buffer
	if err := EnsurePreviewSCMSecret("preview-scm-token", "token", "", &out, &errb); err == nil {
		t.Errorf("expected an error seeding an empty token")
	}

	manifest := previewSCMSecretManifest("preview-scm-token", "token", "ghp_supersecret")
	if strings.Contains(manifest, "ghp_supersecret") {
		t.Errorf("the raw token must NEVER appear in the Secret manifest:\n%s", manifest)
	}
	wantB64 := base64.StdEncoding.EncodeToString([]byte("ghp_supersecret"))
	if !strings.Contains(manifest, wantB64) {
		t.Errorf("Secret manifest should carry the b64-encoded token:\n%s", manifest)
	}
	for _, want := range []string{
		"kind: Secret",
		"namespace: argocd",
		"name: preview-scm-token",
		"type: Opaque",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("Secret manifest missing %q:\n%s", want, manifest)
		}
	}
}

// The rendered ApplicationSet references the token only by tokenRef — no token material is ever
// part of the render input, so the manifest can never leak one.
func TestRenderPreviewApplicationSet_NoTokenInManifest(t *testing.T) {
	as, err := RenderPreviewApplicationSet(baseInput())
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	if !strings.Contains(as, "tokenRef:") {
		t.Errorf("preview ApplicationSet must reference the token by tokenRef:\n%s", as)
	}
}

// The rendered ApplicationSet + Secret must be structurally valid YAML — every ArgoCD param is
// single-quoted so the {{ }} placeholders survive as string scalars rather than breaking the parse.
func TestPreviewManifests_ValidYAML(t *testing.T) {
	as, err := RenderPreviewApplicationSet(baseInput())
	if err != nil {
		t.Fatalf("RenderPreviewApplicationSet: %v", err)
	}
	var appset map[string]any
	if err := yaml.Unmarshal([]byte(as), &appset); err != nil {
		t.Fatalf("preview ApplicationSet is not valid YAML: %v\n%s", err, as)
	}
	if appset["kind"] != "ApplicationSet" {
		t.Errorf("preview ApplicationSet kind = %v, want ApplicationSet", appset["kind"])
	}

	var secret map[string]any
	if err := yaml.Unmarshal([]byte(previewSCMSecretManifest("preview-scm-token", "token", "ghp_x")), &secret); err != nil {
		t.Fatalf("preview Secret is not valid YAML: %v", err)
	}
	if secret["kind"] != "Secret" {
		t.Errorf("preview Secret kind = %v, want Secret", secret["kind"])
	}
}
