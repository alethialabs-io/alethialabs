// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestContainerRegistryParity asserts that ProjectConfig.ContainerRegistries drives the
// per-cloud "provision the registry" toggle on ALL four managed clouds — not just Azure.
// The three non-Azure providers used to hardcode this off (a real parity gap), so a project
// with a container registry silently got one only on Azure.
func TestContainerRegistryParity(t *testing.T) {
	cases := []struct {
		provider string
		key      string
	}{
		{"aws", "provision_ecr"},
		{"gcp", "provision_artifact_registry"},
		{"azure", "provision_acr"},
		{"alibaba", "provision_cr"},
	}

	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			p, err := NewCloudProvider(c.provider)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", c.provider, err)
			}
			base := func(regs []types.ProjectContainerRegistryConfig) *types.ProjectConfig {
				return &types.ProjectConfig{
					ProjectName:         "min",
					CloudAccountID:      "acct-1",
					Region:              "us-east-1",
					ContainerRegistries: regs,
					Cluster:             types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
					DNS:                 types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
				}
			}

			// Empty -> false.
			if got := p.ProviderTfvars(base(nil))[c.key]; got != false {
				t.Errorf("%s: %s with no registries = %v, want false", c.provider, c.key, got)
			}
			// One registry -> true.
			regs := []types.ProjectContainerRegistryConfig{{Name: "app"}}
			if got := p.ProviderTfvars(base(regs))[c.key]; got != true {
				t.Errorf("%s: %s with a registry = %v, want true", c.provider, c.key, got)
			}
		})
	}
}

// TestECRNamesMapFromConfig proves the W2 gap is closed on AWS: ecr_names_map is populated
// from config (it used to stay {} while provision_ecr read true, so `local.ecr_input`
// resolved empty and NOTHING was created). One repo per native registry component + one per
// repo-sourced service, keyed by the component's logical name — the same key the
// ecr_repository_urls_map output uses, so BUILD/render resolve a service's destination by
// its service name.
func TestECRNamesMapFromConfig(t *testing.T) {
	p, err := NewCloudProvider("aws")
	if err != nil {
		t.Fatalf("NewCloudProvider(aws): %v", err)
	}
	base := func(regs []types.ProjectContainerRegistryConfig, svcs []types.ProjectServiceConfig) *types.ProjectConfig {
		return &types.ProjectConfig{
			ProjectName:         "min",
			CloudAccountID:      "acct-1",
			Region:              "us-east-1",
			ContainerRegistries: regs,
			Services:            svcs,
			Cluster:             types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
			DNS:                 types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		}
	}
	namesOf := func(cfg *types.ProjectConfig) map[string]string {
		m, ok := p.ProviderTfvars(cfg)["ecr_names_map"].(map[string]string)
		if !ok {
			t.Fatalf("ecr_names_map missing or wrong type: %T", p.ProviderTfvars(cfg)["ecr_names_map"])
		}
		return m
	}

	// Empty config → empty map, provision_ecr false.
	if got := namesOf(base(nil, nil)); len(got) != 0 {
		t.Errorf("empty config: ecr_names_map = %v, want {}", got)
	}

	// A repo-sourced service ALONE provisions its build destination (no registry component needed).
	repoSvc := types.ProjectServiceConfig{
		Name:   "web",
		Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/web"},
	}
	tf := p.ProviderTfvars(base(nil, []types.ProjectServiceConfig{repoSvc}))
	if tf["provision_ecr"] != true {
		t.Errorf("repo-sourced service alone: provision_ecr = %v, want true", tf["provision_ecr"])
	}
	if got := namesOf(base(nil, []types.ProjectServiceConfig{repoSvc})); got["web"] != "web" {
		t.Errorf("repo-sourced service: ecr_names_map = %v, want {web: web}", got)
	}

	// An image-sourced service needs no repository.
	imgSvc := types.ProjectServiceConfig{
		Name:   "worker",
		Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1"},
	}
	if got := namesOf(base(nil, []types.ProjectServiceConfig{imgSvc})); len(got) != 0 {
		t.Errorf("image-sourced service: ecr_names_map = %v, want {}", got)
	}

	// Native registry components get their repo; pluggable non-native ones are not ECR's.
	regs := []types.ProjectContainerRegistryConfig{
		{Name: "app"},
		{Name: "shared", Provider: "native"},
		{Name: "external", Provider: "harbor"},
	}
	got := namesOf(base(regs, nil))
	if got["app"] != "app" || got["shared"] != "shared" {
		t.Errorf("native registries: ecr_names_map = %v, want app+shared", got)
	}
	if _, ok := got["external"]; ok {
		t.Errorf("non-native registry leaked into ecr_names_map: %v", got)
	}

	// Repo base names are normalized deterministically (valid for "<project>-<base>").
	odd := types.ProjectServiceConfig{
		Name:   " My_Web App ",
		Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/x"},
	}
	if got := namesOf(base(nil, []types.ProjectServiceConfig{odd})); got[" My_Web App "] != "my-web-app" {
		t.Errorf("sanitization: ecr_names_map = %v, want {\" My_Web App \": my-web-app}", got)
	}
}

// TestECRRepoBaseName pins the normalizer: deterministic, lowercase, single "-" separators,
// never leading/trailing separators, empty for all-invalid input.
func TestECRRepoBaseName(t *testing.T) {
	cases := map[string]string{
		"web":          "web",
		"Web":          "web",
		"my_api":       "my-api",
		"a  b":         "a-b",
		"-lead-trail-": "lead-trail",
		"héllo!":       "h-llo",
		"!!!":          "",
		"API v2":       "api-v2",
	}
	for in, want := range cases {
		if got := ecrRepoBaseName(in); got != want {
			t.Errorf("ecrRepoBaseName(%q) = %q, want %q", in, got, want)
		}
	}
}
