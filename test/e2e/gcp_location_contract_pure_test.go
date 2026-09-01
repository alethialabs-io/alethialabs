// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGCPNightlyLocationContract pins the zonal cluster location and regional service consumers.
func TestGCPNightlyLocationContract(t *testing.T) {
	root := filepath.Join(e2ePackageDir(t), "..", "..")
	contracts := []struct {
		name string
		path string
		want string
	}{
		{
			name: "the nightly defaults GCP to a zone so GKE is zonal and capacity is checked",
			path: filepath.Join(root, ".github", "workflows", "e2e-nightly.yml"),
			want: `gcp)     DEFAULT_REGION="europe-west3-a" ;;`,
		},
		{
			name: "Firestore derives its regional default from the zonal cluster location",
			path: filepath.Join(root, "infra", "templates", "project", "gcp", "firestore.tf"),
			want: `location_id   = var.firestore_location_id != "" ? var.firestore_location_id : local.gcp_region_key`,
		},
		{
			name: "brownfield subnet discovery matches the derived region rather than the zone",
			path: filepath.Join(root, "infra", "templates", "project", "gcp", "existing-network.tf"),
			want: `if length(regexall("/regions/${local.gcp_region_key}/", s)) > 0`,
		},
		{
			name: "cleanup self-tests the zone-to-region normalization used by regional APIs",
			path: filepath.Join(root, "scripts", "e2e", "gcp-cleanup.sh"),
			want: `ALETHIA_E2E_REGION="europe-west3-a"`,
		},
	}

	for _, contract := range contracts {
		t.Run(contract.name, func(t *testing.T) {
			raw, err := os.ReadFile(contract.path)
			if err != nil {
				t.Fatalf("read %s: %v", contract.path, err)
			}
			if !strings.Contains(string(raw), contract.want) {
				t.Fatalf("%s no longer contains the location contract:\n%s", contract.path, contract.want)
			}
		})
	}
}
