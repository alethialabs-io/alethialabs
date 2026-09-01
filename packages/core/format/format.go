// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package format renders human-facing values — money, durations, minutes, dates, byte counts — for
// the CLI and the runner, so the terminal and the console cannot disagree about the same number.
//
// It is the Go half of `@repo/format`. Neither side is a port of the other: what must agree is the
// OUTPUT, and that agreement is stated as a committed conformance table
// (`packages/format/conformance/format-cases.json`) which TypeScript generates and both sides are
// tested against. Go cannot write that file, so Go has no way to make itself right — which is the
// property that makes the mirror mean anything. See conformance_test.go.
//
// The divergence this closes was live and about money: `fmt.Sprintf("%.0f", 12.5)` renders `12`,
// because Go's %f rounds half to EVEN, while JavaScript rounds half away from zero and the billing
// page shows `$12.50`. Five CLI call sites did exactly that.
//
// Everything here is pure: same input, same output, no clock, no locale guessing, no I/O. The
// locale is fixed at en-GB — day-first dates, `,` grouping, `.` decimal — so output cannot vary by
// where the code runs.
package format

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	// The conformance table pins IANA zones (`Asia/Tokyo`), and time.LoadLocation reads the host's
	// zoneinfo — which minimal containers do not ship, and a container is where the runner runs.
	// Embedding the database costs ~450 KB of binary and buys a formatter that does not silently
	// return the wrong DAY in production while passing on a laptop.
	_ "time/tzdata"
)

// Dash is the empty-value sentinel: an em dash, the same glyph `@repo/format` returns for a date it
// cannot parse.
//
// It lives here rather than in the CLI's ui package because `packages/core` cannot import
// `apps/cli`, and because the CLI had THREE spellings of "nothing to show" — `ui.SymbolDash`, a
// hardcoded literal, and the string "N/A" — across four helper families. One rule, one glyph.
const Dash = "—"

// ── money ──────────────────────────────────────────────────────────────────────────────────────

// RateStyle selects how a recurring cost is written.
type RateStyle string

const (
	// Estimate is a projection: whole currency units, and an honest `<$1/mo` rather than a
	// rounded-to-zero number that reads as free.
	Estimate RateStyle = "estimate"
	// Exact is a billed or itemised figure: always minor units, because a column of costs that
	// sometimes shows cents and sometimes does not is unreadable as a column.
	Exact RateStyle = "exact"
)

// currencySymbol is the narrow symbol for the currencies Alethia actually bills in.
//
// A currency that is NOT here renders its ISO code instead — `12.50 HUF` — and never guesses. That
// is the whole rule: a guessed symbol on a billed amount is the worst failure available, and an
// error return is worse still, because at a table cell the only answers to an error are a dash or
// ignoring it, and a dash loses the number entirely.
var currencySymbol = map[string]string{
	"USD": "$",
	"EUR": "€",
	"GBP": "£",
	"JPY": "¥",
}

// currencyDecimals is the number of minor-unit digits to DISPLAY.
//
// Display only. This is not the divisor Money uses — see the KNOWN LIMITATION on Money, which is
// precisely about those two questions having different authorities.
var currencyDecimals = map[string]int{
	"JPY": 0,
}

// decimalsFor reports how many fraction digits a currency displays. Unknown currencies get two,
// which is right for the overwhelming majority and wrong in the same direction as the rest of the
// world's software.
func decimalsFor(currency string) int {
	if d, ok := currencyDecimals[strings.ToUpper(currency)]; ok {
		return d
	}
	return 2
}

// render writes an amount in a currency at a fixed number of decimals, with `,` grouping.
//
// The sign leads the symbol (`-$5.00`), matching Intl's `narrowSymbol` output — `$-5.00` is not a
// form anyone writes.
func render(amount float64, currency string, decimals int) string {
	symbol, known := currencySymbol[strings.ToUpper(currency)]
	sign := ""
	if amount < 0 {
		sign = "-"
		amount = -amount
	}
	digits := group(strconv.FormatFloat(roundHalfAwayFromZero(amount, decimals), 'f', decimals, 64))
	if known {
		return sign + symbol + digits
	}
	// No symbol: the ISO code, suffixed. The number survives; nothing is invented.
	return sign + digits + " " + strings.ToUpper(currency)
}

// roundHalfAwayFromZero rounds to `decimals` places the way JavaScript does.
//
// This function is the reason the package exists. `strconv.FormatFloat(12.5, 'f', 0, 64)` gives
// "12" — Go rounds half to EVEN — while JavaScript gives "13". math.Round is half-away-from-zero,
// so scaling through it reproduces the JS answer exactly.
func roundHalfAwayFromZero(x float64, decimals int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	p := math.Pow(10, float64(decimals))
	return math.Round(x*p) / p
}

// group inserts `,` every three digits of the integer part. The fraction is left alone.
func group(s string) string {
	intPart, frac, hasFrac := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if hasFrac {
		return b.String() + "." + frac
	}
	return b.String()
}

// Money renders an amount given in MINOR units (cents) — `1250, "USD"` is `$12.50`.
//
// KNOWN LIMITATION — the `/ 100` is correct only for two-decimal currencies, which is every
// currency Alethia bills in today (USD, EUR, GBP). It is wrong for JPY and the rest of Stripe's
// zero-decimal list, where the minor unit IS the unit, so a ¥124,000 invoice renders `¥1,240`.
//
// Do NOT "fix" this by reading the exponent from CLDR. That was tried on the TypeScript side and it
// INVERTS the defect, because CLDR is the DISPLAY table and the divisor's authority is the PAYMENT
// PROCESSOR, and the two legitimately disagree. Stripe's own currency documentation, verbatim:
//
//	ISK — "transitioned to a zero-decimal currency, but backward compatibility requires you to
//	       represent it as a two-decimal value … to charge 5 ISK, provide an amount value of 500"
//	UGX — same wording
//	HUF — "zero-decimal … for payouts, even though you can charge two-decimal amounts"
//
// CLDR calls all three zero-decimal, so taking the divisor from it renders an HUF, ISK or UGX
// invoice 100x OVERSTATED — the same defect as JPY's, pointing the other way. The real fix needs an
// explicit table of Stripe's CHARGE-context minor units, separate from the display data. Tracked as
// #3581; the conformance table deliberately covers two-decimal currencies only, so neither error can
// be frozen as the contract this function must reproduce.
//
// There is no Go caller today. It is mirrored anyway so the contract is STATED for the day one is
// written, rather than rediscovered — the same argument the TypeScript side makes for Bytes.
func Money(cents float64, currency string) string {
	return render(cents/100, currency, decimalsFor(currency))
}

// MonthlyRate renders a recurring cost given in MAJOR units, with a `/mo` suffix.
//
// This is the function every real Go call site wants: nothing in `apps/cli` or `packages/core` holds
// money in cents, so Money's signature has no consumer while this one has nine.
//
// Estimate rounds to minor units ONCE and then asks whether the result is under one unit, so
// `0.999` reads `$1.00/mo` rather than `<$1/mo` — it rounds up to a whole unit and saying "less
// than" of a value that is not less than would be a lie. `0` is `$0/mo`, without decimals, because
// zero is not an approximation of anything.
func MonthlyRate(amount float64, style RateStyle, currency string) string {
	decimals := decimalsFor(currency)
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount <= 0 {
		// `!= Estimate` rather than `== Exact`, so a style nobody defined lands on Exact in BOTH
		// branches. The asymmetric spelling had an unknown style rendering minor units above zero
		// and dropping them at zero — the same caller getting two registers from one call site.
		if style != Estimate {
			return render(0, currency, decimals) + "/mo"
		}
		return render(0, currency, 0) + "/mo"
	}
	rounded := roundHalfAwayFromZero(amount, decimals)
	if style == Estimate && rounded < 1 {
		// Sub-unit and non-zero. Rounding it to `$0.00/mo` would read as free.
		return "<" + render(1, currency, 0) + "/mo"
	}
	return render(rounded, currency, decimals) + "/mo"
}

// ── time ───────────────────────────────────────────────────────────────────────────────────────

// Minutes renders a count of minutes for a person: `0 min`, `<1 min`, `47 min`, `2h 15m`, `1h`.
//
// Rounding happens ONCE, before the hour test, which is why `59.5` is `1h` and not `60 min`. The
// `<1 min` case exists because `0.943 minutes` is a number the code happens to hold, not an answer
// to "how much have I used".
func Minutes(m float64) string {
	if math.IsNaN(m) || math.IsInf(m, 0) || m <= 0 {
		return "0 min"
	}
	if m < 1 {
		return "<1 min"
	}
	total := int(math.Round(m))
	if total < 60 {
		return strconv.Itoa(total) + " min"
	}
	hours, mins := total/60, total%60
	if mins == 0 {
		return strconv.Itoa(hours) + "h"
	}
	return fmt.Sprintf("%dh %dm", hours, mins)
}

// Quota renders usage against an allowance: `<1 min / 200 min`.
//
// The used side is humanised through Minutes; the allowance never is, because an allowance is a
// plan term and `2h` is not how a plan states one. Usage above the allowance is NOT clamped — the
// overage is the thing the reader needs to see.
func Quota(used, included float64) string {
	allowance := 0.0
	if !math.IsNaN(included) && !math.IsInf(included, 0) && included > 0 {
		allowance = math.Round(included)
	}
	return Minutes(used) + " / " + group(strconv.FormatFloat(allowance, 'f', 0, 64)) + " min"
}

// Duration renders an elapsed span: `47s`, `3m 20s`, `2h 5m`.
//
// It ROLLS INTO HOURS at sixty minutes and drops the seconds when it does. The console rendered a
// two-hour provision as `120m 0s` and made the reader divide; a provision over an hour is ordinary
// rather than an edge case, so the shape that read worst was the one covering the common path. At
// an hour the seconds stop being information: nobody asking "how long did this take" is served by
// `2h 5m 03s` over `2h 5m 41s`.
func Duration(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	seconds := int(d / time.Second)
	if seconds < 60 {
		return strconv.Itoa(seconds) + "s"
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm %ds", minutes, seconds%60)
	}
	return fmt.Sprintf("%dh %dm", minutes/60, minutes%60)
}

// DateStyle selects how much of a timestamp to show.
type DateStyle string

const (
	// DateOnly — `9 Mar 2026`.
	DateOnly DateStyle = "date"
	// DateTime — `9 Mar 2026, 15:04`.
	DateTime DateStyle = "datetime"
	// Month — `March 2026`.
	Month DateStyle = "month"
	// TimeOnly — `15:04:05`, a log gutter where the date repeats on every line but the second matters.
	TimeOnly DateStyle = "time"
)

// dateLayouts are Go's spelling of the en-GB shapes Intl produces. Day-first and unpadded, so the
// 1st of a month is `1 Mar 2026` and not `01 Mar 2026`.
var dateLayouts = map[DateStyle]string{
	DateOnly: "2 Jan 2006",
	DateTime: "2 Jan 2006, 15:04",
	Month:    "January 2006",
	TimeOnly: "15:04:05",
}

// Date renders an absolute timestamp in the given zone.
//
// A zero time returns Dash rather than `1 Jan 0001` — these render straight into a table cell, and a
// user-visible garbage date is worse than an obvious blank. An unknown DateStyle also returns Dash:
// a caller that invents a style gets a blank, never a silently wrong shape.
//
// The zone is a PARAMETER and not the process default on purpose. The same reasoning as the
// TypeScript side's hydration trap: a timestamp rendered against an ambient zone is a value that
// changes depending on which machine printed it.
func Date(t time.Time, style DateStyle, loc *time.Location) string {
	layout, ok := dateLayouts[style]
	if !ok || t.IsZero() {
		return Dash
	}
	if loc == nil {
		loc = time.UTC
	}
	return t.In(loc).Format(layout)
}

// ── size ───────────────────────────────────────────────────────────────────────────────────────

// byteUnits steps by 1024. PB is terminal: beyond it the number keeps growing rather than stepping,
// so 1024 PB renders as `1024 PB` and not as an exabyte nobody has.
var byteUnits = []string{"B", "KB", "MB", "GB", "TB", "PB"}

// Bytes renders a byte count: `812 B`, `1.5 KB`, `1.4 MB`.
//
// Whole bytes carry no decimal, because a fraction of a byte is not a thing. Above that, one
// decimal, with a trailing `.0` dropped so an exact kilobyte reads `1 KB`.
//
// There is no Go caller today — nothing in `apps/cli`, `apps/runner` or `packages/core` renders a
// byte count. It is mirrored so the contract is stated for the first one written, rather than
// rediscovered as a fourth spelling.
func Bytes(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return "0 B"
	}
	i := 0
	for n >= 1024 && i < len(byteUnits)-1 {
		n /= 1024
		i++
	}
	if i == 0 {
		return strconv.FormatFloat(math.Floor(n), 'f', 0, 64) + " B"
	}
	v := roundHalfAwayFromZero(n, 1)
	if v == math.Trunc(v) {
		return strconv.FormatFloat(v, 'f', 0, 64) + " " + byteUnits[i]
	}
	return strconv.FormatFloat(v, 'f', 1, 64) + " " + byteUnits[i]
}
