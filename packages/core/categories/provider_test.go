// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestGet(t *testing.T) {
	tests := []struct {
		name     string
		category string
		slug     string
		wantErr  bool
	}{
		{"cloudflare dns", "dns", "cloudflare", false},
		{"vault secrets", "secrets", "vault", false},
		{"dockerhub registry", "registry", "dockerhub", false},
		{"generic-cr registry", "registry", "generic-cr", false},
		{"ghcr registry", "registry", "ghcr", false},
		{"ghcr-enterprise registry", "registry", "ghcr-enterprise", false},
		{"gitlab-cr registry", "registry", "gitlab-cr", false},
		{"quay registry", "registry", "quay", false},
		{"harbor registry", "registry", "harbor", false},
		{"docr registry", "registry", "docr", false},
		{"scaleway-cr registry", "registry", "scaleway-cr", false},
		{"ecr-xacct registry", "registry", "ecr-xacct", false},
		{"gar-xacct registry", "registry", "gar-xacct", false},
		{"acr-xacct registry", "registry", "acr-xacct", false},
		{"datadog observability", "observability", "datadog", false},
		{"grafana observability", "observability", "grafana", false},
		{"unknown slug", "dns", "route53again", true},
		{"wrong category", "registry", "cloudflare", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Get(tt.category, tt.slug)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for %s/%s", tt.category, tt.slug)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if p.Slug() != tt.slug || p.Category() != tt.category {
				t.Fatalf("got %s/%s, want %s/%s", p.Category(), p.Slug(), tt.category, tt.slug)
			}
			// registry providers are runner-seeded (a dockerconfigjson imagePullSecret applied
			// post-apply), so they legitimately carry NO tofu module — empty module_path is
			// expected there; every other category must declare one.
			if tt.category != "registry" && p.ModulePath() == "" {
				t.Fatalf("%s/%s has empty module path", tt.category, tt.slug)
			}
		})
	}
}

func TestCloudflareTfvarsAndValidate(t *testing.T) {
	p, err := Get("dns", "cloudflare")
	if err != nil {
		t.Fatal(err)
	}
	project := &types.ProjectConfig{}
	project.DNS = types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}

	// Missing credential → validation fails.
	missing := ComponentContext{Project: project, ProviderConfig: map[string]any{"zone_id": "z1"}}
	if err := p.Validate(missing); err == nil {
		t.Fatal("expected validation error for missing api_token")
	}

	ok := ComponentContext{
		Project:        project,
		Credentials:    map[string]string{"api_token": "tok"},
		ProviderConfig: map[string]any{"zone_id": "z1", "proxied": true},
	}
	if err := p.Validate(ok); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
	vars := p.Tfvars(ok)
	if vars["cloudflare_api_token"] != "tok" || vars["cloudflare_zone_id"] != "z1" {
		t.Fatalf("unexpected tfvars: %+v", vars)
	}
	if vars["proxied"] != true {
		t.Fatalf("expected proxied=true, got %v", vars["proxied"])
	}
}

// TestRegistryTfvarsAndValidate covers the credential-based registry providers
// that share the generic module. It exercises the three credential-mapping
// shapes: username+password (ghcr / generic — generic also needs a user-supplied
// registry_url), a single token used as both username and password (docr), and a
// fixed "nologin" username with a secret-key password (scaleway-cr).
// TestRegistryPullAuthAndValidate covers the credential-based registry providers, which are
// runner-seeded (no tofu module): each exposes a pullAuth mapping (host + username/password) the
// runner turns into a dockerconfigjson imagePullSecret. It exercises the three credential-mapping
// shapes: username+password (ghcr / generic — generic also needs a user-supplied registry_url), a
// single token used as both username and password (docr), and a fixed "nologin" username with a
// secret-key password (scaleway-cr).
func TestRegistryPullAuthAndValidate(t *testing.T) {
	t.Run("generic-cr needs url + username + password", func(t *testing.T) {
		p, err := Get("registry", "generic-cr")
		if err != nil {
			t.Fatal(err)
		}
		// Missing registry_url → fails even with creds.
		noURL := ComponentContext{Credentials: map[string]string{"username": "u", "password": "p"}}
		if err := p.Validate(noURL); err == nil {
			t.Fatal("expected validation error for missing registry_url")
		}
		// Missing creds → fails even with a url.
		noCred := ComponentContext{ProviderConfig: map[string]any{"registry_url": "https://reg.example.com"}}
		if err := p.Validate(noCred); err == nil {
			t.Fatal("expected validation error for missing credential")
		}
		ctx := ComponentContext{
			Credentials:    map[string]string{"username": "u", "password": "p"},
			ProviderConfig: map[string]any{"registry_url": "https://reg.example.com"},
		}
		if err := p.Validate(ctx); err != nil {
			t.Fatalf("unexpected validation error: %v", err)
		}
		host, user, pass, has := p.PullAuth(ctx)
		if !has || host != "https://reg.example.com" || user != "u" || pass != "p" {
			t.Fatalf("pullAuth = (%q, %q, %q, %v), want reg.example.com / u / p / true", host, user, pass, has)
		}
	})

	t.Run("ghcr pins ghcr.io and needs username + token", func(t *testing.T) {
		p, err := Get("registry", "ghcr")
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Validate(ComponentContext{Credentials: map[string]string{"username": "u"}}); err == nil {
			t.Fatal("expected validation error for missing token")
		}
		ctx := ComponentContext{Credentials: map[string]string{"username": "u", "password": "tok"}}
		if err := p.Validate(ctx); err != nil {
			t.Fatalf("unexpected validation error: %v", err)
		}
		host, user, pass, has := p.PullAuth(ctx)
		if !has || host != "https://ghcr.io" || user != "u" || pass != "tok" {
			t.Fatalf("pullAuth = (%q, %q, %q, %v), want ghcr.io / u / tok / true", host, user, pass, has)
		}
	})

	t.Run("docr uses the token as both username and password", func(t *testing.T) {
		p, err := Get("registry", "docr")
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Validate(ComponentContext{}); err == nil {
			t.Fatal("expected validation error for missing token")
		}
		ctx := ComponentContext{Credentials: map[string]string{"token": "dop_v1_abc"}}
		if err := p.Validate(ctx); err != nil {
			t.Fatalf("unexpected validation error: %v", err)
		}
		host, user, pass, has := p.PullAuth(ctx)
		if !has || host != "https://registry.digitalocean.com" || user != "dop_v1_abc" || pass != "dop_v1_abc" {
			t.Fatalf("pullAuth = (%q, %q, %q, %v), want docr / token / token / true", host, user, pass, has)
		}
	})

	t.Run("scaleway-cr fixes username to nologin and needs url + secret_key", func(t *testing.T) {
		p, err := Get("registry", "scaleway-cr")
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Validate(ComponentContext{ProviderConfig: map[string]any{"registry_url": "https://rg.fr-par.scw.cloud"}}); err == nil {
			t.Fatal("expected validation error for missing secret_key")
		}
		ctx := ComponentContext{
			Credentials:    map[string]string{"secret_key": "scw-secret"},
			ProviderConfig: map[string]any{"registry_url": "https://rg.fr-par.scw.cloud"},
		}
		if err := p.Validate(ctx); err != nil {
			t.Fatalf("unexpected validation error: %v", err)
		}
		host, user, pass, has := p.PullAuth(ctx)
		if !has || host != "https://rg.fr-par.scw.cloud" || user != "nologin" || pass != "scw-secret" {
			t.Fatalf("pullAuth = (%q, %q, %q, %v), want scw host / nologin / secret / true", host, user, pass, has)
		}
	})

	// The dominant-registry spec builder derives the pull-secret name as "<slug>-pull" and builds
	// the dockerconfigjson for a generic-set provider end-to-end (locks the naming + host wiring).
	t.Run("spec: ghcr → ghcr-pull dockerconfigjson", func(t *testing.T) {
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "ghcr"}},
			ConnectorCredentials: []types.ConnectorCredential{
				{Category: "registry", Slug: "ghcr", Credentials: map[string]string{"username": "u", "password": "tok"}},
			},
		}
		spec, err := DominantRegistryPullSecretSpec(vc)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if spec == nil || spec.Name != "ghcr-pull" || spec.Namespace != "default" {
			t.Fatalf("spec = %+v, want name ghcr-pull / ns default", spec)
		}
		if !strings.Contains(spec.DockerConfigJSON, "https://ghcr.io") {
			t.Fatalf("dockerconfigjson missing ghcr host: %s", spec.DockerConfigJSON)
		}
	})
}

func TestComposeWritesGuardsAndModuleFile(t *testing.T) {
	workDir := t.TempDir()
	vc := &types.ProjectConfig{}
	vc.DNS = types.ProjectDNSConfig{
		Enabled:        true,
		Provider:       "cloudflare",
		DomainName:     "example.com",
		ProviderConfig: map[string]any{"zone_id": "z1"},
	}
	vc.ConnectorCredentials = []types.ConnectorCredential{
		{Category: "dns", Slug: "cloudflare", Credentials: map[string]string{"api_token": "tok"}},
	}

	tfvars := map[string]any{}
	var log bytes.Buffer
	// Empty categoriesSrcDir → skip the file copy but still wire tfvars + module file.
	n, err := Compose(workDir, "", vc, tfvars, &log)
	if err != nil {
		t.Fatalf("compose failed: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 composed module, got %d", n)
	}
	if tfvars["dns_provider"] != "cloudflare" {
		t.Fatalf("expected dns_provider guard = cloudflare, got %v", tfvars["dns_provider"])
	}
	if tfvars["secrets_provider"] != "native" || tfvars["registry_provider"] != "native" {
		t.Fatalf("expected unused guards to default native: %+v", tfvars)
	}
	if _, err := os.Stat(filepath.Join(workDir, "_categories.tf.json")); err != nil {
		t.Fatalf("expected _categories.tf.json to be written: %v", err)
	}
}

func TestComposeMissingCredentialFails(t *testing.T) {
	vc := &types.ProjectConfig{}
	vc.DNS = types.ProjectDNSConfig{Enabled: true, Provider: "cloudflare", DomainName: "example.com"}
	// No credential attached → Validate inside Compose should fail.
	var log bytes.Buffer
	if _, err := Compose(t.TempDir(), "", vc, map[string]any{}, &log); err == nil {
		t.Fatal("expected compose to fail without a Cloudflare credential")
	}
}

func TestComposeCopiesModulesForPluggableProvider(t *testing.T) {
	workDir := t.TempDir()
	srcDir := t.TempDir()
	moduleDir := filepath.Join(srcDir, "secrets", "vault")
	if err := os.MkdirAll(moduleDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "main.tf"), []byte("output \"ok\" { value = true }\n"), 0644); err != nil {
		t.Fatal(err)
	}

	vc := &types.ProjectConfig{
		Secrets: []types.ProjectSecretConfig{
			{Name: "db-password", Provider: "vault", ProviderConfig: map[string]any{"path": "secret/data/db"}},
			{Name: "api-token", Provider: "native"},
			{Name: "legacy-token", Provider: "vault", ProviderConfig: map[string]any{"path": "secret/data/legacy"}},
		},
		ConnectorCredentials: []types.ConnectorCredential{
			{Category: "secrets", Slug: "vault", Credentials: map[string]string{"address": "https://vault.example.test", "token": "root"}},
		},
	}

	tfvars := map[string]any{}
	var log bytes.Buffer
	n, err := Compose(workDir, srcDir, vc, tfvars, &log)
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	if n != 1 {
		t.Fatalf("composed modules = %d, want 1", n)
	}
	if tfvars["secrets_provider"] != "vault" {
		t.Fatalf("secrets_provider = %v, want vault", tfvars["secrets_provider"])
	}
	if _, err := os.Stat(filepath.Join(workDir, "categories", "secrets", "vault", "main.tf")); err != nil {
		t.Fatalf("expected copied module file: %v", err)
	}
	if !bytes.Contains(log.Bytes(), []byte("Composed secrets provider: vault")) {
		t.Fatalf("compose log missing module message: %s", log.String())
	}
}

func TestDominantProviderWarnsAndIncludesAllItems(t *testing.T) {
	var log bytes.Buffer
	slug, items := dominantProvider([]providerItem{
		{provider: "", item: ComponentItem{Name: "native-empty"}},
		{provider: "vault", item: ComponentItem{Name: "primary"}},
		{provider: "native", item: ComponentItem{Name: "native-explicit"}},
		{provider: "other-vault", item: ComponentItem{Name: "secondary"}},
	}, &log, "secrets")

	if slug != "vault" {
		t.Fatalf("dominant provider = %q, want vault", slug)
	}
	if len(items) != 4 {
		t.Fatalf("items = %d, want all 4 items", len(items))
	}
	if !bytes.Contains(log.Bytes(), []byte("mixed secrets providers selected")) {
		t.Fatalf("expected mixed-provider warning, got %q", log.String())
	}
}

func TestDominantRegistryPullSecret(t *testing.T) {
	tests := []struct {
		name       string
		registries []types.ProjectContainerRegistryConfig
		want       string
	}{
		{"no registries", nil, ""},
		{"native only", []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "native"}}, ""},
		{"empty provider is native", []types.ProjectContainerRegistryConfig{{Name: "app", Provider: ""}}, ""},
		{"pluggable dockerhub", []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "dockerhub"}}, "dockerhub-pull"},
		{"native + pluggable → pluggable wins", []types.ProjectContainerRegistryConfig{
			{Name: "a", Provider: "native"}, {Name: "b", Provider: "dockerhub"},
		}, "dockerhub-pull"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vc := &types.ProjectConfig{ContainerRegistries: tt.registries}
			if got := DominantRegistryPullSecret(vc); got != tt.want {
				t.Errorf("DominantRegistryPullSecret() = %q, want %q", got, tt.want)
			}
		})
	}
}
