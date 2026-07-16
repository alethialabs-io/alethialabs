// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package imagebuild renders the Kubernetes Job that builds a repo-sourced service's image
// with kaniko and pushes it to a cloud registry (ECR first). It is the "build" half of
// the W2 image build & push wave: W1 gave a service a Source ({kind:"repo"|"image"}) and
// a Build (Dockerfile/context); this turns a repo Source into a real, pushed image so the
// workload no longer runs a "<name>:latest" placeholder.
//
// kaniko is used because the build runs rootless, in the customer's own provisioned
// cluster, with NO docker daemon — pushing to ECR via the pod ServiceAccount's IRSA. The
// Amazon ECR credential helper is built into the kaniko executor image and auto-detects
// "*.dkr.ecr.*.amazonaws.com" registries; IRSA is picked up via the default AWS credential
// chain once AWS_SDK_LOAD_CONFIG=true (set on the container here).
//
// Generation is pure + deterministic (a fixed service+Options → the same YAML) so it is
// golden-testable, exactly like packages/core/manifests. Applying the Job in-cluster,
// watching it, and reading back the pushed digest is the runner's job (W2 #588): kaniko
// writes the image-name-with-digest to DigestFilePath (/dev/termination-log), so the
// runner reads it from the Job pod's terminationMessage — no exec, no sidecar.
package imagebuild

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	// DefaultKanikoImage is the pinned kaniko executor. kaniko is archived upstream, so we
	// pin an explicit release (never ":latest") for reproducible builds; override via Options.
	DefaultKanikoImage = "gcr.io/kaniko-project/executor:v1.23.2"
	// DefaultNamespace is where build Jobs run (a dedicated, non-workload namespace).
	DefaultNamespace = "alethia-build"
	// DefaultDockerfile is kaniko's own default when a service pins no Dockerfile.
	DefaultDockerfile = "Dockerfile"
	// DigestFilePath is where kaniko writes "<destination>@sha256:…" (--image-name-with-digest-file).
	// It is /dev/termination-log so the runner (W2 #588) reads the digest straight from the
	// Job pod's terminationMessage. This path is the renderer↔runner contract — keep it stable.
	DigestFilePath = "/dev/termination-log"
	// DefaultBackoffLimit keeps a failing build from retrying endlessly.
	DefaultBackoffLimit = 1
)

// Options carries the runtime-resolved inputs the renderer cannot derive from the service
// alone — the concrete registry destination, the git ref/commit being built, and the
// keyless push identity. The runner (W2 #588) fills these from the provisioned ECR URL
// (#586), the commit it resolved, and the build ServiceAccount.
type Options struct {
	// Destination is the registry image ref WITHOUT a tag, e.g.
	// "<acct>.dkr.ecr.<region>.amazonaws.com/<repo>". The pushed image is "<Destination>:<Tag>".
	Destination string
	// Tag for the pushed image — typically the git commit SHA (immutable, reproducible).
	Tag string
	// GitContext is kaniko's fully-formed git context: "git://<url>#<ref>[#<commit>]".
	// The runner builds it (it knows the resolved commit); the renderer stays pure.
	GitContext string
	// ServiceAccount bound to the build pod — IRSA-scoped for ECR push (provisioned by #586).
	ServiceAccount string
	// Namespace the Job runs in; "" → DefaultNamespace.
	Namespace string
	// KanikoImage overrides the pinned executor; "" → DefaultKanikoImage.
	KanikoImage string
	// GitCredSecret names a Secret (key "token") holding a git PAT for a private repo,
	// surfaced to kaniko as GIT_TOKEN. The runner creates it; "" → public repo (no secret ref).
	// No secret material is ever inlined into the rendered manifest.
	GitCredSecret string
	// BackoffLimit for the Job; 0 → DefaultBackoffLimit.
	BackoffLimit int
}

// jobParams is the flattened, defaulted view the template renders (mirrors manifests.App).
type jobParams struct {
	Name           string
	Namespace      string
	KanikoImage    string
	GitContext     string
	Dockerfile     string
	ContextSubPath string
	Destination    string
	DigestFile     string
	ServiceAccount string
	GitCredSecret  string
	BackoffLimit   int
}

var jobTmpl = template.Must(template.New("build-job").Parse(`apiVersion: batch/v1
kind: Job
metadata:
  name: build-{{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: build-{{ .Name }}
    app.kubernetes.io/managed-by: alethia
    alethia.io/build-service: {{ .Name }}
spec:
  backoffLimit: {{ .BackoffLimit }}
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: build-{{ .Name }}
        app.kubernetes.io/managed-by: alethia
    spec:
      restartPolicy: Never
      serviceAccountName: {{ .ServiceAccount }}
      containers:
        - name: kaniko
          image: {{ .KanikoImage }}
          args:
            - --context={{ .GitContext }}
            - --dockerfile={{ .Dockerfile }}
{{- if .ContextSubPath }}
            - --context-sub-path={{ .ContextSubPath }}
{{- end }}
            - --destination={{ .Destination }}:{{ .Tag }}
            - --image-name-with-digest-file={{ .DigestFile }}
          env:
            - name: AWS_SDK_LOAD_CONFIG
              value: "true"
{{- if .GitCredSecret }}
            - name: GIT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .GitCredSecret }}
                  key: token
{{- end }}
          terminationMessagePath: {{ .DigestFile }}
          terminationMessagePolicy: File
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
`))

// RenderBuildJob renders the kaniko build Job YAML for one repo-sourced service. It errors
// for a prebuilt-image service (source.kind=="image" — nothing to build) and for missing
// runtime inputs (destination/tag/git context/service account). The dockerfile and build
// context-sub-path are derived from the service's Build/Source; everything registry- and
// commit-specific comes from Options.
func RenderBuildJob(service types.ProjectServiceConfig, opts Options) (string, error) {
	if service.Source.Kind != "repo" {
		return "", fmt.Errorf("build: service %q source.kind=%q is not buildable (only %q)", service.Name, service.Source.Kind, "repo")
	}
	name := dns1123(service.Name)
	if name == "" {
		return "", fmt.Errorf("build: service has no usable name")
	}
	if strings.TrimSpace(opts.Destination) == "" || strings.TrimSpace(opts.Tag) == "" {
		return "", fmt.Errorf("build: %q needs a Destination and Tag", name)
	}
	if strings.TrimSpace(opts.GitContext) == "" {
		return "", fmt.Errorf("build: %q needs a GitContext", name)
	}
	if strings.TrimSpace(opts.ServiceAccount) == "" {
		return "", fmt.Errorf("build: %q needs a ServiceAccount (IRSA for ECR push)", name)
	}

	p := jobParams{
		Name:           name,
		Namespace:      orDefault(opts.Namespace, DefaultNamespace),
		KanikoImage:    orDefault(opts.KanikoImage, DefaultKanikoImage),
		GitContext:     opts.GitContext,
		Dockerfile:     dockerfileOf(service),
		ContextSubPath: contextSubPathOf(service),
		Destination:    strings.TrimRight(opts.Destination, "/"),
		DigestFile:     DigestFilePath,
		ServiceAccount: opts.ServiceAccount,
		GitCredSecret:  strings.TrimSpace(opts.GitCredSecret),
		BackoffLimit:   orDefaultInt(opts.BackoffLimit, DefaultBackoffLimit),
	}

	// Destination:Tag are separate template fields to keep the Destination "/" trim above.
	data := struct {
		jobParams
		Tag string
	}{jobParams: p, Tag: opts.Tag}

	var buf bytes.Buffer
	if err := jobTmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("build: render %s: %w", name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// dockerfileOf returns the service's pinned Dockerfile path, defaulting to kaniko's default.
func dockerfileOf(s types.ProjectServiceConfig) string {
	if s.Build != nil && strings.TrimSpace(s.Build.Dockerfile) != "" {
		return strings.TrimSpace(s.Build.Dockerfile)
	}
	return DefaultDockerfile
}

// contextSubPathOf picks the sub-directory kaniko should build from: an explicit
// build.context wins, else the service's source.path (its location in the repo), else none.
func contextSubPathOf(s types.ProjectServiceConfig) string {
	if s.Build != nil && strings.TrimSpace(s.Build.Context) != "" {
		return strings.Trim(strings.TrimSpace(s.Build.Context), "/")
	}
	return strings.Trim(strings.TrimSpace(s.Source.Path), "/")
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

func orDefaultInt(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// dns1123 lowercases + strips a string to a valid DNS-1123 label. Copied from
// packages/core/manifests (kept local so this package owns its scope and takes no
// dependency on the manifests package's internals).
func dns1123(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '/' || r == ' ' || r == '.':
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
