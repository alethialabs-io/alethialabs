// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// dockerhubProject wires a project selecting the dockerhub registry with the given creds.
func dockerhubProject(creds map[string]string) *types.ProjectConfig {
	vc := &types.ProjectConfig{
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "dockerhub"}},
	}
	if creds != nil {
		vc.ConnectorCredentials = []types.ConnectorCredential{
			{Category: "registry", Slug: "dockerhub", Credentials: creds},
		}
	}
	return vc
}

func TestDominantRegistryPullSecretSpec(t *testing.T) {
	// Native / none → no secret (nil, no error).
	for _, tt := range []struct {
		name       string
		registries []types.ProjectContainerRegistryConfig
	}{
		{"no registries", nil},
		{"native only", []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "native"}}},
		{"empty provider is native", []types.ProjectContainerRegistryConfig{{Name: "app", Provider: ""}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec, err := DominantRegistryPullSecretSpec(&types.ProjectConfig{ContainerRegistries: tt.registries})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if spec != nil {
				t.Fatalf("expected nil spec, got %+v", spec)
			}
		})
	}

	// A selected registry missing its credential fails closed (Validate), not a half-built secret.
	if _, err := DominantRegistryPullSecretSpec(dockerhubProject(nil)); err == nil {
		t.Fatal("expected a validation error for dockerhub with no credential")
	}

	// Fully connected → a dockerconfigjson secret named "<slug>-pull" in the app namespace, whose
	// payload authenticates against the Docker Hub v1 endpoint.
	spec, err := DominantRegistryPullSecretSpec(dockerhubProject(map[string]string{
		"username":     "alice",
		"access_token": "s3cr3t",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if spec == nil {
		t.Fatal("expected a spec for a connected dockerhub registry")
	}
	if spec.Name != "dockerhub-pull" {
		t.Errorf("Name = %q, want dockerhub-pull", spec.Name)
	}
	if spec.Namespace != "default" {
		t.Errorf("Namespace = %q, want default", spec.Namespace)
	}

	var doc struct {
		Auths map[string]struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Auth     string `json:"auth"`
		} `json:"auths"`
	}
	if err := json.Unmarshal([]byte(spec.DockerConfigJSON), &doc); err != nil {
		t.Fatalf("dockerconfigjson does not parse: %v\n%s", err, spec.DockerConfigJSON)
	}
	entry, ok := doc.Auths["https://index.docker.io/v1/"]
	if !ok {
		t.Fatalf("expected a Docker Hub v1 auths entry, got %+v", doc.Auths)
	}
	if entry.Username != "alice" || entry.Password != "s3cr3t" {
		t.Errorf("auths entry = %+v, want username=alice password=s3cr3t", entry)
	}
	if want := base64.StdEncoding.EncodeToString([]byte("alice:s3cr3t")); entry.Auth != want {
		t.Errorf("auth = %q, want %q", entry.Auth, want)
	}
}

func TestDockerhubPullAuth(t *testing.T) {
	p, err := Get("registry", "dockerhub")
	if err != nil {
		t.Fatal(err)
	}
	host, user, pass, ok := p.PullAuth(ComponentContext{
		Credentials: map[string]string{"username": "bob", "access_token": "tok"},
	})
	if !ok {
		t.Fatal("dockerhub should register a pullAuth")
	}
	if host != "https://index.docker.io/v1/" || user != "bob" || pass != "tok" {
		t.Errorf("PullAuth = (%q, %q, %q), want (docker v1, bob, tok)", host, user, pass)
	}
}
