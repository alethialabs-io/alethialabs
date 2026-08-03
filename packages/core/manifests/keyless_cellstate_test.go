// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The decision record carries the cell's own state, on BOTH branches (#1790).
//
// It is what lets the deploy tell two very different failures apart: a refusal on an excluded cell
// is a product boundary working, while a refusal on a cell we claim to support is our defect. The
// severity gate in the provisioner reads this field, so a record that did not carry it — or carried
// a guess — would silently push every fail-closed binding into the same bucket again.
func TestKeylessDecision_CarriesTheCellState(t *testing.T) {
	t.Run("excluded cell records excluded", func(t *testing.T) {
		_, _, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
			Provider:      providerHetzner,
			KeylessDBAuth: true,
			Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
		})
		d, ok := findKeylessDecision(decisions, "orders-db")
		if !ok {
			t.Fatalf("no decision recorded — %v", decisions)
		}
		if d.Status != KeylessBindingFailedClosed {
			t.Fatalf("status = %q, want %q", d.Status, KeylessBindingFailedClosed)
		}
		if d.CellState != KeylessCellExcluded {
			t.Errorf("cell state = %q, want %q — the deploy would read this as our defect and fail",
				d.CellState, KeylessCellExcluded)
		}
	})

	t.Run("live cell records live", func(t *testing.T) {
		_, _, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
			Provider:      providerAWS,
			KeylessDBAuth: true,
			Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
			Outputs:       map[string]string{"rds_endpoint": "db.example.com"},
			RunnerImage:   "ghcr.io/alethialabs-io/runner-aws:test",
		})
		d, ok := findKeylessDecision(decisions, "orders-db")
		if !ok {
			t.Fatalf("no decision recorded — %v", decisions)
		}
		if d.CellState != KeylessCellLive {
			t.Errorf("cell state = %q, want %q", d.CellState, KeylessCellLive)
		}
	})

	// The case that motivated all of this: a LIVE cell that cannot render because the runner has no
	// image ref (#1787). It must record live + failed_closed — that pair is what the deploy fails on.
	// Recording it as anything else would put a real defect back under a successful deploy.
	t.Run("live cell that cannot render records live AND failed_closed", func(t *testing.T) {
		_, _, decisions := FromServices([]types.ProjectServiceConfig{keylessService()}, Options{
			Provider:      providerAWS,
			KeylessDBAuth: true,
			Databases:     []types.ProjectDatabaseConfig{{Name: "orders-db", IamAuth: boolPtr(true)}},
			Outputs:       map[string]string{"rds_endpoint": "db.example.com"},
			// RunnerImage deliberately empty — keyless_aws.go fails closed on it.
		})
		d, ok := findKeylessDecision(decisions, "orders-db")
		if !ok {
			t.Fatalf("no decision recorded — %v", decisions)
		}
		if d.Status != KeylessBindingFailedClosed {
			t.Fatalf("status = %q, want %q", d.Status, KeylessBindingFailedClosed)
		}
		if d.CellState != KeylessCellLive {
			t.Errorf("cell state = %q, want %q — a supported cell refusing is exactly what must fail the deploy",
				d.CellState, KeylessCellLive)
		}
	})
}
