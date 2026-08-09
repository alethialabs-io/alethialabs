// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"net"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cidrsubnetOK mirrors OpenTofu's cidrsubnet() validity rule: netnum must fit in
// newbits, and prefix+newbits must not exceed /32. A violation is a hard plan error.
func cidrsubnetOK(prefix, newbits, netnum int) bool {
	if newbits < 0 || prefix+newbits > 32 {
		return false
	}
	return netnum < (1 << uint(newbits))
}

// TestAzureVnetCIDRFloorAdmitsOnlyCarvableNetworks asserts that every vnet_cidr
// azureProvider.ValidateConfig accepts can actually be carved into the FOUR /20 subnets
// modules/vnet/main.tf builds: cidrsubnet(vnet_cidr, 20-prefix, 0..3). Before #2050 the
// floor was /20 — derived from newbits >= 0 alone — so /19 and /20 sailed through
// ValidateConfig and died inside `tofu plan` with an opaque "does not accommodate a
// subnet numbered N" error instead of the field-level config error this gate exists
// to produce.
func TestAzureVnetCIDRFloorAdmitsOnlyCarvableNetworks(t *testing.T) {
	p, err := NewCloudProvider("azure")
	if err != nil {
		t.Fatalf("NewCloudProvider: %v", err)
	}
	for _, cidr := range []string{"10.0.0.0/16", "10.0.0.0/18", "10.0.0.0/19", "10.0.0.0/20"} {
		cfg := &types.ProjectConfig{
			ProjectName: "proj",
			Region:      "westeurope",
			Network: types.ProjectNetworkConfig{
				ProvisionNetwork: true,
				CIDRBlock:        cidr,
			},
		}
		if verr := p.ValidateConfig(cfg); verr != nil {
			continue // refused up front — nothing unprovisionable reaches tofu
		}
		_, ipnet, perr := net.ParseCIDR(cidr)
		if perr != nil {
			t.Fatalf("bad fixture %q: %v", cidr, perr)
		}
		prefix, _ := ipnet.Mask.Size()
		newbits := 20 - prefix
		for netnum := range 4 {
			if !cidrsubnetOK(prefix, newbits, netnum) {
				t.Errorf("vnet_cidr %s accepted by ValidateConfig but cidrsubnet(%s, %d, %d) is a hard tofu error",
					cidr, cidr, newbits, netnum)
			}
		}
	}
}
