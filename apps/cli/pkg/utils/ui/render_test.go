// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
)

// ONE spelling of "nothing to show". Before this package there were three — SymbolDash in most
// commands, a hardcoded em dash in token.go, and the literal "N/A" in config_printer.go — so the
// same absence rendered differently depending on which command you ran.
//
// Asserted through the constant AND against the literal rune, because the failure being prevented
// is someone writing the character again somewhere rather than reusing the constant.
func TestDashIsOneSpelling(t *testing.T) {
	if Dash != SymbolDash {
		t.Errorf("Dash = %q but SymbolDash = %q — they must be the same glyph, not two", Dash, SymbolDash)
	}
	if Dash != "—" {
		t.Errorf("Dash = %q, want an em dash U+2014", Dash)
	}
}

func TestOrDashFamily(t *testing.T) {
	s := "value"
	empty := ""
	n := 7
	f := 12.5

	cases := map[string]struct{ got, want string }{
		"OrDash passes a value through":      {OrDash("x"), "x"},
		"OrDash on empty":                    {OrDash(""), Dash},
		"StrOrDash passes a value through":   {StrOrDash(&s), "value"},
		"StrOrDash on nil":                   {StrOrDash(nil), Dash},
		"StrOrDash on a pointer to empty":    {StrOrDash(&empty), Dash},
		"IntOrDash renders the number":       {IntOrDash(&n), "7"},
		"IntOrDash on nil":                   {IntOrDash(nil), Dash},
		"IntOrDash renders a legitimate 0":   {IntOrDash(new(int)), "0"},
		"FloatOrDash renders the amount":     {FloatOrDash(&f), "$12.50"},
		"FloatOrDash on nil":                 {FloatOrDash(nil), Dash},
		"YesNo true":                         {YesNo(true), SymbolDefault},
		"YesNo false":                        {YesNo(false), Dash},
		"GateGlyph on":                       {GateGlyph(true), SymbolSuccess},
		"GateGlyph off":                      {GateGlyph(false), Dash},
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
	if got := FloatOrDash(&zero); got == Dash {
		t.Error("FloatOrDash rendered a real 0 as the dash — zero is an amount, not a missing amount")
	}
}

// The distinction between these two is the reason both exist, and it is easy to erase by
// "simplifying" one into the other: a dash means WE DO NOT KNOW, "never" means we know and it has
// not happened. A token that has never been used is a different statement from a token whose last
// use we failed to read.
func TestStampOrDashAndStampOrNeverSayDifferentThings(t *testing.T) {
	if got := StampOrDash(nil); got != Dash {
		t.Errorf("StampOrDash(nil) = %q, want the dash", got)
	}
	if got := StampOrNever(nil); got != "never" {
		t.Errorf("StampOrNever(nil) = %q, want %q", got, "never")
	}
	if StampOrDash(nil) == StampOrNever(nil) {
		t.Error("the two render identically for an absent value — the distinction they exist for is gone")
	}

	stamp := "2026-03-09T15:04:05Z"
	if got := StampOrDash(&stamp); got != "2026-03-09 15:04" {
		t.Errorf("StampOrDash = %q, want minute precision in UTC", got)
	}
	if got := StampOrNever(&stamp); got != "2026-03-09 15:04" {
		t.Errorf("StampOrNever = %q — with a value present it must agree with StampOrDash", got)
	}

	// Whitespace-only is absent, not a value.
	blank := "   "
	if got := StampOrDash(&blank); got != Dash {
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
	if got := RelativeTime(""); got != Dash {
		t.Errorf("RelativeTime on empty = %q, want the dash", got)
	}
	junk := "2026-13-45T99:99:99Z"
	if got := RelativeTime(junk); got != junk {
		t.Errorf("RelativeTime on an unparseable stamp = %q, want the raw value — hiding it behind a "+
			"dash turns a wire problem into a blank cell", got)
	}
	if got := RelativeTime("2026-03-09T15:04:05Z"); !strings.Contains(got, "ago") && !strings.Contains(got, "from now") {
		t.Errorf("RelativeTime on a valid stamp = %q, want a humanised relative string", got)
	}
}
