// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/dustin/go-humanize"
)

// Render helpers shared by every command.
//
// These were defined in whichever `cmd/*.go` file happened to need one first — `orDash` in
// config.go and used by eight other files, `yesNo` in channels.go used by five, `formatCreatedAt`
// in connector_list.go used by three. That is why the CLI's command files could not be worked on in
// parallel: any lane touching a render had to edit a command file another lane owned. The functions
// were never the problem; their ADDRESSES were.
//
// One consequence was visible to users. The empty-value sentinel had THREE spellings — SymbolDash,
// a hardcoded "—" in token.go, and the string "N/A" in config_printer.go — so the same "nothing to
// show" rendered three ways depending on which command you ran.
//
// NOT HERE, deliberately:
//
//   - `openBrowser` (login.go) is a package var so tests can swap it. It is an ACTION, not a
//     renderer, and moving it would move a test seam for no benefit.
//   - `formatDuration` (jobs_list.go) takes a started/completed pair and appends "…" for a running
//     job. Its rule is being replaced wholesale by `packages/core/format.Duration`, so hoisting it
//     here first would move it twice.

// Dash is the empty-value sentinel. One glyph, one spelling.
//
// Exported so a caller can compare against it rather than writing the rune again — a literal "—"
// somewhere in the tree is how the three spellings happened.
const Dash = SymbolDash

// OrDash renders a string, or the dash when it is empty.
func OrDash(s string) string {
	if s == "" {
		return Dash
	}
	return s
}

// StrOrDash renders a nullable string, or the dash when it is unset or empty.
func StrOrDash(s *string) string {
	if s == nil || *s == "" {
		return Dash
	}
	return *s
}

// IntOrDash renders a nullable int, or the dash when unset.
func IntOrDash(v *int) string {
	if v == nil {
		return Dash
	}
	return fmt.Sprintf("%d", *v)
}

// FloatOrDash renders a nullable USD/mo threshold, or the dash when unset.
//
// The `$%.2f` is money and does not belong in a render helper — Go's %f rounds half to EVEN, so
// 12.5 prints 12.50 here but a sibling site using %.0f prints 12 for the same amount. It is hoisted
// AS-IS on purpose: this lane moves addresses, it does not change answers. #3659 re-points it at
// `packages/core/format.MonthlyRate`, which is where that defect is fixed.
func FloatOrDash(v *float64) string {
	if v == nil {
		return Dash
	}
	return fmt.Sprintf("$%.2f", *v)
}

// StampOrDash renders an RFC3339 timestamp to the minute in UTC, or the dash when unset.
//
// Previously returned a hardcoded "—" rather than the shared glyph — the same character, but not
// the same constant, so a change to one would not have reached the other.
func StampOrDash(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return Dash
	}
	if t, err := time.Parse(time.RFC3339, *v); err == nil {
		return t.UTC().Format("2006-01-02 15:04")
	}
	return *v
}

// StampOrNever renders an RFC3339 timestamp, or the word "never" when unset.
//
// The distinction from StampOrDash is deliberate and worth keeping: a dash means "we do not know",
// "never" means "we know, and it has not happened". A token that has never been used is a different
// statement from a token whose last use we failed to read.
func StampOrNever(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return "never"
	}
	return StampOrDash(v)
}

// YesNo renders a boolean as a filled glyph or the dash.
func YesNo(b bool) string {
	if b {
		return SymbolDefault
	}
	return Dash
}

// GateGlyph renders an enabled/disabled gate as a tick or the dash.
func GateGlyph(on bool) string {
	if on {
		return SymbolSuccess
	}
	return Dash
}

// RelativeTime renders an RFC3339 timestamp as "3 minutes ago", the dash when empty, and the raw
// string when it does not parse.
//
// Returning the RAW value on a parse failure rather than the dash is intentional: a timestamp the
// CLI cannot read is a wire problem, and showing it lets someone report what actually arrived. A
// dash would hide it.
//
// Named for what it does rather than `formatCreatedAt`, which named ONE of its callers — the
// others pass a last-seen and a decided-at.
func RelativeTime(raw string) string {
	if raw == "" {
		return Dash
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return humanize.Time(t)
}

// TruncID shortens an opaque id for a table cell, with an ellipsis when it was cut.
//
// Eight characters, because that is what every existing caller used and a job id collision inside
// one org's visible list is not a realistic risk at that width.
func TruncID(id string) string {
	if len(id) > 8 {
		return id[:8] + "…"
	}
	return id
}
