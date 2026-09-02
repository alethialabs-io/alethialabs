// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
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

// The empty-value sentinel is SymbolDash, in styles.go beside its siblings. This file deliberately
// does NOT introduce a second name for it.
//
// The first cut of this package exported `const Dash = SymbolDash`, reasoning that a caller should
// compare against a constant rather than write the rune again. But ~25 sites went on using
// SymbolDash directly, so the split re-created the very failure it was meant to end: change one and
// the other half of the tree keeps the old character. Three spellings became four. One name.

// OrDash renders a string, or the dash when it is empty.
func OrDash(s string) string {
	if s == "" {
		return SymbolDash
	}
	return s
}

// StrOrDash renders a nullable string, or the dash when it is unset or empty.
func StrOrDash(s *string) string {
	if s == nil || *s == "" {
		return SymbolDash
	}
	return *s
}

// IntOrDash renders a nullable int, or the dash when unset.
func IntOrDash(v *int) string {
	if v == nil {
		return SymbolDash
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
		return SymbolDash
	}
	return fmt.Sprintf("$%.2f", *v)
}

// StampOrDash renders an RFC3339 timestamp to the minute in UTC, or the dash when unset.
//
// Previously returned a hardcoded "—" rather than the shared glyph — the same character, but not
// the same constant, so a change to one would not have reached the other.
func StampOrDash(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return SymbolDash
	}
	if t, err := time.Parse(time.RFC3339, *v); err == nil {
		return t.UTC().Format("2006-01-02 15:04")
	}
	return *v
}

// Stamp renders an RFC3339 timestamp string the way the console writes an absolute date —
// `9 Mar 2026, 15:04` — in UTC.
//
// This is `packages/core/format.Date(DateTime, UTC)` with the wire's string form in front of it,
// and it exists because THREE command files needed exactly that and two of them had written their
// own: `costCapturedAt` (cost.go) and the raw echo in `staged.go`, which printed
// `2026-03-09T15:04:05Z` into a column a person reads. StampOrDash below is a DIFFERENT rule
// (`2006-01-02 15:04`) with its own callers; converging the two changes what those callers show and
// belongs to the lane that owns them, so this file now states both rather than pretending there is
// one.
//
// A stamp that does not parse is returned VERBATIM rather than dashed — the rule RelativeTime
// already follows: a timestamp the CLI cannot read is a wire problem, and showing it lets someone
// report what actually arrived. An EMPTY stamp is the dash, because there is nothing to report.
//
// UTC and not the host zone, for the reason format.Date states about its own parameter: a timestamp
// rendered against an ambient zone is a value that changes depending on which machine printed it.
func Stamp(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return SymbolDash
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return format.Date(t, format.DateTime, time.UTC)
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
	return SymbolDash
}

// GateGlyph renders an enabled/disabled gate as a tick or the dash.
func GateGlyph(on bool) string {
	if on {
		return SymbolSuccess
	}
	return SymbolDash
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
		return SymbolDash
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

// SmartTime renders a timestamp relatively inside a week and absolutely beyond it: "3 hours ago",
// then "2026-03-09". The dash for a zero time.
//
// The week cutoff is the point where "ago" stops helping — nobody converts "5 weeks ago" back to a
// date in their head, and nobody wants a calendar date for something that happened this morning.
//
// This is one of THREE relative-time renderings the CLI carries. The other two are RelativeTime
// (always relative, from an RFC3339 string) and bare humanize.Time. They take different input types
// and only this one has a cutoff, so they cannot simply be merged — converging them changes what a
// user sees and belongs to the lane that owns that decision. Hoisting it here is step one: they can
// only be compared once they are in the same place.
func SmartTime(t time.Time) string {
	if t.IsZero() {
		return SymbolDash
	}
	if time.Since(t).Hours() < 24*7 {
		return humanize.Time(t)
	}
	return t.Format("2006-01-02")
}
