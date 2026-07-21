// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestSelectPlacementPath(t *testing.T) {
	cases := []struct {
		name     string
		pm       types.PlacementMode
		provider string
		want     placementPath
	}{
		{"empty is dedicated (legacy env=cluster)", "", "aws", placementDedicated},
		{"dedicated aws", types.PlacementModeDedicated, "aws", placementDedicated},
		{"dedicated gcp", types.PlacementModeDedicated, "gcp", placementDedicated},
		{"namespace aws → activated", types.PlacementModeNamespace, "aws", placementNamespaceAWS},
		{"namespace gcp → fail closed", types.PlacementModeNamespace, "gcp", placementUnactivated},
		{"namespace azure → fail closed", types.PlacementModeNamespace, "azure", placementUnactivated},
		{"namespace hetzner → fail closed", types.PlacementModeNamespace, "hetzner", placementUnactivated},
		{"vcluster aws → fail closed", types.PlacementModeVcluster, "aws", placementUnactivated},
		{"unknown mode → fail closed", types.PlacementMode("bogus"), "aws", placementUnactivated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selectPlacementPath(tc.pm, tc.provider); got != tc.want {
				t.Errorf("selectPlacementPath(%q, %q) = %d, want %d", tc.pm, tc.provider, got, tc.want)
			}
		})
	}
}

func TestUnactivatedPlacementError(t *testing.T) {
	// namespace on a non-aws cloud names the cloud and the per-cloud reason (parity is documented, not
	// silent) and points at aws as the working cloud.
	nsErr := unactivatedPlacementError(types.PlacementModeNamespace, "gcp")
	if nsErr == nil {
		t.Fatal("expected error")
	}
	msg := nsErr.Error()
	for _, want := range []string{"namespace", "gcp", "aws"} {
		if !strings.Contains(msg, want) {
			t.Errorf("namespace error %q missing %q", msg, want)
		}
	}

	// vcluster explains the mode isn't activated at all (tracked follow-up), never mentions a specific
	// cloud being the fix.
	vcErr := unactivatedPlacementError(types.PlacementModeVcluster, "aws")
	if vcErr == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(vcErr.Error(), "vcluster") {
		t.Errorf("vcluster error %q missing 'vcluster'", vcErr.Error())
	}
}
