// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// TestVerifyGateRequiresReport pins the fail-closed backstop for the real-apply
// path: a real apply may only proceed when there is a conclusive verification
// verdict (a Report), OR an authorized override waives the ControlPlanUnavailable
// sentinel. A real apply with no report and no covering override MUST be refused —
// that is the P1 bug (the gate previously failed OPEN, skipping enforcement when
// the plan JSON could not be produced). Dry-run/plan jobs are unaffected (they
// apply nothing). Pure helper => no tofu/docker required.
func TestVerifyGateRequiresReport(t *testing.T) {
	passReport := &verify.Report{Verdict: verify.StatusPass, CatalogVersion: verify.CatalogVersion}
	showErr := errors.New("tofu show -json: exit status 1")

	covering := &verify.Override{
		Controls: []string{verify.ControlPlanUnavailable},
		Reason:   "known tofu show flake on this plan; reviewed manually",
		By:       "alice",
		Expiry:   time.Now().Add(time.Hour),
	}
	expired := &verify.Override{
		Controls: []string{verify.ControlPlanUnavailable},
		By:       "alice",
		Expiry:   time.Now().Add(-time.Minute),
	}
	unbounded := &verify.Override{
		Controls: []string{verify.ControlPlanUnavailable},
		By:       "ops@example.com",
		// No Expiry: a never-expiring waiver of the backstop sentinel must NOT be honored,
		// else a payload that merely forgot `expiry` disables the fail-closed gate forever.
	}
	wrongControl := &verify.Override{
		Controls: []string{"LEASTPRIV-001"},
		By:       "alice",
		Expiry:   time.Now().Add(time.Hour),
	}

	tests := []struct {
		name      string
		dryRun    bool
		report    *verify.Report
		override  *verify.Override
		wantError bool
	}{
		{name: "dry-run with no report is allowed (plan jobs apply nothing)", dryRun: true, report: nil, override: nil, wantError: false},
		{name: "report present proceeds (report's own enforcement runs separately)", dryRun: false, report: passReport, override: nil, wantError: false},
		{name: "THE BUG: real apply, nil report, no override -> REFUSE", dryRun: false, report: nil, override: nil, wantError: true},
		{name: "real apply, nil report, override waiving the sentinel -> allowed", dryRun: false, report: nil, override: covering, wantError: false},
		{name: "real apply, nil report, EXPIRED sentinel override -> REFUSE", dryRun: false, report: nil, override: expired, wantError: true},
		{name: "real apply, nil report, UNBOUNDED (no-expiry) sentinel override -> REFUSE (backstop needs a time-box)", dryRun: false, report: nil, override: unbounded, wantError: true},
		{name: "real apply, nil report, override for a different control -> REFUSE", dryRun: false, report: nil, override: wrongControl, wantError: true},
		{name: "dry-run with a covering override is still allowed (no-op)", dryRun: true, report: nil, override: covering, wantError: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := gateRequiresReport(tt.dryRun, tt.report, tt.override, showErr)
			if tt.wantError && err == nil {
				t.Fatalf("expected a refuse error, got nil (gate failed OPEN)")
			}
			if !tt.wantError && err != nil {
				t.Fatalf("expected apply to be allowed, got error: %v", err)
			}
			if tt.wantError {
				// The refuse message must name the sentinel so an operator knows how to
				// authorize an override, and surface the underlying show error.
				if !strings.Contains(err.Error(), verify.ControlPlanUnavailable) {
					t.Errorf("refuse error should name the %s sentinel: %v", verify.ControlPlanUnavailable, err)
				}
				if !strings.Contains(err.Error(), "produced no verdict") {
					t.Errorf("refuse error should explain the gate produced no verdict: %v", err)
				}
			}
		})
	}
}
