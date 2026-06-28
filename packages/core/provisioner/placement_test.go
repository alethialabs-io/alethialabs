// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestValidatePlacement(t *testing.T) {
	const core = "id-core"
	const other = "id-other"

	coreDB := func(id string) types.ProjectDatabaseConfig {
		return types.ProjectDatabaseConfig{
			Placement: types.Placement{CloudIdentityID: id},
			Name:      "primary",
		}
	}

	tests := []struct {
		name    string
		vc      *types.ProjectConfig
		wantErr bool
	}{
		{
			name:    "all inherit (empty placements) — ok",
			vc:      &types.ProjectConfig{CloudIdentityID: core, Databases: []types.ProjectDatabaseConfig{{Name: "primary"}}},
			wantErr: false,
		},
		{
			name:    "core resource explicitly on primary — ok",
			vc:      &types.ProjectConfig{CloudIdentityID: core, Databases: []types.ProjectDatabaseConfig{coreDB(core)}},
			wantErr: false,
		},
		{
			name:    "core database on foreign cloud — gated",
			vc:      &types.ProjectConfig{CloudIdentityID: core, Databases: []types.ProjectDatabaseConfig{coreDB(other)}},
			wantErr: true,
		},
		{
			name: "core cluster on foreign cloud — gated",
			vc: &types.ProjectConfig{
				CloudIdentityID: core,
				Cluster:         types.ProjectClusterConfig{Placement: types.Placement{CloudIdentityID: other}},
			},
			wantErr: true,
		},
		{
			name: "periphery (dns/secrets/storage) on foreign cloud — ok",
			vc: &types.ProjectConfig{
				CloudIdentityID: core,
				DNS:             types.ProjectDNSConfig{Placement: types.Placement{CloudIdentityID: other}},
				Secrets:         []types.ProjectSecretConfig{{Placement: types.Placement{CloudIdentityID: other}, Name: "s"}},
				StorageBuckets:  []types.ProjectStorageBucketConfig{{Placement: types.Placement{CloudIdentityID: other}, Name: "b"}},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePlacement(tt.vc)
			if tt.wantErr && err == nil {
				t.Fatal("expected gate error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
