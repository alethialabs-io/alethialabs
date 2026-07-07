// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"bytes"
	"os"
	"path/filepath"
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
		{"datadog observability", "observability", "datadog", false},
		{"grafana observability", "observability", "grafana", false},
		{"prometheus observability", "observability", "prometheus", false},
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
			if p.ModulePath() == "" {
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
