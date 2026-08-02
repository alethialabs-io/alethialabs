// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

func decision(service string, status manifests.KeylessBindingStatus, state manifests.KeylessCellState) manifests.KeylessBindingDecision {
	return manifests.KeylessBindingDecision{
		Service:    service,
		TargetKind: "database",
		TargetName: "maindb",
		Engine:     "postgres",
		Status:     status,
		Reason:     "reason for " + service,
		CellState:  state,
	}
}

// The severity split is the whole point of #1790: a refusal on a cell we CLAIM to support is our
// defect and must fail the deploy; a refusal on a cell we have excluded is a product boundary and
// must not. A test that only checked "failed_closed fails" would pass on a gate that failed every
// deploy for alibaba + iam_auth, which is the behaviour this deliberately does not ship.
func TestLiveCellKeylessFailures(t *testing.T) {
	cases := []struct {
		name      string
		decisions []manifests.KeylessBindingDecision
		wantCount int
		wantIn    string
	}{
		{
			name:      "no decisions — nothing to fail on",
			decisions: nil,
		},
		{
			name:      "wired on a live cell — the happy path stays happy",
			decisions: []manifests.KeylessBindingDecision{decision("api", manifests.KeylessBindingWired, manifests.KeylessCellLive)},
		},
		{
			name:      "failed closed on a LIVE cell — our defect, fails the deploy",
			decisions: []manifests.KeylessBindingDecision{decision("api", manifests.KeylessBindingFailedClosed, manifests.KeylessCellLive)},
			wantCount: 1,
			wantIn:    "api→database/maindb (postgres): reason for api",
		},
		{
			name:      "failed closed on an EXCLUDED cell — a product boundary, stays a warning",
			decisions: []manifests.KeylessBindingDecision{decision("api", manifests.KeylessBindingFailedClosed, manifests.KeylessCellExcluded)},
		},
		{
			name:      "failed closed on a PENDING cell — not implemented yet, stays a warning",
			decisions: []manifests.KeylessBindingDecision{decision("api", manifests.KeylessBindingFailedClosed, manifests.KeylessCellPending)},
		},
		{
			// The table's own "unknown": provider × engine is absent, so no cell exists. It must be
			// at least as loud as a known-supported cell — reading it as "not live, therefore only a
			// warning" is the fail-OPEN direction the gate exists to prevent.
			name:      "failed closed with an UNKNOWN cell — fails, because unknown must not be quieter",
			decisions: []manifests.KeylessBindingDecision{decision("api", manifests.KeylessBindingFailedClosed, "")},
			wantCount: 1,
		},
		{
			name: "a mixed deploy reports only the live-cell failures",
			decisions: []manifests.KeylessBindingDecision{
				decision("api", manifests.KeylessBindingWired, manifests.KeylessCellLive),
				decision("worker", manifests.KeylessBindingFailedClosed, manifests.KeylessCellLive),
				decision("legacy", manifests.KeylessBindingFailedClosed, manifests.KeylessCellExcluded),
				decision("beta", manifests.KeylessBindingFailedClosed, manifests.KeylessCellLive),
			},
			wantCount: 2,
			wantIn:    "worker→database/maindb",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := liveCellKeylessFailures(tc.decisions)
			if len(got) != tc.wantCount {
				t.Fatalf("liveCellKeylessFailures() = %d failure(s) %v, want %d", len(got), got, tc.wantCount)
			}
			if tc.wantIn != "" && !strings.Contains(strings.Join(got, "; "), tc.wantIn) {
				t.Fatalf("failure text %q does not name the binding (%q)", strings.Join(got, "; "), tc.wantIn)
			}
		})
	}
}

// The excluded cells are real product boundaries, not hypotheticals — a deploy on one of them must
// not start failing. Read from the table itself so this cannot drift from the shipped exclusions.
func TestExcludedCellsDoNotFailTheDeploy(t *testing.T) {
	for _, cell := range []struct{ provider, engine string }{
		{"alibaba", "postgres"},
		{"alibaba", "mysql"},
		{"hetzner", "postgres"},
	} {
		state, _, err := manifests.KeylessCell(cell.provider, cell.engine)
		if err != nil {
			t.Fatalf("KeylessCell(%s, %s): %v", cell.provider, cell.engine, err)
		}
		if state != manifests.KeylessCellExcluded {
			t.Fatalf("%s/%s is %q — this test's premise is stale, not the code",
				cell.provider, cell.engine, state)
		}
		if got := liveCellKeylessFailures([]manifests.KeylessBindingDecision{
			decision("api", manifests.KeylessBindingFailedClosed, state),
		}); len(got) != 0 {
			t.Fatalf("%s/%s failed the deploy, but it is an excluded cell: %v", cell.provider, cell.engine, got)
		}
	}
}
