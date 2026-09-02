// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/ui/theme"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/charmbracelet/lipgloss"
)

// Alethia Labs is a strictly grayscale brand: zero chroma, dark-first. Meaning
// is carried by ink weight and glyph shape, never by hue. The palette below is
// a terminal projection of the OKLCH neutral ink ramp; AdaptiveColor keeps it
// legible on both dark (signature) and light terminals.

// --- Palette (grayscale ink ramp) ---
//
// These five were hand-typed AdaptiveColors claiming to be a projection of the
// ramp above. Exactly one of their ten hex values was a step of that ramp
// (#FAFAFA = gray-50); #808080, #B3B3B3, #A3A3A3, #3D3D3D, #757575, #595959 and
// #161616 are not steps of anything. The console's --text-tertiary is also ONE
// ink in both themes, and this file had two. They are now aliases of the
// generated projection (packages/core/types/brand_gen.go), derived from the stylesheet that
// owns them. Change a colour in packages/brand/src/tokens.css, regenerate, and
// both surfaces move together; there is nothing to re-type here.

var (
	// InkPrimary is the strongest foreground — headings, values, emphasis.
	InkPrimary = theme.InkPrimary
	// InkSecondary is standard body text.
	InkSecondary = theme.InkSecondary
	// InkMuted is secondary/labels/borders.
	InkMuted = theme.InkMuted
	// InkFaint is the dimmest readable ink — disabled, hints, rules.
	InkFaint = theme.InkFaint
	// InkInverse is foreground for text rendered on an inverted (ink) surface.
	InkInverse = theme.InkInverse
)

// --- Styles ---
//
// The semantic names are kept stable for call sites. Success and error share the
// same strong ink — they are distinguished by their glyph (✓ vs ✗), not color,
// per the brand's "status by shape, never hue" rule.

var (
	StrongStyle    = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	SuccessStyle   = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	ErrorStyle     = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	WarningStyle   = lipgloss.NewStyle().Foreground(InkSecondary)
	AccentStyle    = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	CyanStyle      = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	TextStyle      = lipgloss.NewStyle().Foreground(InkPrimary)
	SecondaryStyle = lipgloss.NewStyle().Foreground(InkSecondary)
	MutedStyle     = lipgloss.NewStyle().Foreground(InkMuted)
	FaintStyle     = lipgloss.NewStyle().Foreground(InkFaint)
	LinkStyle      = lipgloss.NewStyle().Foreground(InkPrimary).Underline(true)
	KeyStyle       = lipgloss.NewStyle().Foreground(InkMuted).Padding(0, 2, 0, 2)
	ValueStyle     = lipgloss.NewStyle().Foreground(InkPrimary)
	// EyebrowStyle renders the uppercase mono label device (tracked via Eyebrow).
	EyebrowStyle = lipgloss.NewStyle().Foreground(InkMuted)
	// MarkStyle renders the [·] brand mark.
	MarkStyle = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
)

// --- Symbols ---
//
// Geometric, monochrome glyphs only — no colorful emoji. Status reads by fill
// and shape: solid (●) active, half (◐) in-progress, hollow (○) idle, dash (—)
// gone, ✗ failed.

const (
	SymbolSuccess = "✓"
	SymbolError   = "✗"
	SymbolOnline  = "●"
	SymbolOffline = "○"
	SymbolPending = "◐"
	SymbolDefault = "◆"
	// SymbolDash IS format.Dash — one definition, in `packages/core`, because that is the half
	// the runner and the console-facing formatter can both see and `packages/core` cannot import
	// `apps/cli`. It was an independent `"—"` literal until #3659, which is the defect: two
	// definitions of one glyph that a change reaches only one of.
	//
	// #3659 ruled that this name should be DELETED rather than pointed at the shared value, and
	// that is still the right end state — one thing deserves one name. It is not done here because
	// deleting it forces an edit to nine command files this unit's `scope:` does not own, one of
	// which (`org_select.go`) a different lane is editing right now, and a mega-commit across
	// another lane's files is the exact tangle the board's disjoint scopes exist to prevent. The
	// DRIFT is closed today; the RENAME is owed, and each noun group can pay it in its own lane
	// without coordinating with anyone.
	SymbolDash   = format.Dash
	SymbolBullet = "·"
	SymbolArrow  = "→"
	SymbolPoint  = "▸"
)

// Mark is the Alethia bracketed-point brand mark.
const Mark = "[·]"

// --- Brand helpers ---

// RenderMark returns the [·] mark in strong ink.
func RenderMark() string {
	return MarkStyle.Render(Mark)
}

// Eyebrow renders an uppercase, letter-spaced mono label — the brand's eyebrow
// device (e.g. "CONTROL PLANE").
func Eyebrow(label string) string {
	// theme.Track is the projection of --tracking-eyebrow: the grid cannot give
	// you 0.16 of a cell, so the device spends a whole one. Same output as the
	// literal " " join it replaces — the point is that the separator now has one
	// owner, which is the token.
	return EyebrowStyle.Render(theme.Track(strings.ToUpper(label)))
}

// --- Message Helpers ---

func Success(msg string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(SymbolSuccess+" "+msg))
}

func Error(msg string) {
	fmt.Printf("\n%s\n", ErrorStyle.Render(SymbolError+" "+msg))
}

func Warning(msg string) {
	fmt.Printf("\n%s\n", WarningStyle.Render(SymbolPoint+" "+msg))
}

func Info(msg string) {
	fmt.Println(TextStyle.Render(msg))
}

func Muted(msg string) {
	fmt.Println(MutedStyle.Render(msg))
}

func JobQueued(jobType, jobID string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(fmt.Sprintf("%s Queued %s job (ID: %s)", SymbolSuccess, jobType, jobID)))
	fmt.Printf("Monitor with: alethia jobs logs %s --follow\n", jobID)
}

func FormatSuccess(msg string) string {
	return SuccessStyle.Render(SymbolSuccess + " " + msg)
}

func FormatError(msg string) string {
	return ErrorStyle.Render(SymbolError + " " + msg)
}

// --- Status Helpers ---

func StatusDot(status string) string {
	switch status {
	case "ONLINE", "ACTIVE":
		return StrongStyle.Render(SymbolOnline)
	case "DRAINING", "CREATING", "UPDATING", "PROVISIONING", "QUEUED":
		return SecondaryStyle.Render(SymbolPending)
	case "FAILED":
		return StrongStyle.Render(SymbolError)
	case "DESTROYED":
		return FaintStyle.Render(SymbolDash)
	default:
		return MutedStyle.Render(SymbolOffline)
	}
}

// PlainStatusDot returns an unstyled status symbol safe for use inside
// bubbles/table cells (ANSI codes break column width calculation).
func PlainStatusDot(status string) string {
	switch status {
	case "ONLINE", "ACTIVE":
		return SymbolOnline
	case "DRAINING", "CREATING", "UPDATING", "PROVISIONING", "QUEUED":
		return SymbolPending
	case "FAILED":
		return SymbolError
	case "DESTROYED":
		return SymbolDash
	default:
		return SymbolOffline
	}
}

func DefaultBadge() string {
	return FaintStyle.Render(" " + SymbolDefault)
}
