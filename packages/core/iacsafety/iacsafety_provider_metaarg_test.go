// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import "testing"

// #2030 regression: OpenTofu derives a resource/data/ephemeral block's provider
// local name from its `provider =` meta-argument when one is present — the type
// prefix applies only in its absence — so `provider = evilprov` on an
// allowlisted resource type makes the module require hashicorp/evilprov, which
// `tofu providers` confirms and `tofu init` downloads and executes. The gate
// read only the type prefix (native and JSON alike) and reported OK=true.
// Same family: a provider BLOCK label went through the type-prefix underscore
// split, so `provider "foo_bar"` was checked as "foo" — excusable by the wrong
// declaration (fail-open) and blind to the right one (false positive).

// nullDecl declares the allowlisted hashicorp/null so each tree passes rule 1
// and isolates the implied-provider path under test.
const nullDecl = `terraform {
  required_providers {
    null = { source = "hashicorp/null" }
  }
}

`

func TestProviderMetaArgumentIsGated(t *testing.T) {
	deny := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "native resource pins an unvetted provider",
			files: map[string]string{"main.tf": nullDecl + `resource "null_resource" "x" {
  provider = evilprov
}
`},
		},
		{
			name: "native ephemeral pins an unvetted provider",
			files: map[string]string{"main.tf": nullDecl + `ephemeral "null_secret" "x" {
  provider = evilprov
}
`},
		},
		{
			name: "native data source pins an unvetted provider",
			files: map[string]string{"main.tf": nullDecl + `data "null_data_source" "x" {
  provider = evilprov.alias
}
`},
		},
		{
			name: "json resource pins an unvetted provider",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"null": {"source": "hashicorp/null"}}},
  "resource": {"null_resource": {"x": {"provider": "evilprov"}}}
}`},
		},
		{
			name: "json data source pins an unvetted provider via alias",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"null": {"source": "hashicorp/null"}}},
  "data": {"null_data_source": {"x": {"provider": "evilprov.alias"}}}
}`},
		},
		{
			name: "json template spelling pins an unvetted provider",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"null": {"source": "hashicorp/null"}}},
  "resource": {"null_resource": {"x": {"provider": "${evilprov.alias}"}}}
}`},
		},
		{
			name: "json check-scoped data pins an unvetted provider",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"null": {"source": "hashicorp/null"}}},
  "check": {"c": {"data": {"null_data_source": {"x": {"provider": "evilprov"}}}}}
}`},
		},
		{
			// The provider BLOCK label is the local name verbatim: with only
			// `foo` declared, `provider "foo_bar"` requires hashicorp/foo_bar.
			// The underscore split checked "foo" and let this through.
			name: "provider block label must not be excused via its underscore prefix",
			files: map[string]string{"main.tf": `terraform {
  required_providers {
    foo = { source = "hashicorp/null" }
  }
}

provider "foo_bar" {}
`},
		},
	}
	for _, tc := range deny {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Scan(writeTree(t, tc.files), nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if rep.OK {
				t.Fatalf("SECURITY HOLE: gate returned OK=true — init would fetch an unvetted provider binary (findings=%+v)", rep.Findings)
			}
			if !hasRule(rep, RuleProviderImplied) {
				t.Errorf("denied but without rule %q (findings: %+v)", RuleProviderImplied, rep.Findings)
			}
		})
	}
}

// TestProviderMetaArgumentControls is the discrimination side: pinning an
// allowlisted or own-declared provider, the builtin terraform provider, and a
// declared provider block label must all still pass — the meta-arg gate must
// not over-block what OpenTofu legitimately resolves.
func TestProviderMetaArgumentControls(t *testing.T) {
	pass := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "aliased allowlisted provider is fine",
			files: map[string]string{"main.tf": nullDecl + `resource "null_resource" "x" {
  provider = aws.west
}
`},
		},
		{
			name: "builtin terraform provider is exempt",
			files: map[string]string{"main.tf": nullDecl + `resource "null_resource" "x" {
  provider = terraform
}
`},
		},
		{
			// The false-positive twin of the underscore-split defect: the
			// declaration for foo_bar itself must excuse `provider "foo_bar"`.
			name: "provider block label is excused by its own exact declaration",
			files: map[string]string{"main.tf": `terraform {
  required_providers {
    foo_bar = { source = "hashicorp/null" }
  }
}

provider "foo_bar" {}
`},
		},
		{
			name: "json meta-arg naming a declared provider is fine",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"foo_bar": {"source": "hashicorp/null"}}},
  "resource": {"null_resource": {"x": {"provider": "foo_bar"}}}
}`},
		},
		{
			// The template spelling must strip to the same local name — a
			// declared provider written as "${foo_bar}" is not a false positive.
			name: "json template spelling of a declared provider is fine",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"foo_bar": {"source": "hashicorp/null"}}},
  "resource": {"null_resource": {"x": {"provider": "${foo_bar}"}}}
}`},
		},
		{
			// A non-string provider value is not a reference OpenTofu accepts;
			// nothing can execute from it, so nothing is recorded.
			name: "json non-string provider value records nothing",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"null": {"source": "hashicorp/null"}}},
  "resource": {"null_resource": {"x": {"provider": 3}}}
}`},
		},
	}
	for _, tc := range pass {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Scan(writeTree(t, tc.files), nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if !rep.OK {
				t.Fatalf("legitimate provider pin was DENIED — the gate over-blocks (findings: %+v)", rep.Findings)
			}
		})
	}
}
