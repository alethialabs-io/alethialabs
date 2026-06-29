// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"testing"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

// grayscaleInks is the set of colors a fully-rebranded interactive widget may
// use. Any foreground/background outside this set (e.g. Charm's #F780E2 pink or
// the purple highlight) is a rebrand regression.
func isGrayscaleInk(c lipgloss.TerminalColor) bool {
	switch c {
	case InkPrimary, InkSecondary, InkMuted, InkFaint, InkInverse:
		return true
	}
	// No color set (inherits terminal foreground) is also fine.
	return c == nil || c == lipgloss.Color("") || c == lipgloss.NoColor{}
}

func TestHuhThemeIsGrayscale(t *testing.T) {
	th := HuhTheme()
	if th == nil {
		t.Fatal("HuhTheme returned nil")
	}

	// The styles that carried Charm's purple/pink/green must now be Ink-only.
	checks := []struct {
		name string
		fg   lipgloss.TerminalColor
	}{
		{"Focused.Title", th.Focused.Title.GetForeground()},
		{"Focused.Description", th.Focused.Description.GetForeground()},
		{"Focused.SelectSelector", th.Focused.SelectSelector.GetForeground()},
		{"Focused.SelectedOption", th.Focused.SelectedOption.GetForeground()},
		{"Focused.Option", th.Focused.Option.GetForeground()},
		{"Focused.ErrorMessage", th.Focused.ErrorMessage.GetForeground()},
		{"Focused.TextInput.Cursor", th.Focused.TextInput.Cursor.GetForeground()},
		{"Focused.TextInput.Prompt", th.Focused.TextInput.Prompt.GetForeground()},
		{"Group.Title", th.Group.Title.GetForeground()},
	}
	for _, c := range checks {
		if !isGrayscaleInk(c.fg) {
			t.Errorf("%s foreground %v is not a grayscale Ink color", c.name, c.fg)
		}
	}

	// The focused button (the most visible accent) must be inverse-ink on ink.
	if th.Focused.FocusedButton.GetBackground() != InkPrimary {
		t.Errorf("FocusedButton background = %v, want InkPrimary", th.Focused.FocusedButton.GetBackground())
	}
	if th.Focused.FocusedButton.GetForeground() != InkInverse {
		t.Errorf("FocusedButton foreground = %v, want InkInverse", th.Focused.FocusedButton.GetForeground())
	}
}

func TestHuhThemeMemoized(t *testing.T) {
	a, b := HuhTheme(), HuhTheme()
	if a != b {
		t.Error("HuhTheme should return the same memoized instance")
	}
}

func TestNewFormAppliesTheme(t *testing.T) {
	// Construct a form through the helper; it must not panic and must be non-nil.
	form := NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Pick").
				Options(huh.NewOption("a", "a")),
		),
	)
	if form == nil {
		t.Fatal("NewForm returned nil")
	}
}

func TestSpinnerStyleIsGrayscale(t *testing.T) {
	if SpinnerStyle.GetForeground() != InkPrimary {
		t.Errorf("SpinnerStyle foreground = %v, want InkPrimary", SpinnerStyle.GetForeground())
	}
}
