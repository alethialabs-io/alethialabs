// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Where CloudProvider.ValidateConfig is CALLED is as load-bearing as what it checks (#1967).
//
// Every rule in packages/core/cloud/validate.go is derived from a project template's own literals
// and may only ever refuse what that template would refuse. Only the `dedicated` placement path
// renders those templates: `namespace` deploys onto an existing shared Fabric cluster by keyless
// re-mint with no tofu at all, and `vcluster` provisions a virtual cluster on one. Neither reads
// node_min/max/desired_size, node_disk_size_gb or network.cidr_block — but the canvas builds a
// cluster node for EVERY project regardless of placement, so those fields exist and can hold
// anything on a namespace env.
//
// So a gate placed above the placement dispatch (beside ValidatePlacement, which is where it
// naturally wants to go) refuses projects that deploy fine today, against floors from a template
// that is never rendered. These tests pin the call BELOW the dispatch, from both sides.

// badSizingConfig is a config the dedicated path refuses: desired sits above max. Deliberately the
// cheapest rule to trip, so the assertions are about placement, not about sizing.
func badSizingConfig(mode types.PlacementMode) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:      "acme",
		CloudAccountID:   "acct-1",
		CloudIdentityID:  "ci-1",
		Region:           "us-east-1",
		EnvironmentStage: "prod",
		PlacementMode:    mode,
		Namespace:        "team-web",
		Cluster: types.ProjectClusterConfig{
			NodeMinSize:     2,
			NodeMaxSize:     5,
			NodeDesiredSize: 99, // above max — the dedicated path refuses this
			ProviderConfig:  map[string]any{},
		},
		Network: types.ProjectNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.0.0.0/28", // far below every carving floor
		},
		DNS: types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
	}
}

// configRefusalMarker is the prefix cloud.configError stamps on every ValidateConfig refusal.
const configRefusalMarker = "invalid project configuration:"

// TestValidateConfigIsNotAppliedToNonDedicatedPlacements is the regression guard: a namespace- or
// vcluster-placement project carrying values the dedicated path would refuse must NOT be refused
// by this gate. Both paths still fail (they need a serving cluster resolved onto the snapshot, and
// this config has none) — that is the point. The assertion is on WHICH error comes back: anything
// but the config refusal means the gate stayed below the dispatch.
func TestValidateConfigIsNotAppliedToNonDedicatedPlacements(t *testing.T) {
	tests := []struct {
		name     string
		mode     types.PlacementMode
		provider string
		wantErr  string
	}{
		{
			name:     "namespace placement never renders a template",
			mode:     types.PlacementModeNamespace,
			provider: "aws",
			// runNamespaceDeploy's own fail-closed check, reached only because the config gate
			// did not fire first.
			wantErr: "namespace placement: no serving cluster",
		},
		{
			name:     "unactivated placement reports the placement, not the sizing",
			mode:     types.PlacementModeNamespace,
			provider: "digitalocean", // no re-mint wired -> placementUnactivated
			wantErr:  "is not yet activated for deploy",
		},
		{
			name:     "an unrecognized placement mode fails closed on the mode",
			mode:     types.PlacementMode("fabric-of-the-future"),
			provider: "aws",
			wantErr:  "is not yet activated for deploy",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := RunDeployV2(context.Background(), DeployParams{
				ProjectConfig: badSizingConfig(tt.mode),
				Provider:      tt.provider,
				DryRun:        true,
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("expected the %s path to fail on its own terms, got nil", tt.mode)
			}
			if strings.Contains(err.Error(), configRefusalMarker) {
				t.Errorf("placement %q on %s was refused by ValidateConfig: %v\n"+
					"The config gate must sit BELOW the placement dispatch — this path renders no "+
					"template, so every template-derived floor is wider than what it accepts, and "+
					"a project that deploys today would start failing.", tt.mode, tt.provider, err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error %q does not contain %q — the path failed for an unexpected reason, "+
					"so this test is no longer proving what it claims", err, tt.wantErr)
			}
		})
	}
}

// TestValidateConfigIsAppliedToTheDedicatedPath is the other side: without it the test above
// passes vacuously on a gate that was deleted rather than moved.
func TestValidateConfigIsAppliedToTheDedicatedPath(t *testing.T) {
	for _, mode := range []types.PlacementMode{"", types.PlacementModeDedicated} {
		t.Run("mode="+string(mode), func(t *testing.T) {
			_, err := RunDeployV2(context.Background(), DeployParams{
				ProjectConfig: badSizingConfig(mode),
				Provider:      "aws",
				DryRun:        true,
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatal("the dedicated path accepted node_desired_size above node_max_size")
			}
			if !strings.Contains(err.Error(), configRefusalMarker) {
				t.Errorf("the dedicated path failed for another reason before the config gate: %v\n"+
					"ValidateConfig must fire at plan time, before any cloud work.", err)
			}
		})
	}
}

// TestValidateConfigIsSkippedForBYOIac pins the third exclusion: a customer's own module owns its
// resource graph, so our template-derived floors say nothing about it — the same reason
// ValidatePlacement is skipped there.
//
// The repo URL is a LOCAL path that does not exist, so the clone fails instantly and offline. That
// the run gets as far as the clone at all is the proof: the gate is synchronous and would have
// returned the refusal before any of it.
func TestValidateConfigIsSkippedForBYOIac(t *testing.T) {
	config := badSizingConfig(types.PlacementModeDedicated)
	config.IacSource = &types.ProjectIacSourceConfig{
		RepoURL:   filepath.Join(t.TempDir(), "no-such-customer-repo.git"),
		Ref:       "main",
		CommitSHA: "0000000000000000000000000000000000000000",
	}

	_, err := RunDeployV2(context.Background(), DeployParams{
		ProjectConfig: config,
		Provider:      "aws",
		DryRun:        true,
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err != nil && strings.Contains(err.Error(), configRefusalMarker) {
		t.Errorf("a BYO-IaC deploy was refused by ValidateConfig: %v\n"+
			"The floors come from OUR templates; a customer module renders none of them.", err)
	}
}
