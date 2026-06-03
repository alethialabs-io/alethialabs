package ui

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

// --- Colors ---

const (
	ColorSuccess = "42"  // green
	ColorError   = "196" // red
	ColorWarning = "214" // amber
	ColorAccent  = "63"  // purple
	ColorCyan    = "86"  // cyan
	ColorLink    = "39"  // blue
	ColorText    = "252" // light grey
	ColorMuted   = "240" // dim grey
	ColorValue   = "255" // white
	ColorKey     = "244" // mid grey
	ColorSelect  = "229" // yellow (selected row text)
)

// --- Styles ---

var (
	SuccessStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorSuccess)).Bold(true)
	ErrorStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorError)).Bold(true)
	WarningStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorWarning)).Bold(true)
	AccentStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorAccent)).Bold(true)
	CyanStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorCyan)).Bold(true)
	TextStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorText))
	MutedStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorMuted))
	LinkStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorLink)).Underline(true)
	KeyStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorKey)).Padding(0, 2, 0, 2)
	ValueStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorValue))
)

// --- Symbols ---

const (
	SymbolSuccess = "✓"
	SymbolError   = "✗"
	SymbolOnline  = "●"
	SymbolOffline = "○"
	SymbolPending = "◐"
	SymbolDefault = "★"
	SymbolDash    = "—"
	SymbolWaiting = "⏳"
)

// --- Message Helpers ---

func Success(msg string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(SymbolSuccess+" "+msg))
}

func Error(msg string) {
	fmt.Printf("\n%s\n", ErrorStyle.Render(SymbolError+" "+msg))
}

func Warning(msg string) {
	fmt.Printf("\n%s\n", WarningStyle.Render(msg))
}

func Info(msg string) {
	fmt.Println(TextStyle.Render(msg))
}

func Muted(msg string) {
	fmt.Println(MutedStyle.Render(msg))
}

func JobQueued(jobType, jobID string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(fmt.Sprintf("%s Queued %s job (ID: %s)", SymbolSuccess, jobType, jobID)))
	fmt.Printf("Monitor with: grape jobs logs %s --follow\n", jobID)
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
		return SuccessStyle.Render(SymbolOnline)
	case "DRAINING", "CREATING", "UPDATING", "PROVISIONING", "QUEUED":
		return WarningStyle.Render(SymbolPending)
	case "FAILED":
		return ErrorStyle.Render(SymbolError)
	case "DESTROYED":
		return MutedStyle.Render(SymbolDash)
	default:
		return MutedStyle.Render(SymbolOffline)
	}
}

func DefaultBadge() string {
	return CyanStyle.Render(" " + SymbolDefault)
}
