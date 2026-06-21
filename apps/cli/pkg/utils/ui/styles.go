// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Alethia Labs is a strictly grayscale brand: zero chroma, dark-first. Meaning
// is carried by ink weight and glyph shape, never by hue. The palette below is
// a terminal projection of the OKLCH neutral ink ramp; AdaptiveColor keeps it
// legible on both dark (signature) and light terminals.

// --- Palette (grayscale ink ramp) ---

var (
	// InkPrimary is the strongest foreground — headings, values, emphasis.
	InkPrimary = lipgloss.AdaptiveColor{Light: "#161616", Dark: "#FAFAFA"}
	// InkSecondary is standard body text.
	InkSecondary = lipgloss.AdaptiveColor{Light: "#3D3D3D", Dark: "#B3B3B3"}
	// InkMuted is secondary/labels/borders.
	InkMuted = lipgloss.AdaptiveColor{Light: "#757575", Dark: "#808080"}
	// InkFaint is the dimmest readable ink — disabled, hints, rules.
	InkFaint = lipgloss.AdaptiveColor{Light: "#A3A3A3", Dark: "#595959"}
	// InkInverse is foreground for text rendered on an inverted (ink) surface.
	InkInverse = lipgloss.AdaptiveColor{Light: "#FAFAFA", Dark: "#161616"}
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
	SymbolDash    = "—"
	SymbolBullet  = "·"
	SymbolArrow   = "→"
	SymbolPoint   = "▸"
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
	upper := strings.ToUpper(label)
	spaced := strings.Join(strings.Split(upper, ""), " ")
	return EyebrowStyle.Render(spaced)
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
