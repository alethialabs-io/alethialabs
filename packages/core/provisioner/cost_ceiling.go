// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
)

// costCeilingBlock is the fail-closed cost guard for the real-apply path. When a
// non-zero monthly-USD ceiling is configured, a real apply must not proceed if the
// Infracost estimate exceeds it — or if no estimate could be produced at all: a ceiling
// was requested but we can't price the plan, so we REFUSE rather than let an unpriced
// plan through (mirrors gateRequiresReport's "no verdict is not a pass" ethos).
//
// A ceiling of 0 (or negative) DISABLES the guard — the default, so every existing caller
// (and every real customer apply) is unaffected. It is opt-in per deploy via
// DeployParams.CostCeilingMonthlyUSD, wired from ALETHIA_COST_CEILING_MONTHLY_USD in the
// runner; enabling it therefore requires a working INFRACOST_API_KEY (else the "no estimate"
// branch fail-closes).
//
// Returns (blocked, human-readable message). The caller returns the message as an error and
// emits the gate-blocked metric. Pure + side-effect-free so it can be table-tested offline.
func costCeilingBlock(cb *infracost.CostBreakdown, ceilingUSD float64) (bool, string) {
	if ceilingUSD <= 0 {
		return false, "" // guard disabled (default)
	}
	if cb == nil || cb.Summary == nil {
		return true, fmt.Sprintf(
			"cost ceiling BLOCKED apply: a $%.2f/mo ceiling is set but no Infracost estimate could be "+
				"produced (is INFRACOST_API_KEY set and did `infracost breakdown` succeed?) — refusing to "+
				"apply an unpriced plan", ceilingUSD)
	}
	if cb.Summary.TotalMonthly > ceilingUSD {
		return true, fmt.Sprintf(
			"cost ceiling BLOCKED apply: estimated $%.2f/mo exceeds the $%.2f/mo ceiling — shrink the plan "+
				"(cheaper node shape / single NAT / fewer resources) or raise the ceiling",
			cb.Summary.TotalMonthly, ceilingUSD)
	}
	return false, ""
}
