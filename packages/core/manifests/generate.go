// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifests generates minimal, opinionated Kubernetes manifests (Deployment +
// Service + optional Ingress) for the project's first-class services (vc.Services — the
// W1 canvas model), so ArgoCD has something to deploy without the customer hand-writing
// YAML. It is the "generate" half of the apps story; the "bring-your-own" half simply
// points ArgoCD at the customer's repo.
//
// The container image is REAL (W2): a service renders with its ResolvedImage — the digest
// URI the BUILD job pushed — or its prebuilt Source.Image. There is deliberately no
// ":latest" fallback anymore (verify/k8s.go IMAGE-001 fails mutable/untagged images); a
// repo-sourced service that has not been built yet is skipped and reported, never
// rendered with a fabricated tag.
//
// Generation is pure + deterministic (a fixed App list → the same YAML) so it is
// golden-testable. Committing the output to the GitOps repo is the caller's job.
package manifests

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// App is one deployable service to render manifests for.
type App struct {
	// DNS-1123 name (also the Deployment/Service name + selector label value).
	Name string
	// Target namespace (defaults to "default" when empty).
	Namespace string
	// Fully-qualified container image — a digest URI (registry/repo@sha256:…) or a
	// pinned tag. REQUIRED: rendering fails on an empty image rather than fabricating
	// a mutable ":latest" (which verify/k8s.go IMAGE-001 rejects).
	Image string
	// Container/Service port. 0 → 8080.
	Port int
	// Replica count. 0 → 2.
	Replicas int
	// Optional external host; when set an Ingress is emitted.
	Host string
	// Optional ServiceAccount name (e.g. a workload-identity KSA).
	ServiceAccount string
	// Plain environment variables (values rendered quoted).
	Env []types.ServiceEnvVar
	// Compute requests/limits; nil → the opinionated scaffold defaults.
	Resources *types.ServiceResources
	// Readiness/liveness probe; nil → none.
	Probe *types.ServiceProbe
}

// normalize fills defaults + sanitizes the name to DNS-1123. The image deliberately has
// NO default — see App.Image.
func (a App) normalize() App {
	a.Name = dns1123(a.Name)
	if a.Name == "" {
		a.Name = "app"
	}
	if a.Namespace == "" {
		a.Namespace = "default"
	}
	if a.Port == 0 {
		a.Port = 8080
	}
	if a.Replicas == 0 {
		a.Replicas = 2
	}
	if a.Resources == nil {
		a.Resources = &types.ServiceResources{
			Requests: types.ServiceResourceQuantities{CPU: "100m", Memory: "128Mi"},
			Limits:   types.ServiceResourceQuantities{CPU: "500m", Memory: "512Mi"},
		}
	}
	if a.Probe != nil && a.Probe.Port == 0 {
		p := *a.Probe
		p.Port = a.Port
		a.Probe = &p
	}
	return a
}

var tmpl = template.Must(template.New("app").Parse(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
    app.kubernetes.io/managed-by: alethia
spec:
  replicas: {{ .Replicas }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Name }}
    spec:
      {{- if .ServiceAccount }}
      serviceAccountName: {{ .ServiceAccount }}
      {{- end }}
      containers:
        - name: {{ .Name }}
          image: {{ .Image }}
          ports:
            - containerPort: {{ .Port }}
          {{- if .Env }}
          env:
            {{- range .Env }}
            - name: {{ printf "%q" .Name }}
              value: {{ printf "%q" .Value }}
            {{- end }}
          {{- end }}
          resources:
            requests:
              cpu: {{ .Resources.Requests.CPU }}
              memory: {{ .Resources.Requests.Memory }}
            limits:
              cpu: {{ .Resources.Limits.CPU }}
              memory: {{ .Resources.Limits.Memory }}
          {{- if .Probe }}
          readinessProbe:
            {{- if eq .Probe.Type "http" }}
            httpGet:
              path: {{ if .Probe.Path }}{{ .Probe.Path }}{{ else }}/{{ end }}
              port: {{ .Probe.Port }}
            {{- else }}
            tcpSocket:
              port: {{ .Probe.Port }}
            {{- end }}
          livenessProbe:
            {{- if eq .Probe.Type "http" }}
            httpGet:
              path: {{ if .Probe.Path }}{{ .Probe.Path }}{{ else }}/{{ end }}
              port: {{ .Probe.Port }}
            {{- else }}
            tcpSocket:
              port: {{ .Probe.Port }}
            {{- end }}
          {{- end }}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
spec:
  selector:
    app.kubernetes.io/name: {{ .Name }}
  ports:
    - port: 80
      targetPort: {{ .Port }}
      protocol: TCP
{{- if .Host }}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
spec:
  rules:
    - host: {{ .Host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Name }}
                port:
                  number: 80
{{- end }}
`))

// RenderApp renders the Deployment (+ Service + optional Ingress) YAML for one app.
// An empty image is an ERROR, not a ":latest" default — a mutable/untagged image fails
// the elench verify gate (IMAGE-001), so fabricating one here would ship a broken app.
func RenderApp(app App) (string, error) {
	a := app.normalize()
	if a.Image == "" {
		return "", fmt.Errorf("render %s: no container image (repo-sourced services must be BUILT first — resolved_image is empty)", a.Name)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, a); err != nil {
		return "", fmt.Errorf("render %s: %w", a.Name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// GenerateManifests renders every app to a `<name>.yaml` file map (filename → YAML),
// deterministically ordered by name. Duplicate names are suffixed to keep files unique.
func GenerateManifests(apps []App) (map[string]string, error) {
	out := map[string]string{}
	seen := map[string]int{}
	names := make([]string, 0, len(apps))
	for _, app := range apps {
		a := app.normalize()
		names = append(names, a.Name)
	}
	sort.Strings(names)

	for _, app := range apps {
		a := app.normalize()
		yaml, err := RenderApp(a)
		if err != nil {
			return nil, err
		}
		file := a.Name + ".yaml"
		if seen[a.Name] > 0 {
			file = fmt.Sprintf("%s-%d.yaml", a.Name, seen[a.Name]+1)
		}
		seen[a.Name]++
		out[file] = yaml
	}
	return out, nil
}

// Options control how services map to Apps.
type Options struct {
	// Namespace all apps deploy into.
	Namespace string
	// ServiceAccount to bind (e.g. a workload-identity KSA); optional.
	ServiceAccount string
	// Base domain; when set, each app gets an Ingress at "<name>.<domain>".
	Domain string
}

// FromServices builds Apps from the project's FIRST-CLASS services (vc.Services — the W1
// model), replacing the retired scanner-DetectedService path. Image precedence per
// service: ResolvedImage (the digest URI the W2 BUILD pushed) over Source.Image (the
// user's prebuilt image). There is NO ":latest" fallback — the retired scanner path's
// `<name>:latest` default is exactly what verify/k8s.go IMAGE-001 fails.
//
// Not everything renders: a repo-sourced service that has not been built yet has no image,
// and only type=="deployment" has a template today (job/cronjob/statefulset rendering is a
// follow-up lane). Those are returned in `skipped` (name: reason) so the caller REPORTS
// them — a silent drop would read as "deployed" when it wasn't.
func FromServices(services []types.ProjectServiceConfig, opts Options) (apps []App, skipped []string) {
	apps = make([]App, 0, len(services))
	for _, s := range services {
		name := dns1123(s.Name)
		if s.Type != "" && s.Type != "deployment" {
			skipped = append(skipped, fmt.Sprintf("%s: workload type %q has no manifest template yet", name, s.Type))
			continue
		}
		image := s.ResolvedImage
		if image == "" && s.Source.Kind == "image" {
			image = s.Source.Image
		}
		if image == "" {
			skipped = append(skipped, fmt.Sprintf("%s: repo-sourced service not built yet (resolved_image empty)", name))
			continue
		}
		port := 0
		if len(s.Ports) > 0 {
			port = s.Ports[0].ContainerPort
		}
		host := ""
		if opts.Domain != "" {
			host = name + "." + opts.Domain
		}
		apps = append(apps, App{
			Name:           name,
			Namespace:      opts.Namespace,
			Image:          image,
			Port:           port,
			Replicas:       s.Replicas,
			Host:           host,
			ServiceAccount: opts.ServiceAccount,
			Env:            s.Env,
			Resources:      s.Resources,
			Probe:          s.Probe,
		})
	}
	return apps, skipped
}

// WriteManifests renders the apps and writes each "<name>.yaml" into dir (created if
// needed). The caller (the runner's deploy step) then commits dir to the GitOps repo
// ArgoCD syncs. Returns the filenames written.
func WriteManifests(dir string, apps []App) ([]string, error) {
	files, err := GenerateManifests(apps)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	written := make([]string, 0, len(files))
	for name, yaml := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(yaml), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", name, err)
		}
		written = append(written, name)
	}
	sort.Strings(written)
	return written, nil
}

// dns1123 lowercases + strips a string to a valid DNS-1123 label.
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
