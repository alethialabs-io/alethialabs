// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// capacityConfig is a minimal valid config carrying one capacity type.
func capacityConfig(capacity string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "cap",
		Region:      "r",
		Cluster:     types.ProjectClusterConfig{CapacityType: capacity, ProviderConfig: map[string]any{}},
		DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Network:     types.ProjectNetworkConfig{ProvisionNetwork: true, CIDRBlock: "10.0.0.0/16"},
	}
}

// TestAWSCapacityTypeReachesTheNodeGroup pins #5266's aws half: the typed field decides
// `eks_ng_capacity_type`, unset leaves the template default (ON_DEMAND), and a provider_config
// passthrough of the same variable cannot override the field — the key is reserved.
func TestAWSCapacityTypeReachesTheNodeGroup(t *testing.T) {
	p := &awsProvider{}
	for capacity, want := range map[string]any{
		types.CapacityTypeSpot:     "SPOT",
		types.CapacityTypeOnDemand: "ON_DEMAND",
	} {
		cfg := capacityConfig(capacity)
		// A conflicting passthrough must lose to the typed field.
		cfg.Cluster.ProviderConfig["eks_ng_capacity_type"] = "BOGUS"
		if got := p.ProviderTfvars(cfg)["eks_ng_capacity_type"]; got != want {
			t.Errorf("capacity_type %q → eks_ng_capacity_type = %v, want %v", capacity, got, want)
		}
	}
	cfg := capacityConfig("")
	cfg.Cluster.ProviderConfig["eks_ng_capacity_type"] = "SPOT"
	if got, present := p.ProviderTfvars(cfg)["eks_ng_capacity_type"]; present {
		t.Errorf("unset capacity_type must leave the template default, got %v (a reserved passthrough leaked)", got)
	}
}

// TestCapacityTypeIsValidatedPerCloud: spot is refused where nothing reads it, and an unknown value
// is refused everywhere — a stored choice the deploy ignores is the defect class #5267 was about.
func TestCapacityTypeIsValidatedPerCloud(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		p, err := NewCloudProvider(provider)
		if err != nil {
			t.Fatal(err)
		}
		for _, ok := range []string{"", types.CapacityTypeOnDemand} {
			if err := p.ValidateConfig(capacityConfig(ok)); err != nil && strings.Contains(err.Error(), "capacity_type") {
				t.Errorf("%s refused capacity_type %q: %v", provider, ok, err)
			}
		}
		err = p.ValidateConfig(capacityConfig(types.CapacityTypeSpot))
		refusedSpot := err != nil && strings.Contains(err.Error(), "capacity_type")
		if provider == "aws" && refusedSpot {
			t.Errorf("aws refused spot: %v", err)
		}
		if provider != "aws" && !refusedSpot {
			t.Errorf("%s accepted spot, which nothing on that cloud reads (err=%v)", provider, err)
		}
		if err := p.ValidateConfig(capacityConfig("preemptible")); err == nil || !strings.Contains(err.Error(), "capacity_type") {
			t.Errorf("%s accepted an unknown capacity_type: %v", provider, err)
		}
	}
}
