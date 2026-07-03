// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"sync"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

// The interactive widgets (huh forms/selects/confirms/inputs and the loading
// spinner) ship with Charm's colorful default theme. This file is the single
// place that re-skins them to the brand's zero-chroma grayscale ink ramp, the
// interactive counterpart to styles.go — meaning reads by ink weight and glyph,
// never by hue. Construct every form via NewForm and every spinner via RunSpinner
// so no widget can leak the stock theme.

// SpinnerStyle is the grayscale style for the loading spinner glyph.
var SpinnerStyle = lipgloss.NewStyle().Foreground(InkPrimary)

var (
	huhThemeOnce sync.Once
	huhThemeInst *huh.Theme
)

// HuhTheme returns the shared grayscale huh theme, built once from the monochrome
// huh.ThemeBase() and recolored with the Ink ramp. Every visible style is forced
// onto an Ink color so a form has no purple/green anywhere.
func HuhTheme() *huh.Theme {
	huhThemeOnce.Do(func() {
		t := huh.ThemeBase()

		// Focused field styles.
		t.Focused.Base = t.Focused.Base.BorderForeground(InkFaint)
		t.Focused.Title = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
		t.Focused.NoteTitle = t.Focused.Title
		t.Focused.Description = lipgloss.NewStyle().Foreground(InkMuted)
		t.Focused.SelectSelector = lipgloss.NewStyle().Foreground(InkPrimary).SetString(SymbolPoint + " ")
		t.Focused.MultiSelectSelector = t.Focused.SelectSelector
		t.Focused.Option = lipgloss.NewStyle().Foreground(InkSecondary)
		t.Focused.SelectedOption = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
		t.Focused.SelectedPrefix = lipgloss.NewStyle().Foreground(InkPrimary).SetString(SymbolSuccess + " ")
		t.Focused.UnselectedOption = lipgloss.NewStyle().Foreground(InkMuted)
		t.Focused.UnselectedPrefix = lipgloss.NewStyle().Foreground(InkFaint).SetString("  ")
		t.Focused.FocusedButton = lipgloss.NewStyle().
			Foreground(InkInverse).Background(InkPrimary).Bold(true).Padding(0, 2).MarginRight(1)
		t.Focused.BlurredButton = lipgloss.NewStyle().
			Foreground(InkSecondary).Background(InkFaint).Padding(0, 2).MarginRight(1)
		t.Focused.NextIndicator = t.Focused.NextIndicator.Foreground(InkMuted)
		t.Focused.PrevIndicator = t.Focused.PrevIndicator.Foreground(InkMuted)
		t.Focused.ErrorIndicator = lipgloss.NewStyle().Foreground(InkPrimary).SetString(" " + SymbolError)
		t.Focused.ErrorMessage = lipgloss.NewStyle().Foreground(InkPrimary)
		t.Focused.TextInput.Cursor = lipgloss.NewStyle().Foreground(InkPrimary)
		t.Focused.TextInput.Prompt = lipgloss.NewStyle().Foreground(InkMuted)
		t.Focused.TextInput.Placeholder = lipgloss.NewStyle().Foreground(InkFaint)
		t.Focused.TextInput.Text = lipgloss.NewStyle().Foreground(InkPrimary)

		// Group heading.
		t.Group.Title = t.Focused.Title
		t.Group.Description = t.Focused.Description

		// Blurred inherits the focused styles, then dims and hides the accent bar.
		blurred := t.Focused
		blurred.Base = t.Focused.Base.BorderStyle(lipgloss.HiddenBorder())
		blurred.Title = lipgloss.NewStyle().Foreground(InkMuted)
		blurred.NoteTitle = blurred.Title
		blurred.MultiSelectSelector = lipgloss.NewStyle().SetString("  ")
		t.Blurred = blurred

		huhThemeInst = t
	})
	return huhThemeInst
}

// NewForm builds a huh form with the grayscale theme applied — the single
// construction point so no interactive form uses the stock colorful theme.
func NewForm(groups ...*huh.Group) *huh.Form {
	return huh.NewForm(groups...).WithTheme(HuhTheme())
}
