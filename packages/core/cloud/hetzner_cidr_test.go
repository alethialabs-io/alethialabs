// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"net"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cidrsOverlap reports whether two IPv4 CIDRs share any address.
func cidrsOverlap(a, b string) bool {
	_, na, err := net.ParseCIDR(a)
	if err != nil {
		return false
	}
	_, nb, err := net.ParseCIDR(b)
	if err != nil {
		return false
	}
	return na.Contains(nb.IP) || nb.Contains(na.IP)
}

// TestHetznerDerivedCIDRsNeverOverlapNodeSubnet asserts what hetzner_provider.go claims:
// pod_cidr / service_cidr are disjoint from the node subnet (the first /24 of network_cidr,
// per infra/templates/project/hetzner/network.tf) for EVERY network_cidr override that
// ValidateConfig accepts — so nothing that passes the gate can die on checks_network.tf's
// fail-closed disjointness precondition mid-provision.
//
// #2049: with hetznerMaxNetworkPrefix at 24 this failed — ValidateConfig accepted /23
// (service carve at offset 192, inside the node /24) and /24 (pod at 128, service at 96).
func TestHetznerDerivedCIDRsNeverOverlapNodeSubnet(t *testing.T) {
	p, err := NewCloudProvider("hetzner")
	if err != nil {
		t.Fatalf("NewCloudProvider: %v", err)
	}
	for _, cidr := range []string{"10.0.0.0/16", "10.0.0.0/20", "10.0.0.0/22", "10.0.0.0/23", "10.0.0.0/24"} {
		cfg := &types.ProjectConfig{
			ProjectName: "proj",
			Region:      "fsn1",
			Network: types.ProjectNetworkConfig{
				ProvisionNetwork: true,
				CIDRBlock:        cidr,
			},
		}
		if verr := p.ValidateConfig(cfg); verr != nil {
			// Refused up front — nothing unprovisionable reaches tofu. Fine.
			continue
		}
		tf := p.ProviderTfvars(cfg)
		pod, _ := tf["pod_cidr"].(string)
		svc, _ := tf["service_cidr"].(string)
		// The template carves the node subnet as the FIRST /24 of network_cidr.
		_, base, _ := net.ParseCIDR(cidr)
		node := base.IP.String() + "/24"

		if cidrsOverlap(pod, node) {
			t.Errorf("network_cidr %s accepted by ValidateConfig but pod_cidr %s overlaps node subnet %s", cidr, pod, node)
		}
		if cidrsOverlap(svc, node) {
			t.Errorf("network_cidr %s accepted by ValidateConfig but service_cidr %s overlaps node subnet %s", cidr, svc, node)
		}
	}
}
