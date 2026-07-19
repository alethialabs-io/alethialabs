// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"regexp"
	"strings"
	"text/template"
)

// scmSafe bounds the SCM/namespace identifiers interpolated (unquoted) into the preview
// ApplicationSet YAML — a fail-closed guard so a hand-crafted apps repo URL / namespace prefix can
// never smuggle a YAML-special char (`:` `{` `"` `#`, whitespace, newline) into the rendered
// manifest. The `/` allows a nested gitlab group path in SCMOwner.
var scmSafe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// appsRepoSafe bounds the apps repo URL: an https/ssh git remote with no whitespace (the only chars
// that could break the YAML scalar it lands in). Deep validation happens when the runner clones it.
var appsRepoSafe = regexp.MustCompile(`^(https://|git@)\S+$`)

// W-f ephemeral PR-preview environments (#842). ArgoCD's ApplicationSet pullRequest generator
// discovers every OPEN pull request on the apps repo and renders one preview Application per PR:
// create-on-open, deploy the PR head_sha, destroy-on-close (the param disappears when the PR
// closes → ArgoCD prunes the Application through automated.prune). This is the standard ArgoCD
// preview-env pattern; the console only has to install this ApplicationSet on the Fabric once and
// pre-seed the SCM token Secret it reads.
//
// Unlike the always-on apps templates (user-apps-overlays.yaml), the preview ApplicationSet is NOT
// dropped into infra/templates/argocd — it must render ONLY when a team explicitly enables preview
// envs, so it renders through this self-contained entry point (called by the provisioner when the
// job snapshot carries preview.enabled) rather than the auto-discovered RenderApplications sweep.

// PreviewApplicationSetInput is the fully-resolved, secret-free context the preview ApplicationSet
// renders from. The console resolves it (apps repo, SCM coordinates, placement, TTL) and seeds the
// token Secret out-of-band via EnsurePreviewSCMSecret — the token itself NEVER enters this struct
// or a rendered manifest (the ApplicationSet references it by tokenRef → Secret).
type PreviewApplicationSetInput struct {
	// AppsRepo is the git URL of the manifests/apps repo whose OPEN PRs get a preview env, and the
	// source ArgoCD syncs each preview Application from. Empty → RenderPreviewApplicationSet gates out.
	AppsRepo string
	// SCMProvider selects the pullRequest generator backend: "github" or "gitlab".
	SCMProvider string
	// SCMOwner / SCMRepo identify the repo for the github pullRequest generator (owner + repo). For
	// gitlab, SCMOwner/SCMRepo are joined into the project path ("owner/repo").
	SCMOwner string
	SCMRepo  string
	// GitlabAPIURL overrides the gitlab API base (empty → gitlab.com); ignored for github.
	GitlabAPIURL string
	// TokenSecretName / TokenSecretKey point the generator's tokenRef at the pre-seeded SCM Secret in
	// the argocd namespace (see EnsurePreviewSCMSecret). The token value lives only in that Secret.
	TokenSecretName string
	TokenSecretKey  string
	// PlacementMode is the per-team placement of each preview env: "namespace" (a namespace per PR on
	// the shared Fabric — fully implemented) or "vcluster" (a vcluster per PR — forward-scaffolded:
	// v1 renders namespace-per-PR until per-PR vcluster provisioning ships; see #867).
	PlacementMode string
	// NamespacePrefix prefixes the per-PR destination namespace ("<prefix>-<pr-number>"). Empty →
	// "preview".
	NamespacePrefix string
	// SourcePath is the path within AppsRepo ArgoCD syncs (empty → "." — the repo root).
	SourcePath string
	// RequeueSeconds is how often ArgoCD re-polls the SCM for the open-PR set (0 → 300s).
	RequeueSeconds int
	// TTLHours caps a preview env's lifetime; stamped as an annotation for a follow-up reaper (ArgoCD
	// itself only tears down on PR close). 0 → no cap annotation.
	TTLHours int
	// Labels are the classification/sweep labels propagated onto every generated preview Application
	// (an ApplicationSet is not stamped by InjectCommonLabels, so it is propagated here).
	Labels map[string]string
}

// previewASName is the fixed name of the preview ApplicationSet (one per Fabric).
const previewASName = "preview-prs"

// previewASTemplate renders the preview ApplicationSet. The OUTER (Alethia text/template) resolves
// {{ .Field }} at render time; ArgoCD's OWN pullRequest params ({{ .number }} / {{ .head_sha }}) are
// emitted LITERALLY via backtick-escaping so ArgoCD — not Alethia — evaluates them at sync time.
const previewASTemplate = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ` + previewASName + `
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - pullRequest:
        {{- if eq .SCMProvider "gitlab" }}
        gitlab:
          project: {{ .SCMOwner }}/{{ .SCMRepo }}
          {{- if .GitlabAPIURL }}
          api: {{ .GitlabAPIURL }}
          {{- end }}
          tokenRef:
            secretName: {{ .TokenSecretName }}
            key: {{ .TokenSecretKey }}
        {{- else }}
        github:
          owner: {{ .SCMOwner }}
          repo: {{ .SCMRepo }}
          tokenRef:
            secretName: {{ .TokenSecretName }}
            key: {{ .TokenSecretKey }}
        {{- end }}
        requeueAfterSeconds: {{ .RequeueSeconds }}
  template:
    metadata:
      # ArgoCD resolves {{ "{{" }} .number {{ "}}" }} per open PR at sync time.
      name: 'preview-pr-{{ ` + "`{{ .number }}`" + ` }}'
      labels:
        alethia.dev/preview: "true"
        {{- range $k, $v := .Labels }}
        {{ $k }}: "{{ $v }}"
        {{- end }}
      annotations:
        alethia.dev/preview-pr: '{{ ` + "`{{ .number }}`" + ` }}'
        alethia.dev/preview-branch: '{{ ` + "`{{ .branch }}`" + ` }}'
        {{- if gt .TTLHours 0 }}
        alethia.dev/preview-ttl-hours: "{{ .TTLHours }}"
        {{- end }}
        {{- if eq .PlacementMode "vcluster" }}
        # placement: vcluster requested — v1 renders namespace-per-PR until per-PR vcluster
        # provisioning ships (#867); the annotation records the intent for that follow-up.
        alethia.dev/preview-placement: "vcluster"
        {{- else }}
        alethia.dev/preview-placement: "namespace"
        {{- end }}
    spec:
      project: apps
      source:
        repoURL: {{ .AppsRepo }}
        targetRevision: '{{ ` + "`{{ .head_sha }}`" + ` }}'
        path: {{ .SourcePath }}
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{ .NamespacePrefix }}-{{ ` + "`{{ .number }}`" + ` }}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
`

// RenderPreviewApplicationSet renders the preview ApplicationSet manifest for a Fabric from a
// secret-free input. It returns "" (no manifest) when AppsRepo is empty — the same render-gate
// convention as the always-on templates, so a mis-wired call installs nothing rather than a broken
// generator. Defaults are applied for SCMProvider ("github"), NamespacePrefix ("preview"),
// SourcePath ("."), and RequeueSeconds (300).
func RenderPreviewApplicationSet(in PreviewApplicationSetInput) (string, error) {
	if strings.TrimSpace(in.AppsRepo) == "" {
		return "", nil
	}
	if in.SCMOwner == "" || in.SCMRepo == "" {
		return "", fmt.Errorf("preview ApplicationSet requires SCM owner and repo")
	}
	if in.TokenSecretName == "" || in.TokenSecretKey == "" {
		return "", fmt.Errorf("preview ApplicationSet requires a tokenRef (secret name + key)")
	}

	ctx := in // copy so defaulting never mutates the caller's struct
	if ctx.SCMProvider == "" {
		ctx.SCMProvider = "github"
	}
	if ctx.NamespacePrefix == "" {
		ctx.NamespacePrefix = "preview"
	}
	if ctx.SourcePath == "" {
		ctx.SourcePath = "."
	}
	if ctx.RequeueSeconds <= 0 {
		ctx.RequeueSeconds = 300
	}
	if ctx.SCMProvider != "github" && ctx.SCMProvider != "gitlab" {
		return "", fmt.Errorf("unsupported preview SCM provider %q (want github|gitlab)", ctx.SCMProvider)
	}

	// Fail-closed charset guard: every value interpolated (unquoted) into the manifest is bounded so an
	// untrusted apps repo URL / namespace / path can't inject YAML (newline, `:` `{` `"` `#`, whitespace).
	if !appsRepoSafe.MatchString(ctx.AppsRepo) {
		return "", fmt.Errorf("preview ApplicationSet apps repo %q is not an https/ssh git URL", ctx.AppsRepo)
	}
	if ctx.GitlabAPIURL != "" && !appsRepoSafe.MatchString(ctx.GitlabAPIURL) {
		return "", fmt.Errorf("preview ApplicationSet gitlab api %q is not a valid URL", ctx.GitlabAPIURL)
	}
	for label, v := range map[string]string{
		"scm owner":        ctx.SCMOwner,
		"scm repo":         ctx.SCMRepo,
		"token secret":     ctx.TokenSecretName,
		"token key":        ctx.TokenSecretKey,
		"namespace prefix": ctx.NamespacePrefix,
		"source path":      ctx.SourcePath,
	} {
		if !scmSafe.MatchString(v) {
			return "", fmt.Errorf("preview ApplicationSet %s %q has unsafe characters", label, v)
		}
	}

	tmpl, err := template.New(previewASName).Parse(previewASTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse preview ApplicationSet template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, ctx); err != nil {
		return "", fmt.Errorf("failed to render preview ApplicationSet: %w", err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// previewSCMSecretManifest builds the Opaque Secret in the argocd namespace that the pullRequest
// generator's tokenRef reads. It is a plain Secret (not an ArgoCD repository/repo-creds Secret) —
// the generator only needs the SCM API token to enumerate open PRs.
func previewSCMSecretManifest(secretName, key, token string) string {
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: argocd
  labels:
    alethia.dev/preview: "true"
type: Opaque
data:
  %s: %s
`, secretName, key, b64([]byte(token)))
}

// EnsurePreviewSCMSecret applies the SCM token Secret the preview ApplicationSet's pullRequest
// generator reads (idempotent; re-applying refreshes a rotated token). Callers must pass a non-empty
// token — an empty token would silently break PR discovery. Mirrors EnsureExternalDNSSecret: the
// token lives ONLY in this Secret and is never rendered into the ApplicationSet manifest.
func EnsurePreviewSCMSecret(secretName, key, token string, stdout, stderr io.Writer) error {
	if token == "" {
		return fmt.Errorf("refusing to write an empty %s preview SCM token secret", secretName)
	}
	fmt.Fprintf(stdout, "Seeding preview SCM credential secret %s...\n", secretName)
	return ApplyManifest(previewSCMSecretManifest(secretName, key, token), stdout, stderr)
}
