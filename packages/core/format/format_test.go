// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rules the conformance table CANNOT state, and which are therefore untested by it.
//
// The table is the contract between the two languages, so it can only carry behaviour both sides
// have. Three things here are outside that:
//
//   - The ISO-code fallback for a currency with no symbol. TypeScript delegates to Intl, which
//     knows every currency; Go carries a deliberate four-entry table and falls back. That is a
//     RULING, not a mirror, and a ruling with no test is a comment.
//   - `Dash`, and the shapes that return it. The table's date section reaches the em dash through a
//     null date; nothing exercises the sentinel as a value other callers will use.
//   - Go-only input shapes: a zero time.Time, a negative time.Duration, an unknown DateStyle.
//
// Everything the table DOES state is asserted in conformance_test.go and must not be duplicated
// here — a second hand-written copy of a generated expectation is exactly the third source of truth
// the table exists to prevent.

package format

import (
	"testing"
	"time"
)

// The maintainer's ruling: render the ISO code, never error, never guess a symbol.
//
// The alternative considered and rejected was `(string, error)`. At a table cell the only answers to
// an error are a dash or ignoring it, and a dash loses the number — which is a worse outcome than an
// unfamiliar but correct `12.50 HUF`.
func TestMoneyFallsBackToTheISOCodeAndNeverGuessesASymbol(t *testing.T) {
	cases := map[string]struct {
		cents    float64
		currency string
		want     string
	}{
		"a currency with no symbol in the table": {1250, "HUF", "12.50 HUF"},
		"lowercase is still recognised":          {1250, "huf", "12.50 HUF"},
		"a known symbol still wins":              {1250, "USD", "$12.50"},
		"lowercase known symbol":                 {1250, "usd", "$12.50"},
		"the sign leads the code too":            {-1250, "HUF", "-12.50 HUF"},
		"grouping survives the fallback":         {124037000, "HUF", "1,240,370.00 HUF"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := Money(c.cents, c.currency); got != c.want {
				t.Errorf("Money(%v, %q) = %q, want %q", c.cents, c.currency, got, c.want)
			}
		})
	}

	// The property behind the ruling, stated as a property rather than a table: an unknown currency
	// must never borrow another currency's glyph.
	for _, unknown := range []string{"HUF", "ISK", "UGX", "TWD", "SEK", "ZZZ", ""} {
		got := Money(1250, unknown)
		for symbol := range currencySymbol {
			if len(got) > 0 && got[0:1] == currencySymbol[symbol] {
				t.Errorf("Money(1250, %q) = %q — it borrowed the %s symbol; a guessed symbol on a billed amount is the failure this rule exists to prevent", unknown, got, symbol)
			}
		}
	}
}

// MonthlyRate's estimate register has to keep the ISO fallback too, including in the `<1` branch
// where the string is assembled differently.
func TestMonthlyRateKeepsTheFallbackInEveryBranch(t *testing.T) {
	cases := map[string]struct {
		amount   float64
		style    RateStyle
		currency string
		want     string
	}{
		"estimate, no symbol":               {12.5, Estimate, "HUF", "12.50 HUF/mo"},
		"exact, no symbol":                  {12.5, Exact, "HUF", "12.50 HUF/mo"},
		"the sub-unit branch, no symbol":    {0.02, Estimate, "HUF", "<1 HUF/mo"},
		"the zero branch, no symbol":        {0, Estimate, "HUF", "0 HUF/mo"},
		"the zero branch, exact, no symbol": {0, Exact, "HUF", "0.00 HUF/mo"},
		"a negative clamps, no symbol":      {-3, Estimate, "HUF", "0 HUF/mo"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := MonthlyRate(c.amount, c.style, c.currency); got != c.want {
				t.Errorf("MonthlyRate(%v, %q, %q) = %q, want %q", c.amount, c.style, c.currency, got, c.want)
			}
		})
	}

	// A style nobody defined must not silently render as an estimate. Exact is the safe default:
	// showing minor units where an estimate was wanted is cosmetic, while showing a rounded whole
	// number where an exact figure was wanted misstates money.
	if got := MonthlyRate(12.5, RateStyle("wat"), "USD"); got != "$12.50/mo" {
		t.Errorf("an unknown RateStyle rendered %q; it must not lose the minor units", got)
	}
	// ...and at ZERO too. This is where the first cut disagreed with itself: the zero branch tested
	// `== Exact` while the rest tested `== Estimate`, so an unknown style rendered `$12.50/mo` above
	// zero and `$0/mo` at zero — two registers from one call site, in a column of costs.
	if got := MonthlyRate(0, RateStyle("wat"), "USD"); got != "$0.00/mo" {
		t.Errorf("an unknown RateStyle at zero rendered %q, want %q — it must pick the same register as it does above zero", got, "$0.00/mo")
	}
}

// Go-only input shapes. The table cannot express a zero time.Time or a negative Duration, because
// TypeScript has neither.
func TestGoOnlyInputShapes(t *testing.T) {
	t.Run("a zero time is the sentinel, not year 1", func(t *testing.T) {
		if got := Date(time.Time{}, DateOnly, time.UTC); got != Dash {
			t.Errorf("Date(zero) = %q, want %q — `1 Jan 0001` in a table cell is worse than a blank", got, Dash)
		}
	})

	t.Run("an unknown style is the sentinel, never a wrong shape", func(t *testing.T) {
		real := time.Date(2026, 3, 9, 15, 4, 5, 0, time.UTC)
		if got := Date(real, DateStyle("fortnight"), time.UTC); got != Dash {
			t.Errorf("Date(_, unknown style) = %q, want %q — a caller that invents a style gets a blank, never a silently wrong shape", got, Dash)
		}
	})

	t.Run("a nil location is UTC, not the process default", func(t *testing.T) {
		real := time.Date(2026, 3, 9, 23, 30, 0, 0, time.UTC)
		if got := Date(real, DateOnly, nil); got != "9 Mar 2026" {
			t.Errorf("Date(_, _, nil) = %q, want %q — a nil zone must be deterministic, not ambient", got, "9 Mar 2026")
		}
	})

	t.Run("a negative duration is zero, not a negative string", func(t *testing.T) {
		if got := Duration(-5 * time.Second); got != "0s" {
			t.Errorf("Duration(-5s) = %q, want %q", got, "0s")
		}
	})

	t.Run("sub-second floors rather than rounding up", func(t *testing.T) {
		if got := Duration(999 * time.Millisecond); got != "0s" {
			t.Errorf("Duration(999ms) = %q, want %q — an elapsed span that has not reached a second has not reached a second", got, "0s")
		}
	})
}

// Dash is a published constant other packages will compare against, so its VALUE is part of the
// contract, not an implementation detail. A change here silently breaks every caller testing for it.
func TestDashIsTheEmDash(t *testing.T) {
	if Dash != "—" {
		t.Errorf("Dash = %q (%U), want an em dash U+2014 — the CLI had three spellings of this and the point was to end that", Dash, []rune(Dash)[0])
	}
}
