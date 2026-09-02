// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
	"time"
)

// ONE spelling of "nothing to show". Before this package there were three — SymbolDash in most
// commands, a hardcoded em dash in token.go, and the literal "N/A" in config_printer.go — so the
// same absence rendered differently depending on which command you ran.
//
// There is nothing to assert EQUAL any more, and that is the point: the earlier version of this
// test compared a second exported name against SymbolDash, which passed right up until someone
// edited one of them. Deleting the second name deleted the comparison. What is left is the only
// thing still worth pinning — the constant's VALUE, since callers that write the rune inline rather
// than reusing it are how three spellings happened in the first place.
func TestDashIsTheEmDash(t *testing.T) {
	if SymbolDash != "—" {
		t.Errorf("SymbolDash = %q (%U), want an em dash U+2014", SymbolDash, []rune(SymbolDash)[0])
	}
}

func TestOrDashFamily(t *testing.T) {
	s := "value"
	empty := ""
	n := 7
	f := 12.5

	cases := map[string]struct{ got, want string }{
		"OrDash passes a value through":      {OrDash("x"), "x"},
		"OrDash on empty":                    {OrDash(""), SymbolDash},
		"StrOrDash passes a value through":   {StrOrDash(&s), "value"},
		"StrOrDash on nil":                   {StrOrDash(nil), SymbolDash},
		"StrOrDash on a pointer to empty":    {StrOrDash(&empty), SymbolDash},
		"IntOrDash renders the number":       {IntOrDash(&n), "7"},
		"IntOrDash on nil":                   {IntOrDash(nil), SymbolDash},
		"IntOrDash renders a legitimate 0":   {IntOrDash(new(int)), "0"},
		"FloatOrDash renders the amount":     {FloatOrDash(&f), "$12.50"},
		"FloatOrDash on nil":                 {FloatOrDash(nil), SymbolDash},
		"YesNo true":                         {YesNo(true), SymbolDefault},
		"YesNo false":                        {YesNo(false), SymbolDash},
		"GateGlyph on":                       {GateGlyph(true), SymbolSuccess},
		"GateGlyph off":                      {GateGlyph(false), SymbolDash},
		"TruncID leaves a short id alone":    {TruncID("abc"), "abc"},
		"TruncID leaves exactly eight alone": {TruncID("12345678"), "12345678"},
		"TruncID cuts a long id":             {TruncID("1234567890"), "12345678…"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if c.got != c.want {
				t.Errorf("got %q, want %q", c.got, c.want)
			}
		})
	}

	// A zero is a VALUE, not an absence. `IntOrDash(new(int))` above pins that; this pins the
	// float side, where the money format makes it easy to lose.
	zero := 0.0
	if got := FloatOrDash(&zero); got == SymbolDash {
		t.Error("FloatOrDash rendered a real 0 as the dash — zero is an amount, not a missing amount")
	}
}

// The distinction between these two is the reason both exist, and it is easy to erase by
// "simplifying" one into the other: a dash means WE DO NOT KNOW, "never" means we know and it has
// not happened. A token that has never been used is a different statement from a token whose last
// use we failed to read.
func TestStampOrDashAndStampOrNeverSayDifferentThings(t *testing.T) {
	if got := StampOrDash(nil); got != SymbolDash {
		t.Errorf("StampOrDash(nil) = %q, want the dash", got)
	}
	if got := StampOrNever(nil); got != "never" {
		t.Errorf("StampOrNever(nil) = %q, want %q", got, "never")
	}
	if StampOrDash(nil) == StampOrNever(nil) {
		t.Error("the two render identically for an absent value — the distinction they exist for is gone")
	}

	// `9 Mar 2026, 15:04` since #3659 converged StampOrDash onto Stamp. The PROPERTY under test
	// is unchanged and is the point of this test: with a value present the two must AGREE, and
	// they may only differ about absence.
	stamp := "2026-03-09T15:04:05Z"
	const present = "9 Mar 2026, 15:04"
	if got := StampOrDash(&stamp); got != present {
		t.Errorf("StampOrDash = %q, want %q — minute precision in UTC", got, present)
	}
	if got := StampOrNever(&stamp); got != present {
		t.Errorf("StampOrNever = %q — with a value present it must agree with StampOrDash", got)
	}

	// Whitespace-only is absent, not a value.
	blank := "   "
	if got := StampOrDash(&blank); got != SymbolDash {
		t.Errorf("StampOrDash on whitespace = %q, want the dash", got)
	}

	// An unparseable stamp falls through to the raw string on BOTH.
	junk := "not-a-timestamp"
	if got := StampOrDash(&junk); got != junk {
		t.Errorf("StampOrDash on junk = %q, want the raw value so it can be reported", got)
	}
}

// RelativeTime returns the RAW value when it cannot parse, rather than the dash. That is
// deliberate: a timestamp the CLI cannot read is a wire problem, and showing it lets someone report
// what actually arrived. A dash would hide it.
func TestRelativeTimeShowsWhatItCannotParse(t *testing.T) {
	if got := RelativeTime(""); got != SymbolDash {
		t.Errorf("RelativeTime on empty = %q, want the dash", got)
	}
	junk := "2026-13-45T99:99:99Z"
	if got := RelativeTime(junk); got != junk {
		t.Errorf("RelativeTime on an unparseable stamp = %q, want the raw value — hiding it behind a "+
			"dash turns a wire problem into a blank cell", got)
	}
	// Inside the week it is still the humanised age. A LITERAL stamp cannot be used here: the
	// window is measured against now, so a fixed instant drifts out of it and the test would start
	// asserting the other branch a week after it was written.
	recent := time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339)
	if got := RelativeTime(recent); !strings.Contains(got, "ago") {
		t.Errorf("RelativeTime on a stamp inside the week = %q, want a humanised relative string", got)
	}

	// Beyond the week it is the absolute date, because #3659 converged this function onto
	// SmartTime's rule. Pinned as a LITERAL rather than by calling SmartTime, which would only
	// prove the delegation compiles: if both drift together the assertion still passes.
	if got := RelativeTime("2020-03-09T15:04:05Z"); got != "9 Mar 2020" {
		t.Errorf("RelativeTime past the week cutoff = %q, want the absolute date %q", got, "9 Mar 2020")
	}
}

// SmartTime's week cutoff is the whole reason it is not RelativeTime. Asserted here, in the package
// that owns it — the caller's test in cmd/ exercises it but credits cmd's coverage, not this
// package's, so the function would otherwise be measured as untested where it actually lives.
func TestSmartTimeSwitchesAtTheWeek(t *testing.T) {
	if got := SmartTime(time.Time{}); got != SymbolDash {
		t.Errorf("SmartTime(zero) = %q, want the dash", got)
	}

	// Inside the week: relative, so a reader does not convert a date back into "this morning".
	recent := time.Now().Add(-3 * time.Hour)
	if got := SmartTime(recent); !strings.Contains(got, "ago") {
		t.Errorf("SmartTime(3h ago) = %q, want a relative rendering", got)
	}

	// Beyond it: absolute, because nobody converts "5 weeks ago" back to a date in their head.
	old := time.Now().Add(-30 * 24 * time.Hour)
	if got := SmartTime(old); strings.Contains(got, "ago") {
		t.Errorf("SmartTime(30 days ago) = %q, want an absolute date past the week cutoff", got)
	}

	// The absolute rendering is `format.Date(DateOnly)` since #3659 — `9 Mar 2020`, not the
	// `2006-01-02` layout literal this file used to assert. Pinned against a FIXED instant and a
	// LITERAL string: deriving the expectation from `format.Date` would pass just as happily if
	// both sides moved together, which is the whole failure mode a mirror is supposed to catch.
	// A 2020 instant is unambiguously past the cutoff however long this test lives.
	if got := SmartTime(time.Date(2020, 3, 9, 15, 4, 5, 0, time.UTC)); got != "9 Mar 2020" {
		t.Errorf("SmartTime past the cutoff = %q, want %q", got, "9 Mar 2020")
	}

	// The boundary itself, from both sides, because a cutoff asserted only in the middle of each
	// range is a cutoff nobody has actually located.
	justInside := time.Now().Add(-(7*24*time.Hour - time.Hour))
	if got := SmartTime(justInside); !strings.Contains(got, "ago") {
		t.Errorf("an hour inside the week = %q, want relative", got)
	}
	justOutside := time.Now().Add(-(7*24*time.Hour + time.Hour))
	if got := SmartTime(justOutside); strings.Contains(got, "ago") {
		t.Errorf("an hour outside the week = %q, want absolute", got)
	}
}

// TestStamp pins the console's absolute-date rule and the two answers that are NOT a date.
//
// The verbatim arm is the one worth naming: a timestamp the CLI cannot parse is a wire problem, and
// dashing it would hide the evidence. The dash arm is the opposite statement — there was nothing to
// show — and the two must not collapse into each other.
func TestStamp(t *testing.T) {
	for name, tc := range map[string]struct{ in, want string }{
		"an RFC3339 instant":      {"2026-03-09T15:04:05Z", "9 Mar 2026, 15:04"},
		"converted to UTC":        {"2026-03-09T17:04:05+02:00", "9 Mar 2026, 15:04"},
		"the 1st is unpadded":     {"2026-03-01T00:00:00Z", "1 Mar 2026, 00:00"},
		"empty is the dash":       {"", SymbolDash},
		"blank is the dash":       {"   ", SymbolDash},
		"unparseable is verbatim": {"yesterday", "yesterday"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := Stamp(tc.in); got != tc.want {
				t.Errorf("Stamp(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Stamp and StampOrDash are ONE rule since #3659, and differ only in what they say about an ABSENT
// timestamp. This used to assert the opposite — that the two disagreed — and its failure message
// asked whoever converged them to decide deliberately. #3659 is that decision, so the test is
// inverted rather than deleted: the property is still worth pinning, it is just the other one.
//
// The `want` here is a LITERAL, not `Stamp(raw)`. Asserting only that the two agree would pass if
// both regressed to the same wrong layout, which is exactly the shape of the bug this file exists
// to catch.
func TestStampOrDashIsStampPlusTheDash(t *testing.T) {
	raw := "2026-03-09T15:04:05Z"
	const want = "9 Mar 2026, 15:04"

	if got := Stamp(raw); got != want {
		t.Errorf("Stamp(%q) = %q, want %q", raw, got, want)
	}
	if got := StampOrDash(&raw); got != want {
		t.Errorf("StampOrDash(%q) = %q, want %q — the two absolute-stamp rules converged in #3659", raw, got, want)
	}

	// The one place they still differ, and the reason both names survive.
	if got := StampOrDash(nil); got != SymbolDash {
		t.Errorf("StampOrDash(nil) = %q, want the dash", got)
	}
	if got := Stamp(""); got != SymbolDash {
		t.Errorf("Stamp(empty) = %q, want the dash", got)
	}
}

// TestStatusCell pins the cell four command files used to build by hand: the unstyled glyph, one
// space, and the status lower-cased.
//
// Every arm of PlainStatusDot is driven through it, because the point of the hoist is that ONE
// definition decides all of them — a StatusCell that agreed with PlainStatusDot on ACTIVE and not
// on DESTROYED would still have let two tables disagree.
func TestStatusCell(t *testing.T) {
	cases := map[string]string{
		"ACTIVE":       SymbolOnline + " active",
		"ONLINE":       SymbolOnline + " online",
		"PROVISIONING": SymbolPending + " provisioning",
		"DRAINING":     SymbolPending + " draining",
		"QUEUED":       SymbolPending + " queued",
		"CREATING":     SymbolPending + " creating",
		"UPDATING":     SymbolPending + " updating",
		"FAILED":       SymbolError + " failed",
		"DESTROYED":    SymbolDash + " destroyed",
		"OFFLINE":      SymbolOffline + " offline",
		"":             SymbolOffline + " ",
	}
	for status, want := range cases {
		if got := StatusCell(status); got != want {
			t.Errorf("StatusCell(%q) = %q, want %q", status, got, want)
		}
	}

	// The glyph must be the SAME decision PlainStatusDot makes, not a copy of its table. A second
	// switch here would be the duplication this function was hoisted to end, one package over.
	for _, status := range []string{"ACTIVE", "DRAINING", "FAILED", "DESTROYED", "WHATEVER"} {
		if !strings.HasPrefix(StatusCell(status), PlainStatusDot(status)+" ") {
			t.Errorf("StatusCell(%q) does not lead with PlainStatusDot(%q)", status, status)
		}
	}
}
