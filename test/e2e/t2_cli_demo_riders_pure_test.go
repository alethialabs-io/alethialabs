// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"strings"
	"testing"
)

// TestCLIDemoRiderDecision pins the three outcomes: silent off cli-demo, announced when withheld on
// cli-demo, refused before spend when one is actually on under cli-demo.
func TestCLIDemoRiderDecision(t *testing.T) {
	riders := func(keyless, xacct, registry bool) map[string]bool {
		return map[string]bool{"#1511 keyless DB": keyless, "#1268 cross-account secrets": xacct, "#1047 cross-account registry": registry}
	}

	t.Run("not cli-demo is silent whatever is on", func(t *testing.T) {
		notes, err := cliDemoRiderDecision(false, riders(true, true, true))
		if err != nil || len(notes) != 0 {
			t.Fatalf("off cli-demo the riders must stand as decided, got notes=%v err=%v", notes, err)
		}
	})

	t.Run("cli-demo with every rider withheld announces each one", func(t *testing.T) {
		notes, err := cliDemoRiderDecision(true, riders(false, false, false))
		if err != nil {
			t.Fatalf("withheld riders must not fail the run: %v", err)
		}
		if len(notes) != 3 {
			t.Fatalf("want one NOT RUN note per rider, got %d: %v", len(notes), notes)
		}
		for _, n := range notes {
			if !strings.Contains(n, "NOT RUN on cli-demo") || !strings.Contains(n, "NOT proven") {
				t.Errorf("a withheld rider must say it was not proven, got %q", n)
			}
		}
	})

	t.Run("cli-demo with a rider on is refused naming it", func(t *testing.T) {
		notes, err := cliDemoRiderDecision(true, riders(true, false, false))
		if err == nil {
			t.Fatal("a rider switched on under cli-demo must be refused before spend")
		}
		if !strings.Contains(err.Error(), "#1511 keyless DB") || strings.Contains(err.Error(), "#1268") {
			t.Errorf("the refusal must name exactly the rider that was on, got %v", err)
		}
		if len(notes) != 2 {
			t.Errorf("the other two riders are still announced as not run, got %v", notes)
		}
	})
}
