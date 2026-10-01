// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// clusterPinning builds the smallest config every provider's ValidateConfig accepts, pinning
// `skus` as the cluster's instance types.
func clusterPinning(skus ...string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "pinned",
		Cluster:     types.ProjectClusterConfig{InstanceTypes: skus, ProviderConfig: map[string]any{}},
		DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
}

// TestValidateConfigRefusesAnotherCloudsMachineType is #5269's backstop, through every provider's
// real ValidateConfig rather than the helper alone — so a cloud that forgets to call it fails
// here. Each case pins a SKU the catalog lists for a DIFFERENT cloud.
func TestValidateConfigRefusesAnotherCloudsMachineType(t *testing.T) {
	cases := []struct {
		provider string
		p        CloudProvider
		foreign  string
		owner    string
	}{
		{"gcp", &gcpProvider{}, "t3.large", "aws"},
		{"aws", &awsProvider{}, "e2-standard-2", "gcp"},
		{"azure", &azureProvider{}, "ecs.g6.large", "alibaba"},
		{"hetzner", &hetznerProvider{}, "Standard_D2s_v5", "azure"},
		{"alibaba", &alibabaProvider{}, "cpx22", "hetzner"},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			err := tc.p.ValidateConfig(clusterPinning(tc.foreign))
			if err == nil {
				t.Fatalf("%s accepted %q, a %s machine type", tc.provider, tc.foreign, tc.owner)
			}
			// The message is the user's whole explanation: it names the field, the SKU, whose it
			// is, where it is going, and both ways out.
			for _, want := range []string{"cluster.instance_types", tc.foreign, tc.owner, tc.provider, "node_size"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error does not mention %q: %v", want, err)
				}
			}
		})
	}
}

// TestValidateConfigAdmitsOwnAndUncataloguedMachineTypes is the other direction, and the one
// that protects real projects: a SKU of the target cloud passes, and so does a SKU the catalog
// has never heard of. These off-catalog values are the ones the repo pins TODAY (the nightly
// e2e's Azure node, the seed catalog's AWS and Hetzner nodes) — a strict membership rule would
// refuse every one of them.
func TestValidateConfigAdmitsOwnAndUncataloguedMachineTypes(t *testing.T) {
	cases := []struct {
		name string
		p    CloudProvider
		skus []string
	}{
		{"gcp catalog SKU", &gcpProvider{}, []string{"e2-standard-2"}},
		{"aws two catalog SKUs", &awsProvider{}, []string{"t3.large", "m5a.large"}},
		{"azure off-catalog (e2e nightly)", &azureProvider{}, []string{"Standard_D2s_v3"}},
		{"aws off-catalog (seed)", &awsProvider{}, []string{"m6i.large", "m6i.xlarge"}},
		{"hetzner off-catalog (seed)", &hetznerProvider{}, []string{"cpx31"}},
		{"no pin at all", &alibabaProvider{}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.p.ValidateConfig(clusterPinning(tc.skus...)); err != nil {
				t.Errorf("refused %v: %v", tc.skus, err)
			}
		})
	}
}
