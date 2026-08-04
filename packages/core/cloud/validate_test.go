// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strconv"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ValidateConfig is a FAIL-CLOSED gate on the live provisioning path: a rule that is even
// slightly wider than the template it mirrors starts refusing projects that deploy fine today.
// So every rule here is pinned from BOTH sides — a realistic known-good config that must be
// ACCEPTED, and the specific value that must be refused. The acceptance cases are the ones that
// matter; a gate that only ever rejects has not been tested.

// realisticConfig is a project as the canvas actually produces one: an explicit node pool inside
// its own bounds, a /16 network it provisions itself, and a disk above every cloud's floor. Every
// cloud must accept it unchanged.
func realisticConfig() *types.ProjectConfig {
	disk := 50
	return &types.ProjectConfig{
		ProjectName:      "acme",
		CloudAccountID:   "acct-1",
		CloudIdentityID:  "ci-1",
		Region:           "us-east-1",
		EnvironmentStage: "prod",
		Network: types.ProjectNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.0.0.0/16",
			SingleNatGateway: true,
		},
		Cluster: types.ProjectClusterConfig{
			ClusterVersion:  "1.35",
			NodeMinSize:     2,
			NodeMaxSize:     5,
			NodeDesiredSize: 2,
			NodeDiskSizeGB:  &disk,
			ProviderConfig:  map[string]any{},
		},
		DNS: types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
}

// minimalConfig is the OTHER shape that must be accepted: every sizing field left at its zero
// value and no CIDR. Zero means UNSET (the emitters guard on `> 0`), so this is the majority of
// real projects — a rule that reads 0 as a real value would refuse all of them.
func minimalConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:    "min",
		CloudAccountID: "acct-1",
		Region:         "us-east-1",
		Cluster:        types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:            types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
}

// TestValidateConfigAcceptsKnownGoodProjects pins the acceptance side on every cloud: neither
// the fully-specified canvas project nor the all-defaults one may be refused.
func TestValidateConfigAcceptsKnownGoodProjects(t *testing.T) {
	configs := map[string]func() *types.ProjectConfig{
		"realistic": realisticConfig,
		"minimal":   minimalConfig,
	}

	for _, cloudName := range driftClouds {
		for shape, build := range configs {
			t.Run(cloudName+"/"+shape, func(t *testing.T) {
				p, err := NewCloudProvider(cloudName)
				if err != nil {
					t.Fatalf("NewCloudProvider(%q): %v", cloudName, err)
				}
				if err := p.ValidateConfig(build()); err != nil {
					t.Errorf("%s refused a known-good %s config: %v", cloudName, shape, err)
				}
			})
		}
	}
}

// TestValidateNodeSizing pins the cloud-independent node-pool rules, in both directions.
func TestValidateNodeSizing(t *testing.T) {
	tests := []struct {
		name                      string
		minSize, maxSize, desired int
		wantErr                   bool
	}{
		// Accepted — the shapes real projects have.
		{name: "all unset (0 = inherit the template default)"},
		{name: "in range", minSize: 2, maxSize: 5, desired: 3, wantErr: false},
		{name: "desired at the min", minSize: 2, maxSize: 5, desired: 2},
		{name: "desired at the max", minSize: 2, maxSize: 5, desired: 5},
		{name: "min == max", minSize: 3, maxSize: 3, desired: 3},
		{name: "desired unset with a range set", minSize: 2, maxSize: 5},
		{name: "desired set, min/max unset", desired: 7},
		{name: "desired below an unset min", maxSize: 9, desired: 1},
		{name: "large but coherent pool", minSize: 10, maxSize: 200, desired: 40},

		// Refused.
		{name: "max below min", minSize: 5, maxSize: 2, desired: 0, wantErr: true},
		{name: "desired below min", minSize: 4, maxSize: 8, desired: 2, wantErr: true},
		{name: "desired above max", minSize: 1, maxSize: 3, desired: 9, wantErr: true},
		{name: "negative min", minSize: -1, wantErr: true},
		{name: "negative max", maxSize: -2, wantErr: true},
		{name: "negative desired", desired: -3, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := minimalConfig()
			config.Cluster.NodeMinSize = tt.minSize
			config.Cluster.NodeMaxSize = tt.maxSize
			config.Cluster.NodeDesiredSize = tt.desired

			err := validateNodeSizing(config)
			if tt.wantErr && err == nil {
				t.Errorf("min=%d max=%d desired=%d was accepted, want refused",
					tt.minSize, tt.maxSize, tt.desired)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("min=%d max=%d desired=%d was refused: %v",
					tt.minSize, tt.maxSize, tt.desired, err)
			}
		})
	}
}

// TestValidateNodeDiskSize pins each cloud's disk floor through its own provider, so a floor
// wired to the wrong cloud is caught. The values are the template's own, not repeated numbers:
// 24 GB is the case from the issue — it saves on the canvas and dies at plan on Azure.
func TestValidateNodeDiskSize(t *testing.T) {
	tests := []struct {
		cloud   string
		diskGB  *int
		wantErr bool
	}{
		{cloud: "aws", diskGB: nil},        // unset -> the template default (50)
		{cloud: "aws", diskGB: intPtr(20)}, // exactly the floor
		{cloud: "aws", diskGB: intPtr(19), wantErr: true},
		{cloud: "gcp", diskGB: intPtr(20)},
		{cloud: "gcp", diskGB: intPtr(19), wantErr: true},
		{cloud: "alibaba", diskGB: intPtr(20)},
		{cloud: "alibaba", diskGB: intPtr(19), wantErr: true},
		// Azure's floor is 30, so the 24 GB the canvas happily accepts must be refused here —
		// and 20 GB, which passes on every other cloud, must be refused too.
		{cloud: "azure", diskGB: intPtr(30)},
		{cloud: "azure", diskGB: intPtr(24), wantErr: true},
		{cloud: "azure", diskGB: intPtr(20), wantErr: true},
		// Hetzner declares no disk variable, so nothing is refused there.
		{cloud: "hetzner", diskGB: intPtr(10)},
		{cloud: "hetzner", diskGB: nil},
	}

	for _, tt := range tests {
		name := tt.cloud + "/unset"
		if tt.diskGB != nil {
			name = tt.cloud + "/" + strconv.Itoa(*tt.diskGB) + "GB"
		}
		t.Run(name, func(t *testing.T) {
			p, err := NewCloudProvider(tt.cloud)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", tt.cloud, err)
			}
			config := realisticConfig()
			config.Cluster.NodeDiskSizeGB = tt.diskGB

			err = p.ValidateConfig(config)
			if tt.wantErr && err == nil {
				t.Errorf("%s accepted a %d GB node disk, want refused", tt.cloud, *tt.diskGB)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("%s refused a valid node disk: %v", tt.cloud, err)
			}
		})
	}
}

// TestValidateNetworkCIDR pins the per-cloud CIDR floors, the two clouds that have none, and —
// most importantly — the two ways the rule must SKIP: an unset CIDR, and a brownfield network
// whose CIDR the apply never reads.
func TestValidateNetworkCIDR(t *testing.T) {
	tests := []struct {
		name             string
		cloud            string
		cidr             string
		provisionNetwork bool
		networkID        string
		wantErr          bool
	}{
		// The default every provider substitutes.
		{name: "azure /16", cloud: "azure", cidr: "10.0.0.0/16", provisionNetwork: true},
		{name: "azure at the floor", cloud: "azure", cidr: "10.0.0.0/20", provisionNetwork: true},
		{name: "azure below the floor", cloud: "azure", cidr: "10.0.0.0/21", provisionNetwork: true, wantErr: true},
		{name: "azure /24 (the canvas accepts it today)", cloud: "azure", cidr: "10.0.0.0/24", provisionNetwork: true, wantErr: true},

		{name: "hetzner at the floor", cloud: "hetzner", cidr: "10.0.0.0/24", provisionNetwork: true},
		{name: "hetzner below the floor", cloud: "hetzner", cidr: "10.0.0.0/25", provisionNetwork: true, wantErr: true},
		// The value azure refuses is fine on hetzner — the floors are per-cloud, not shared.
		{name: "hetzner /21", cloud: "hetzner", cidr: "10.0.0.0/21", provisionNetwork: true},

		{name: "alibaba at the floor", cloud: "alibaba", cidr: "10.0.0.0/28", provisionNetwork: true},
		{name: "alibaba below the floor", cloud: "alibaba", cidr: "10.0.0.0/29", provisionNetwork: true, wantErr: true},
		{name: "alibaba /24", cloud: "alibaba", cidr: "10.0.0.0/24", provisionNetwork: true},

		// GCP is structurally exempt: it uses the CIDR verbatim, so even a /29 is its own
		// business, not this gate's.
		{name: "gcp /29 is not this gate's business", cloud: "gcp", cidr: "10.0.0.0/29", provisionNetwork: true},
		// AWS's floor is deferred to #1942 — a /24 must NOT be refused here yet.
		{name: "aws /24 is deferred to #1942", cloud: "aws", cidr: "10.0.0.0/24", provisionNetwork: true},

		// The skips. A brownfield network's CIDR is not ours to carve, and an unset CIDR means
		// the provider substitutes 10.0.0.0/16.
		{name: "azure brownfield ignores a narrow cidr", cloud: "azure", cidr: "10.0.0.0/28", networkID: "vnet-1"},
		{name: "hetzner brownfield ignores a narrow cidr", cloud: "hetzner", cidr: "10.0.0.0/30", networkID: "net-1"},
		{name: "azure unset cidr", cloud: "azure", cidr: "", provisionNetwork: true},
		// …but "no switch AND no network id" still provisions from the CIDR, so it is NOT a skip.
		{name: "azure no switch and no network id still carves", cloud: "azure", cidr: "10.0.0.0/28", wantErr: true},

		// Garbage. The four carving templates reject it at plan (or manufacture a wrong value,
		// on hetzner); naming the field beats either.
		{name: "azure unparseable", cloud: "azure", cidr: "not-a-cidr", provisionNetwork: true, wantErr: true},
		{name: "hetzner ipv6", cloud: "hetzner", cidr: "2001:db8::/32", provisionNetwork: true, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := NewCloudProvider(tt.cloud)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", tt.cloud, err)
			}
			config := realisticConfig()
			config.Network.CIDRBlock = tt.cidr
			config.Network.ProvisionNetwork = tt.provisionNetwork
			config.Network.NetworkID = tt.networkID

			err = p.ValidateConfig(config)
			if tt.wantErr && err == nil {
				t.Errorf("%s accepted cidr %q (provision=%v, network_id=%q), want refused",
					tt.cloud, tt.cidr, tt.provisionNetwork, tt.networkID)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("%s refused cidr %q (provision=%v, network_id=%q): %v",
					tt.cloud, tt.cidr, tt.provisionNetwork, tt.networkID, err)
			}
		})
	}
}

// TestProvisionsOwnNetworkMirrorsEmitters pins the greenfield/brownfield resolution against the
// one every ProviderTfvars makes. A gate that reports on an emitter has to mirror EVERY
// condition it has, not just the obvious switch.
func TestProvisionsOwnNetworkMirrorsEmitters(t *testing.T) {
	tests := []struct {
		provision bool
		networkID string
		want      bool
	}{
		{provision: true, networkID: "", want: true},
		{provision: true, networkID: "vpc-1", want: true},
		// The fallback: no switch AND no network named still provisions its own.
		{provision: false, networkID: "", want: true},
		{provision: false, networkID: "vpc-1", want: false},
	}

	for _, tt := range tests {
		got := provisionsOwnNetwork(types.ProjectNetworkConfig{
			ProvisionNetwork: tt.provision,
			NetworkID:        tt.networkID,
		})
		if got != tt.want {
			t.Errorf("provisionsOwnNetwork(provision=%v, id=%q) = %v, want %v — it no longer "+
				"mirrors the resolution in aws_provider.go:83-86 and siblings",
				tt.provision, tt.networkID, got, tt.want)
		}
	}
}

// TestValidateConfigRejectsNilConfig keeps the seam fail-closed on a nil config, mirroring
// ValidatePlacement.
func TestValidateConfigRejectsNilConfig(t *testing.T) {
	for _, cloudName := range driftClouds {
		p, err := NewCloudProvider(cloudName)
		if err != nil {
			t.Fatalf("NewCloudProvider(%q): %v", cloudName, err)
		}
		if err := p.ValidateConfig(nil); err == nil {
			t.Errorf("%s accepted a nil ProjectConfig", cloudName)
		}
	}
}
