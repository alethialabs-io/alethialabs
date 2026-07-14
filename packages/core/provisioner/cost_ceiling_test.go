// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
)

// TestCostCeilingBlock covers the opt-in fail-closed cost guard: disabled by a zero/negative
// ceiling, fail-closed when a ceiling is set but no estimate exists, blocking above the
// ceiling, and allowing at/below it.
func TestCostCeilingBlock(t *testing.T) {
	cb := func(monthly float64) *infracost.CostBreakdown {
		return &infracost.CostBreakdown{Summary: &infracost.CostSummary{TotalMonthly: monthly}}
	}

	tests := []struct {
		name        string
		cb          *infracost.CostBreakdown
		ceiling     float64
		wantBlocked bool
		wantMsgHas  string
	}{
		{name: "disabled zero ceiling ignores a huge estimate", cb: cb(9999), ceiling: 0, wantBlocked: false},
		{name: "disabled negative ceiling", cb: cb(9999), ceiling: -1, wantBlocked: false},
		{name: "nil breakdown fail-closed", cb: nil, ceiling: 300, wantBlocked: true, wantMsgHas: "no Infracost estimate"},
		{name: "nil summary fail-closed", cb: &infracost.CostBreakdown{}, ceiling: 300, wantBlocked: true, wantMsgHas: "no Infracost estimate"},
		{name: "over ceiling blocks", cb: cb(350.5), ceiling: 300, wantBlocked: true, wantMsgHas: "exceeds"},
		{name: "at ceiling allows", cb: cb(300), ceiling: 300, wantBlocked: false},
		{name: "under ceiling allows", cb: cb(180.25), ceiling: 300, wantBlocked: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocked, msg := costCeilingBlock(tt.cb, tt.ceiling)
			if blocked != tt.wantBlocked {
				t.Fatalf("costCeilingBlock() blocked = %v, want %v (msg=%q)", blocked, tt.wantBlocked, msg)
			}
			if !blocked && msg != "" {
				t.Errorf("not blocked but got a non-empty message: %q", msg)
			}
			if tt.wantMsgHas != "" && !strings.Contains(msg, tt.wantMsgHas) {
				t.Errorf("message %q does not contain %q", msg, tt.wantMsgHas)
			}
		})
	}
}
