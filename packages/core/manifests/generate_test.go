// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestFromServices_ResolvedImageWins(t *testing.T) {
	// A built repo-sourced service renders with its ResolvedImage digest URI — the W2
	// contract — and the options land on the app.
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:          "api",
			Type:          "deployment",
			Source:        types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api"},
			ResolvedImage: "123.dkr.ecr.eu-west-1.amazonaws.com/proj-api@sha256:abc123",
			Ports:         []types.ServicePort{{ContainerPort: 9000}},
			Replicas:      3,
		},
	}, Options{Namespace: "demo", Domain: "example.com", ServiceAccount: "wi-sa"})
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped, got %v", skipped)
	}
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}
	a := apps[0]
	if a.Image != "123.dkr.ecr.eu-west-1.amazonaws.com/proj-api@sha256:abc123" {
		t.Errorf("image = %q, want the resolved digest URI", a.Image)
	}
	if a.Port != 9000 || a.Replicas != 3 {
		t.Errorf("service config not applied: %+v", a)
	}
	if a.Host != "api.example.com" || a.Namespace != "demo" || a.ServiceAccount != "wi-sa" {
		t.Errorf("app opts not applied: %+v", a)
	}
}

func TestFromServices_PrebuiltImageAndSkips(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		// Prebuilt image → renders with Source.Image.
		{Name: "worker", Type: "deployment", Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1.2.3"}},
		// Repo-sourced but never BUILT → skipped, never a fabricated ":latest".
		{Name: "unbuilt", Type: "deployment", Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/x"}},
		// Workload type without a template yet → skipped + reported.
		{Name: "nightly", Type: "cronjob", Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/n:1"}},
	}, Options{})
	if len(apps) != 1 || apps[0].Image != "ghcr.io/acme/worker:1.2.3" {
		t.Fatalf("expected only the prebuilt worker to render, got %+v", apps)
	}
	if len(skipped) != 2 {
		t.Fatalf("expected 2 skips (unbuilt + cronjob), got %v", skipped)
	}
	for _, s := range skipped {
		if !strings.Contains(s, "unbuilt") && !strings.Contains(s, "nightly") {
			t.Errorf("skip reason should name the service: %q", s)
		}
	}
}

func TestRenderApp_EnvResourcesProbe(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "api",
		Image: "r/api@sha256:def",
		Port:  8080,
		Env:   []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
		Resources: &types.ServiceResources{
			Requests: types.ServiceResourceQuantities{CPU: "250m", Memory: "256Mi"},
			Limits:   types.ServiceResourceQuantities{CPU: "1", Memory: "1Gi"},
		},
		Probe: &types.ServiceProbe{Type: "http", Path: "/healthz", Port: 8080},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`name: "LOG_LEVEL"`,
		`value: "info"`,
		"cpu: 250m",
		"memory: 1Gi",
		"readinessProbe:",
		"livenessProbe:",
		"path: /healthz",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("manifest missing %q:\n%s", want, y)
		}
	}
}

func TestRenderApp_TCPProbe(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "q",
		Image: "r/q@sha256:aaa",
		Probe: &types.ServiceProbe{Type: "tcp", Port: 9000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "tcpSocket:") || !strings.Contains(y, "port: 9000") {
		t.Errorf("tcp probe not rendered:\n%s", y)
	}
	if strings.Contains(y, "httpGet:") {
		t.Errorf("tcp probe must not render httpGet:\n%s", y)
	}
}

func TestWriteManifests(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gen")
	written, err := WriteManifests(dir, []App{{Name: "api", Image: "r/api:1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 1 || written[0] != "api.yaml" {
		t.Fatalf("written = %v", written)
	}
	b, err := os.ReadFile(filepath.Join(dir, "api.yaml"))
	if err != nil || !strings.Contains(string(b), "kind: Deployment") {
		t.Errorf("api.yaml not written correctly: %v", err)
	}
}

func TestRenderApp_DeploymentAndService(t *testing.T) {
	y, err := RenderApp(App{
		Name:           "api",
		Namespace:      "demo",
		Image:          "reg.example.com/api:v1",
		Port:           8080,
		Replicas:       3,
		ServiceAccount: "api-sa",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"kind: Deployment",
		"kind: Service",
		"name: api",
		"namespace: demo",
		"image: reg.example.com/api:v1",
		"containerPort: 8080",
		"replicas: 3",
		"serviceAccountName: api-sa",
		"runAsNonRoot: true",
		"readOnlyRootFilesystem: true",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("manifest missing %q:\n%s", want, y)
		}
	}
	// No Host → no Ingress.
	if strings.Contains(y, "kind: Ingress") {
		t.Errorf("Ingress should not render without a Host")
	}
}

func TestRenderApp_IngressWhenHost(t *testing.T) {
	y, err := RenderApp(App{Name: "web", Image: "r/web:1", Host: "web.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "kind: Ingress") || !strings.Contains(y, "host: web.example.com") {
		t.Errorf("Ingress should render with the host:\n%s", y)
	}
}

func TestRenderApp_Defaults(t *testing.T) {
	y, err := RenderApp(App{Name: "svc", Image: "r/svc:1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	// Defaults: 2 replicas, port 8080, namespace default, scaffold resources.
	for _, want := range []string{"replicas: 2", "containerPort: 8080", "namespace: default", "cpu: 100m", "memory: 512Mi"} {
		if !strings.Contains(y, want) {
			t.Errorf("default missing %q:\n%s", want, y)
		}
	}
}

func TestRenderApp_EmptyImageIsAnError(t *testing.T) {
	// The ":latest" fallback is RETIRED: an empty image must fail loudly (verify's
	// IMAGE-001 rejects mutable/untagged images, so fabricating one ships a broken app).
	if _, err := RenderApp(App{Name: "svc"}); err == nil {
		t.Fatal("RenderApp with no image must error, not default to :latest")
	}
}

func TestGenerateManifests_FilePerApp(t *testing.T) {
	files, err := GenerateManifests([]App{
		{Name: "API", Image: "r/api:1"}, // uppercase → dns1123
		{Name: "web", Image: "r/web:1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := files["api.yaml"]; !ok {
		t.Errorf("expected api.yaml (name lowercased), got %v", keys(files))
	}
	if _, ok := files["web.yaml"]; !ok {
		t.Errorf("expected web.yaml, got %v", keys(files))
	}
}

func TestGenerateManifests_DuplicateNamesUnique(t *testing.T) {
	files, err := GenerateManifests([]App{
		{Name: "app", Image: "r/a:1"}, {Name: "app", Image: "r/b:1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Errorf("duplicate names should produce 2 files, got %d: %v", len(files), keys(files))
	}
	if _, ok := files["app-2.yaml"]; !ok {
		t.Errorf("second duplicate should be app-2.yaml, got %v", keys(files))
	}
}

func TestDNS1123(t *testing.T) {
	cases := map[string]string{
		"apps/My_Service": "apps-my-service",
		"  Web App  ":     "web-app",
		"---x---":         "x",
	}
	for in, want := range cases {
		if got := dns1123(in); got != want {
			t.Errorf("dns1123(%q) = %q, want %q", in, got, want)
		}
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestFromServices_ResolvesBindings locks the W3 injection contract (#617): a service's bindings
// become container env — non-secret facets (endpoint/port) as plain VALUES resolved from the
// provision's tofu outputs, credential facets as secretKeyRef into the ExternalSecret-materialized
// Secret. User-authored env is preserved and ordered first.
func TestFromServices_ResolvesBindings(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:   "api",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
			Env:    []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "database", Name: "orders-db"},
				Inject: []types.ServiceBindingInjection{
					{Env: "DATABASE_HOST", From: "endpoint"},
					{Env: "DATABASE_PORT", From: "port"},
					{Env: "DATABASE_USER", From: "username"},
					{Env: "DATABASE_PASSWORD", From: "password"},
				},
			}},
		},
	}, Options{Outputs: map[string]string{"rds_cluster_endpoint": "orders.abc.rds.amazonaws.com"}})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]

	// User env first, then binding VALUE facets (endpoint resolved from outputs, port defaulted).
	wantEnv := []types.ServiceEnvVar{
		{Name: "LOG_LEVEL", Value: "info"},
		{Name: "DATABASE_HOST", Value: "orders.abc.rds.amazonaws.com"},
		{Name: "DATABASE_PORT", Value: "5432"},
	}
	if len(a.Env) != len(wantEnv) {
		t.Fatalf("env = %+v, want %+v", a.Env, wantEnv)
	}
	for i, e := range wantEnv {
		if a.Env[i] != e {
			t.Errorf("env[%d] = %+v, want %+v", i, a.Env[i], e)
		}
	}

	// Credential facets → secretKeyRef into the shared-contract Secret; VALUES never inlined.
	wantSecret := []AppSecretEnv{
		{Env: "DATABASE_USER", SecretName: BindingSecretName("database", "orders-db"), SecretKey: "username"},
		{Env: "DATABASE_PASSWORD", SecretName: BindingSecretName("database", "orders-db"), SecretKey: "password"},
	}
	if len(a.SecretEnv) != len(wantSecret) {
		t.Fatalf("secretEnv = %+v, want %+v", a.SecretEnv, wantSecret)
	}
	for i, s := range wantSecret {
		if a.SecretEnv[i] != s {
			t.Errorf("secretEnv[%d] = %+v, want %+v", i, a.SecretEnv[i], s)
		}
	}
}

// TestBindingSecretName pins the render↔ExternalSecret (#618) contract: a deterministic, DNS-1123
// Secret name both lanes derive from {kind, target}. If this changes, #618 must change in lockstep.
func TestBindingSecretName(t *testing.T) {
	if got := BindingSecretName("database", "orders-db"); got != "alethia-bind-database-orders-db" {
		t.Errorf("BindingSecretName = %q", got)
	}
	// Name is sanitized to DNS-1123 (a Secret name must be) and is stable for the same input.
	a := BindingSecretName("cache", "My Cache")
	b := BindingSecretName("cache", "My Cache")
	if a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
	if strings.ContainsAny(a, " _") || a != strings.ToLower(a) {
		t.Errorf("not DNS-1123-safe: %q", a)
	}
}

// TestRenderApp_SecretEnv renders a workload whose only env is a binding credential — the env block
// must still emit with a valueFrom.secretKeyRef (not be skipped for want of plain env).
func TestRenderApp_SecretEnv(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "api",
		Image: "ghcr.io/acme/api:1",
		SecretEnv: []AppSecretEnv{
			{Env: "DATABASE_PASSWORD", SecretName: "alethia-bind-database-orders-db", SecretKey: "password"},
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		"valueFrom:",
		"secretKeyRef:",
		"name: alethia-bind-database-orders-db",
		"key: password",
		`- name: "DATABASE_PASSWORD"`,
	} {
		if !strings.Contains(y, want) {
			t.Errorf("rendered manifest missing %q:\n%s", want, y)
		}
	}
	if strings.Contains(y, ":latest") {
		t.Errorf("must never render :latest:\n%s", y)
	}
}
