// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// awsCIDRConfig is a minimal AWS project config that passes every OTHER ValidateConfig rule, so a
// failure can only come from the CIDR.
func awsCIDRConfig(cidr string) *types.ProjectConfig {
	return &types.ProjectConfig{
		Network: types.ProjectNetworkConfig{
			CIDRBlock:        cidr,
			ProvisionNetwork: true,
		},
	}
}

// TestAWSValidateConfig_VPCCIDRFloor is #1942's repro, kept.
//
// The canvas accepted any CIDR and the failure landed at plan time, or later. Two distinct bad
// outcomes, and the second is the dangerous one:
//
//   - /24 or smaller — the plan dies INSIDE cidrsubnet(), which would need a 34-bit prefix. The
//     error names no input, so nothing points at the field the customer typed.
//   - /19 — worse, because it PLANS CLEAN. It yields /29 public subnets that AWS rejects mid-apply,
//     after resources have started being created.
func TestAWSValidateConfig_VPCCIDRFloor(t *testing.T) {
	p := &awsProvider{}

	refused := []struct{ cidr, why string }{
		{"10.0.0.0/24", "dies inside cidrsubnet() with an error naming no input"},
		{"10.0.0.0/19", "PLANS CLEAN, then AWS rejects the /29 public subnets mid-apply"},
		{"10.0.0.0/28", "far past the floor"},
	}
	for _, c := range refused {
		err := p.ValidateConfig(awsCIDRConfig(c.cidr))
		if err == nil {
			t.Errorf("ValidateConfig accepted %s — %s", c.cidr, c.why)
			continue
		}
		// The whole point is that the message names the field the customer typed.
		if !strings.Contains(err.Error(), "network.cidr_block") {
			t.Errorf("ValidateConfig(%s) refused, but the error does not name the field: %v", c.cidr, err)
		}
		if !strings.Contains(err.Error(), "vpc_cidr") {
			t.Errorf("ValidateConfig(%s) refused, but the error does not name the tfvar: %v", c.cidr, err)
		}
	}

	accepted := []string{
		"10.0.0.0/16", // the template default
		"10.0.0.0/18", // exactly the floor — private subnets are still a /22 here
		"10.0.0.0/8",  // the widest the template's carvable predicate allows
	}
	for _, cidr := range accepted {
		if err := p.ValidateConfig(awsCIDRConfig(cidr)); err != nil {
			t.Errorf("ValidateConfig rejected %s, which the template can carve: %v", cidr, err)
		}
	}
}

// TestAWSValidateConfig_CIDRSkippedWhenNotProvisioning mirrors validateNetworkCIDR's own contract:
// on the brownfield path the CIDR is never carved (the attached network's range is the supernet), so
// refusing there would block a deploy over a field the apply does not read.
func TestAWSValidateConfig_CIDRSkippedWhenNotProvisioning(t *testing.T) {
	p := &awsProvider{}

	brownfield := &types.ProjectConfig{
		Network: types.ProjectNetworkConfig{
			CIDRBlock:        "10.0.0.0/24", // unusable if carved — but it will not be
			ProvisionNetwork: false,
			NetworkID:        "vpc-existing",
		},
	}
	if err := p.ValidateConfig(brownfield); err != nil {
		t.Errorf("a too-small CIDR must be ignored when attaching an existing VPC: %v", err)
	}

	// The fallback runs the other way too: provision_network=false with NO network id still
	// provisions from the CIDR, so the rule must apply.
	fallback := &types.ProjectConfig{
		Network: types.ProjectNetworkConfig{
			CIDRBlock:        "10.0.0.0/24",
			ProvisionNetwork: false,
		},
	}
	if err := p.ValidateConfig(fallback); err == nil {
		t.Error("provision_network=false with no network id still provisions from the CIDR — the floor must apply")
	}
}
