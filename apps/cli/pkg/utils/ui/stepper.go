// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"
)

// RenderStepper returns a visual progress stepper string.
// steps: list of step names
// current: 0-based index of the current step
func RenderStepper(steps []string, current int) string {
	// Grayscale: progress reads from glyph fill and ink weight, not color.
	// Completed → solid diamond, faint ink. Current → solid diamond, strong ink.
	// Future → hollow diamond, muted ink.
	var renderedSteps []string

	for i, step := range steps {
		var icon, label string

		switch {
		case i < current: // Completed
			icon = FaintStyle.Render("◆")
			label = FaintStyle.Render(step)
		case i == current: // Current
			icon = StrongStyle.Render("◆")
			label = StrongStyle.Render(step)
		default: // Future
			icon = MutedStyle.Render("◇")
			label = MutedStyle.Render(step)
		}

		renderedSteps = append(renderedSteps, fmt.Sprintf("%s %s", icon, label))
	}

	connector := FaintStyle.Render(" ── ")
	return strings.Join(renderedSteps, connector)
}

// PrintStepper prints the rendered stepper to stdout.
func PrintStepper(steps []string, current int) {
	fmt.Println(RenderStepper(steps, current))
	fmt.Println()
}
