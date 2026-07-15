// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// Issue #526. A FAILED (not interrupted) apply can leave a cloud resource outside tofu state and
// PERMANENTLY WEDGE the environment — every later apply dies with `already exists ... needs to be
// imported`. The runner used to report orphan_risk=false on exactly that failure.
//
// These tests pin the two halves of the fix at THIS layer:
//   - a failed apply carrying positive evidence is lifted into orphan_risk metadata, and
//   - an ordinary failure still is not (the "normal failures do not over-alert" property).

// The real Azure wedge, as the deploy path would wrap it.
func wedgeErr() error {
	raw := errors.New(`Error: a resource with the ID "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Cache/redisEnterprise/r" already exists - to be managed via Terraform this resource needs to be imported into the State.

  with module.azure_cache[0].azurerm_managed_redis.this,
  on modules/azure-cache-redis/main.tf line 23, in resource "azurerm_managed_redis" "this":`)
	f := provisioner.ClassifyApplyError(raw, "")
	return &provisioner.ApplyOrphanError{Err: raw, Finding: f}
}

func TestApplyOrphanFinding_LiftsEvidenceFromAFailedApply(t *testing.T) {
	f, ok := applyOrphanFinding(wedgeErr())
	if !ok {
		t.Fatal("a failed apply carrying orphan evidence must be recognised — this is the bug (#526): it was silently reported as orphan_risk=false")
	}
	if f.Evidence != provisioner.OrphanCertain {
		t.Errorf("evidence = %v, want certain", f.Evidence)
	}
	// The whole point is an ACTIONABLE diagnosis: the operator needs the import pair.
	if f.Address == "" || f.CloudID == "" {
		t.Errorf("finding must carry an importable pair; got address=%q cloudID=%q", f.Address, f.CloudID)
	}
	if !strings.Contains(strings.ToLower(f.Reason), "wedged") {
		t.Errorf("reason should tell the operator the env is wedged; got: %s", f.Reason)
	}
}

// errors.As must see through wrapping — the deploy path's error travels up through the job
// executor, so a %w wrap anywhere in between must not lose the finding.
func TestApplyOrphanFinding_SurvivesWrapping(t *testing.T) {
	wrapped := fmt.Errorf("deploy job failed: %w", wedgeErr())

	f, ok := applyOrphanFinding(wrapped)
	if !ok {
		t.Fatal("finding must survive error wrapping (errors.As), or the runner will drop the diagnosis")
	}
	if f.Evidence != provisioner.OrphanCertain {
		t.Errorf("evidence = %v, want certain", f.Evidence)
	}
}

// NO OVER-ALERTING. The original design was right that ordinary failures leave nothing behind;
// flagging them would cry wolf. A plain error carries no evidence and must not be flagged.
func TestApplyOrphanFinding_OrdinaryFailureIsNotFlagged(t *testing.T) {
	plain := errors.New("tofu apply failed: Error: Invalid value for variable \"region\"")

	if _, ok := applyOrphanFinding(plain); ok {
		t.Error("an ordinary failure must NOT be flagged as an orphan — over-alerting is what the original design correctly avoided")
	}
}

// The interrupt path is untouched: shouldMarkOrphanRisk still governs cancels/timeouts, and still
// refuses to flag anything that never reached the state-mutating apply.
func TestShouldMarkOrphanRisk_InterruptPathUnchanged(t *testing.T) {
	tests := []struct {
		name         string
		phase        string
		wasCancelled bool
		ctxErr       error
		want         bool
	}{
		{"cancel mid-apply is flagged", "apply", true, nil, true},
		{"timeout mid-apply is flagged", "apply", false, context_DeadlineExceeded(), true},
		{"pre-apply interrupt never mutated cloud state", "plan", true, context_DeadlineExceeded(), false},
		{"plain failure is not flagged HERE (evidence path handles it)", "apply", false, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldMarkOrphanRisk(tt.phase, tt.wasCancelled, tt.ctxErr); got != tt.want {
				t.Errorf("shouldMarkOrphanRisk(%q, %v, %v) = %v, want %v", tt.phase, tt.wasCancelled, tt.ctxErr, got, tt.want)
			}
		})
	}
}

func context_DeadlineExceeded() error { return errors.New("context deadline exceeded") }
