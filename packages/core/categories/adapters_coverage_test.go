// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestPcString(t *testing.T) {
	cases := []struct {
		name string
		pc   map[string]any
		key  string
		def  string
		want string
	}{
		{"nil map → def", nil, "k", "d", "d"},
		{"missing key → def", map[string]any{"other": "x"}, "k", "d", "d"},
		{"nil value → def", map[string]any{"k": nil}, "k", "d", "d"},
		{"empty string → def", map[string]any{"k": ""}, "k", "d", "d"},
		{"string value", map[string]any{"k": "v"}, "k", "d", "v"},
		{"non-string scalar formatted", map[string]any{"k": 42}, "k", "d", "42"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pcString(tc.pc, tc.key, tc.def); got != tc.want {
				t.Fatalf("pcString = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPcBool(t *testing.T) {
	cases := []struct {
		name string
		pc   map[string]any
		def  bool
		want bool
	}{
		{"nil map → def(true)", nil, true, true},
		{"missing → def(false)", map[string]any{"other": true}, false, false},
		{"nil value → def(true)", map[string]any{"k": nil}, true, true},
		{"real bool", map[string]any{"k": true}, false, true},
		{"string true", map[string]any{"k": "true"}, false, true},
		{"string false", map[string]any{"k": "false"}, true, false},
		{"non-bool/string → def(true)", map[string]any{"k": 1}, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pcBool(tc.pc, "k", tc.def); got != tc.want {
				t.Fatalf("pcBool = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCred(t *testing.T) {
	if got := cred(nil, "k", "d"); got != "d" {
		t.Fatalf("nil map → %q, want d", got)
	}
	if got := cred(map[string]string{"k": ""}, "k", "d"); got != "d" {
		t.Fatalf("empty value → %q, want d", got)
	}
	if got := cred(map[string]string{"other": "x"}, "k", "d"); got != "d" {
		t.Fatalf("missing → %q, want d", got)
	}
	if got := cred(map[string]string{"k": "v"}, "k", "d"); got != "v" {
		t.Fatalf("present → %q, want v", got)
	}
}

func TestItemNames(t *testing.T) {
	if got := itemNames(nil); len(got) != 0 {
		t.Fatalf("nil items → %v, want empty", got)
	}
	got := itemNames([]ComponentItem{{Name: "a"}, {Name: "b"}})
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("itemNames = %v", got)
	}
}

// mustGet resolves a provider or fails the test.
func mustGet(t *testing.T, category, slug string) *CategoryProvider {
	t.Helper()
	p, err := Get(category, slug)
	if err != nil {
		t.Fatalf("Get(%q,%q): %v", category, slug, err)
	}
	return p
}

func TestCloudflareResidualBranches(t *testing.T) {
	p := mustGet(t, "dns", "cloudflare")

	t.Run("zone_id sourced from the project when provider_config omits it", func(t *testing.T) {
		project := &types.ProjectConfig{}
		project.DNS = types.ProjectDNSConfig{ZoneID: "proj-zone", DomainName: "example.com"}
		ctx := ComponentContext{Project: project, Credentials: map[string]string{"api_token": "t"}}
		if err := p.Validate(ctx); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if vars := p.Tfvars(ctx); vars["cloudflare_zone_id"] != "proj-zone" || vars["domain_name"] != "example.com" {
			t.Fatalf("tfvars = %+v", vars)
		}
	})
	t.Run("missing zone_id (and no project zone) fails", func(t *testing.T) {
		project := &types.ProjectConfig{}
		project.DNS = types.ProjectDNSConfig{DomainName: "example.com"}
		ctx := ComponentContext{Project: project, Credentials: map[string]string{"api_token": "t"}}
		if err := p.Validate(ctx); err == nil {
			t.Fatal("expected an error for missing zone_id")
		}
	})
	t.Run("missing domain fails", func(t *testing.T) {
		ctx := ComponentContext{
			Project:        &types.ProjectConfig{},
			Credentials:    map[string]string{"api_token": "t"},
			ProviderConfig: map[string]any{"zone_id": "z"},
		}
		if err := p.Validate(ctx); err == nil {
			t.Fatal("expected an error for missing domain_name")
		}
	})
}

func TestObservabilityAndSecretsAdapters(t *testing.T) {
	t.Run("datadog", func(t *testing.T) {
		p := mustGet(t, "observability", "datadog")
		if err := p.Validate(ComponentContext{Credentials: map[string]string{"api_key": "a"}}); err == nil {
			t.Fatal("missing app_key should fail")
		}
		ok := ComponentContext{Credentials: map[string]string{"api_key": "a", "app_key": "b"}}
		if err := p.Validate(ok); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if v := p.Tfvars(ok); v["datadog_site"] != "datadoghq.com" {
			t.Fatalf("default site = %v, want datadoghq.com", v["datadog_site"])
		}
	})
	t.Run("grafana", func(t *testing.T) {
		p := mustGet(t, "observability", "grafana")
		creds := map[string]string{"instance_id": "i", "api_token": "t"}
		if err := p.Validate(ComponentContext{Credentials: creds}); err == nil {
			t.Fatal("missing remote_write_url should fail")
		}
		ok := ComponentContext{Credentials: creds, ProviderConfig: map[string]any{"remote_write_url": "https://rw"}}
		if err := p.Validate(ok); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if p.Tfvars(ok)["grafana_remote_write_url"] != "https://rw" {
			t.Fatal("remote_write_url not mapped")
		}
	})
	t.Run("vault", func(t *testing.T) {
		p := mustGet(t, "secrets", "vault")
		if err := p.Validate(ComponentContext{Credentials: map[string]string{"address": "a"}}); err == nil {
			t.Fatal("missing token should fail")
		}
		ok := ComponentContext{Credentials: map[string]string{"address": "a", "token": "t"}}
		v := p.Tfvars(ok)
		if v["vault_mount_path"] != "secret" || v["vault_kv_version"] != "2" {
			t.Fatalf("vault defaults = %+v", v)
		}
	})
	t.Run("dockerhub namespace defaults to username", func(t *testing.T) {
		p := mustGet(t, "registry", "dockerhub")
		ok := ComponentContext{Credentials: map[string]string{"username": "acme", "access_token": "t"}}
		if err := p.Validate(ok); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if v := p.Tfvars(ok); v["dockerhub_namespace"] != "acme" {
			t.Fatalf("namespace default = %v, want acme", v["dockerhub_namespace"])
		}
	})
}

func TestGetUnknownProviderErrors(t *testing.T) {
	if _, err := Get("dns", "does-not-exist"); err == nil {
		t.Fatal("expected error for unknown slug")
	}
	if _, err := Get("nope", "native"); err == nil {
		t.Fatal("expected error for unknown category")
	}
}

// A provider with no registered behavior returns the safe zero results (Tfvars empty, Validate nil).
func TestProviderNilBehavior(t *testing.T) {
	p := &CategoryProvider{}
	if got := p.Tfvars(ComponentContext{}); len(got) != 0 {
		t.Fatalf("nil-behavior Tfvars = %v, want empty", got)
	}
	if err := p.Validate(ComponentContext{}); err != nil {
		t.Fatalf("nil-behavior Validate = %v, want nil", err)
	}
}
