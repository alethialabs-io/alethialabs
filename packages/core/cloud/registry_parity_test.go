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
