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

func TestFromServices_OnlyContainerServices(t *testing.T) {
	apps := FromServices([]types.DetectedService{
		{Name: "api", HasDockerfile: true, Port: 8080},
		{Name: "libs", HasDockerfile: false}, // no Dockerfile → skipped
	}, Options{Namespace: "demo", RegistryBase: "reg.example.com/proj", Domain: "example.com", ServiceAccount: "wi-sa"})
	if len(apps) != 1 {
		t.Fatalf("only container services should map to apps, got %d", len(apps))
	}
	a := apps[0]
	if a.Image != "reg.example.com/proj/api:latest" {
		t.Errorf("image = %q", a.Image)
	}
	if a.Host != "api.example.com" || a.Namespace != "demo" || a.ServiceAccount != "wi-sa" {
		t.Errorf("app opts not applied: %+v", a)
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
	y, err := RenderApp(App{Name: "web", Host: "web.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "kind: Ingress") || !strings.Contains(y, "host: web.example.com") {
		t.Errorf("Ingress should render with the host:\n%s", y)
	}
}

func TestRenderApp_Defaults(t *testing.T) {
	y, err := RenderApp(App{Name: "svc"})
	if err != nil {
		t.Fatal(err)
	}
	// Defaults: 2 replicas, port 8080, image svc:latest, namespace default.
	for _, want := range []string{"replicas: 2", "containerPort: 8080", "image: svc:latest", "namespace: default"} {
		if !strings.Contains(y, want) {
			t.Errorf("default missing %q:\n%s", want, y)
		}
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
		{Name: "app"}, {Name: "app"},
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
