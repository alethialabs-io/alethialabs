// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
)

const (
	stepDone   = "◆"
	stepFuture = "◇"
)

func TestRenderStepper(t *testing.T) {
	steps := []string{"Authenticate", "Provision", "Verify"}

	tests := []struct {
		name       string
		steps      []string
		current    int
		wantSolid  int
		wantHollow int
	}{
		{name: "first step is current", steps: steps, current: 0, wantSolid: 1, wantHollow: 2},
		{name: "middle step", steps: steps, current: 1, wantSolid: 2, wantHollow: 1},
		{name: "last step", steps: steps, current: 2, wantSolid: 3, wantHollow: 0},
		{name: "single step", steps: []string{"Only"}, current: 0, wantSolid: 1, wantHollow: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RenderStepper(tt.steps, tt.current)
			if n := strings.Count(got, stepDone); n != tt.wantSolid {
				t.Errorf("solid glyphs = %d, want %d in %q", n, tt.wantSolid, got)
			}
			if n := strings.Count(got, stepFuture); n != tt.wantHollow {
				t.Errorf("hollow glyphs = %d, want %d in %q", n, tt.wantHollow, got)
			}
			for _, s := range tt.steps {
				if !strings.Contains(got, s) {
					t.Errorf("stepper missing label %q: %q", s, got)
				}
			}
			if want := len(tt.steps) - 1; strings.Count(got, "──") != want {
				t.Errorf("connectors = %d, want %d in %q", strings.Count(got, "──"), want, got)
			}
		})
	}
}

func TestRenderStepperEmpty(t *testing.T) {
	if got := RenderStepper(nil, 0); got != "" {
		t.Errorf("RenderStepper(nil, 0) = %q, want an empty string", got)
	}
}

func TestPrintStepperWritesTheRenderedStepper(t *testing.T) {
	steps := []string{"Authenticate", "Provision"}
	out := captureStdout(t, func() { PrintStepper(steps, 1) })
	if !strings.Contains(out, RenderStepper(steps, 1)) {
		t.Errorf("PrintStepper output %q does not contain the rendered stepper", out)
	}
	if !strings.HasSuffix(out, "\n\n") {
		t.Errorf("PrintStepper must leave a blank line after the stepper, got %q", out)
	}
}
