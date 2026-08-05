// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The tfvar each cloud carries the network allow-list on. Named per template, because the
// variable names are NOT uniform — aws scopes it to the VPC, azure to the VNet, the rest to the
// network — and a test that assumed one name would pass vacuously on the four it got wrong.
var allowListTfvar = map[string]string{
	"aws":     "vpc_allowed_cidr_blocks",
	"azure":   "vnet_allowed_cidr_blocks",
	"gcp":     "network_allowed_cidr_blocks",
	"alibaba": "network_allowed_cidr_blocks",
	"hetzner": "network_allowed_cidr_blocks",
}

func allowListConfig(cidrs []string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:      "demo",
		EnvironmentStage: "prod",
		Network: types.ProjectNetworkConfig{
			ProvisionNetwork:  true,
			CIDRBlock:         "10.0.0.0/16",
			AllowedCidrBlocks: cidrs,
		},
	}
}

// Every cloud must CARRY the value. This is the hop #1987 died on: the field was absent from the
// Go contract, so json.Unmarshal dropped it and all five providers emitted nothing.
func TestNetworkAllowListReachesEveryCloud(t *testing.T) {
	want := []string{"10.1.0.0/16", "192.168.5.0/24"}
	for cloud, key := range allowListTfvar {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		tfvars := p.ProviderTfvars(allowListConfig(want))
		got, ok := tfvars[key]
		if !ok {
			t.Errorf("%s: tfvar %q was never emitted", cloud, key)
			continue
		}
		list, ok := got.([]string)
		if !ok {
			t.Errorf("%s: tfvar %q is %T, want []string", cloud, key, got)
			continue
		}
		if len(list) != len(want) {
			t.Errorf("%s: tfvar %q = %v, want %v", cloud, key, list, want)
			continue
		}
		for i := range want {
			if list[i] != want[i] {
				t.Errorf("%s: tfvar %q[%d] = %q, want %q", cloud, key, i, list[i], want[i])
			}
		}
	}
}

// The empty case has to emit an EMPTY LIST rather than nil or a missing key. All three would
// "work", but only the first keeps the plan byte-identical for every project already in the
// field — which is the property that makes this control safe to ship on by default.
func TestNetworkAllowListEmptyIsBehaviourPreserving(t *testing.T) {
	for cloud, key := range allowListTfvar {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		got, ok := p.ProviderTfvars(allowListConfig(nil))[key]
		if !ok {
			t.Errorf("%s: tfvar %q missing when the allow-list is unset", cloud, key)
			continue
		}
		list, ok := got.([]string)
		if !ok {
			t.Errorf("%s: tfvar %q is %T, want []string", cloud, key, got)
			continue
		}
		if len(list) != 0 {
			t.Errorf("%s: tfvar %q = %v, want an empty list", cloud, key, list)
		}
	}
}

// The allow-list must not be confused with the cluster API ENDPOINT allow-lists that already
// exist on aws/gcp/azure. They gate different things — one the network, one the control-plane
// endpoint — and quietly wiring this field onto those would both change the control's meaning and
// risk locking the external runner out of a cluster it still has to provision.
func TestNetworkAllowListDoesNotTouchTheEndpointAllowLists(t *testing.T) {
	endpointVars := []string{
		"cluster_endpoint_public_access_cidrs",
		"gke_master_authorized_cidr_blocks",
		"aks_authorized_ip_ranges",
	}
	for cloud := range allowListTfvar {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		tfvars := p.ProviderTfvars(allowListConfig([]string{"10.1.0.0/16"}))
		for _, ev := range endpointVars {
			if _, ok := tfvars[ev]; ok {
				t.Errorf("%s: the network allow-list also wrote %q — that gates the API endpoint, not the network", cloud, ev)
			}
		}
	}
}
