// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The conformance INPUTS — hand-authored, and the only hand-authored half.
 *
 * `format-cases.json` pairs each of these with the output the real `@repo/format`
 * implementation produces. That split is deliberate and load-bearing:
 *
 *   - a human curates the INPUTS, because choosing them is the design work;
 *   - the generator produces the OUTPUTS, because a hand-written expectation is a third
 *     source of truth that goes stale silently.
 *
 * So regenerating can only ever move an expectation, never invent a case — and because every
 * id is semantic rather than an array index, the diff says WHICH BOUNDARY MOVED.
 *
 * ── Why these inputs and not others ──────────────────────────────────────────────────────
 *
 * The wrong axis to vary is the function: `{fn, input, want}` across eight functions looks
 * thorough and proves nothing. The axis that matters is the BRANCH BOUNDARY inside each
 * function, because that is exactly where two languages diverge.
 *
 * The single highest-value row in this file is `monthlyRate/estimate/HALF-CENT-...`. JS rounds
 * half away from zero, so `12.5` renders `$12.50`. Go's `fmt.Sprintf("%.0f", 12.5)` rounds
 * half to EVEN and renders `12` — which is what `cmd/clusters_list.go:94` does today, against
 * a billing page showing `$12.50`. A table built by varying inputs casually contains no `.5`
 * case and never finds it.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────────
 *
 * Every date case pins an explicit IANA `timeZone`. Without one, `Intl.DateTimeFormat` uses
 * the runtime's zone and the generated file would differ per machine — which would turn the
 * CI diff-gate into a permanent false failure and get it deleted.
 */

/** A case for a function taking a single number. */
export interface NumberCase {
	id: string;
	in: number | null;
}

/** A case for `formatQuota(usedMinutes, includedMinutes)`. */
export interface QuotaCase {
	id: string;
	used: number;
	included: number;
}

/** A case for `formatDate(value, style, timeZone)`. */
export interface DateCase {
	id: string;
	value: string | null;
	style: "date" | "datetime" | "month" | "time";
	timeZone: string;
}

/** A case for `formatMoney(cents, currency)`. */
export interface MoneyCase {
	id: string;
	cents: number;
	currency: string;
}

/** A case for `formatMonthlyRate(amount, style, currency)`. */
export interface MonthlyRateCase {
	id: string;
	amount: number;
	style: "estimate" | "exact";
	currency: string;
}

/**
 * `formatMinutes` — rounds ONCE, before the hour test, so a value cannot round differently in
 * two branches. The pair either side of 59.5 is what pins that.
 */
export const MINUTES: NumberCase[] = [
	{ id: "minutes/zero-is-not-an-approximation", in: 0 },
	{ id: "minutes/negative-clamps-to-zero", in: -5 },
	{ id: "minutes/nonfinite-clamps-to-zero", in: null },
	{ id: "minutes/barely-above-zero-still-admits-it", in: 0.001 },
	{ id: "minutes/the-0.943-bug", in: 0.943 },
	{ id: "minutes/just-under-one", in: 0.999 },
	{ id: "minutes/exactly-one", in: 1 },
	{ id: "minutes/whole-minutes-below-the-hour", in: 30 },
	{ id: "minutes/rounds-DOWN-below-the-hour", in: 59.4 },
	{ id: "minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY", in: 59.5 },
	{ id: "minutes/rounds-UP-across-the-hour", in: 59.6 },
	{ id: "minutes/exactly-one-hour-drops-the-minutes", in: 60 },
	{ id: "minutes/whole-hours-drop-the-minutes", in: 120 },
	{ id: "minutes/hour-and-remainder", in: 135 },
	{ id: "minutes/ninety", in: 90 },
];

/**
 * `formatQuota` — the USED side is humanised, the ALLOWANCE side is NOT, because `200` is the
 * number the pricing page quotes and `3h 20m` is unrecognisable to someone checking their
 * limit. The 1200 case pins thousands grouping, which a Go port gets wrong by default.
 */
export const QUOTA: QuotaCase[] = [
	{ id: "quota/the-reported-bug-0.943-of-200", used: 0.943, included: 200 },
	{ id: "quota/nothing-used", used: 0, included: 200 },
	{ id: "quota/ALLOWANCE-KEEPS-THOUSANDS-SEPARATOR", used: 0.943, included: 1200 },
	{ id: "quota/allowance-is-rounded-to-whole-minutes", used: 5, included: 199.6 },
	{ id: "quota/zero-allowance", used: 5, included: 0 },
	{ id: "quota/negative-allowance-clamps", used: 5, included: -10 },
	{ id: "quota/used-exceeds-allowance-is-not-clamped", used: 250, included: 200 },
];

/**
 * `formatDuration` — milliseconds. NOTE it never rolls into hours: 7_200_000ms is `120m 0s`,
 * not `2h`. That is the contract, and `cmd/jobs_list.go` currently disagrees with it. If we
 * ever decide it SHOULD roll to hours, that is a change to the TS with a visible one-line
 * diff in the generated file.
 */
export const DURATION: NumberCase[] = [
	{ id: "duration/zero", in: 0 },
	{ id: "duration/negative-clamps", in: -1000 },
	{ id: "duration/nonfinite-clamps", in: null },
	{ id: "duration/sub-second-floors-to-zero", in: 999 },
	{ id: "duration/one-second", in: 1000 },
	{ id: "duration/JUST-UNDER-A-MINUTE", in: 59999 },
	{ id: "duration/EXACTLY-A-MINUTE", in: 60000 },
	{ id: "duration/minute-and-seconds", in: 72000 },
	{ id: "duration/TWO-HOURS-DOES-NOT-ROLL-INTO-HOURS", in: 7200000 },
];

/**
 * `formatDate` — every case pins a zone; see the determinism note above. The midnight case is
 * why `DATE_OPTS.time` uses `hourCycle: "h23"` rather than `hour12: false`, which renders
 * midnight as 24:00 in some locales.
 */
export const DATE: DateCase[] = [
	{ id: "date/null-is-an-em-dash", value: null, style: "date", timeZone: "UTC" },
	{ id: "date/unparseable-is-an-em-dash", value: "not-a-date", style: "date", timeZone: "UTC" },
	{ id: "date/plain", value: "2026-03-09T15:04:05.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/datetime", value: "2026-03-09T15:04:05.000Z", style: "datetime", timeZone: "UTC" },
	{ id: "date/month", value: "2026-03-09T15:04:05.000Z", style: "month", timeZone: "UTC" },
	{ id: "date/time", value: "2026-03-09T15:04:05.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/MIDNIGHT-IS-00-NOT-24", value: "2026-03-09T00:00:00.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/noon", value: "2026-03-09T12:00:00.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/zone-shifts-the-day", value: "2026-03-09T23:30:00.000Z", style: "datetime", timeZone: "Asia/Tokyo" },
	{ id: "date/month-boundary", value: "2026-01-31T23:59:59.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/leap-day", value: "2028-02-29T12:00:00.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/single-digit-day-is-not-padded", value: "2026-03-01T12:00:00.000Z", style: "date", timeZone: "UTC" },
];

/**
 * `formatBytes` — 1024 steps, one decimal above kilobytes only.
 *
 * There is no Go counterpart and deliberately so: as of this commit `apps/cli`, `apps/runner`
 * and `packages/core` render zero byte counts. These cases exist so the contract is STATED
 * for the day one is written, rather than rediscovered.
 */
export const BYTES: NumberCase[] = [
	{ id: "bytes/zero", in: 0 },
	{ id: "bytes/negative-clamps", in: -1 },
	{ id: "bytes/nonfinite-clamps", in: null },
	{ id: "bytes/BYTES-HAVE-NO-DECIMAL", in: 812 },
	{ id: "bytes/just-under-a-kilobyte", in: 1023 },
	{ id: "bytes/EXACTLY-A-KILOBYTE-STEPS-UP", in: 1024 },
	{ id: "bytes/kilobytes-keep-one-decimal", in: 1536 },
	{ id: "bytes/a-megabyte", in: 1048576 },
	{ id: "bytes/rounds-to-one-decimal", in: 1468006 },
	// 1024**6 rather than a decimal literal: it is 2^60, so it is exactly representable as a
	// double, and the equivalent literal both loses precision and is easy to fat-finger.
	{ id: "bytes/petabytes-are-the-last-unit", in: 1024 ** 6 },
];

/** `formatMoney` — MINOR units (cents), which is how Stripe and the billing tables store it. */
export const MONEY: MoneyCase[] = [
	{ id: "money/zero", cents: 0, currency: "USD" },
	{ id: "money/negative", cents: -500, currency: "USD" },
	{ id: "money/whole-dollars-still-show-cents", cents: 1200, currency: "USD" },
	{ id: "money/cents", cents: 1250, currency: "USD" },
	{ id: "money/THOUSANDS-SEPARATOR", cents: 124037, currency: "USD" },
	{ id: "money/JPY-HAS-NO-MINOR-UNIT", cents: 124000, currency: "JPY" },
	{ id: "money/EUR-NARROW-SYMBOL-NOT-EUR-PREFIX", cents: 1250, currency: "EUR" },
	{ id: "money/GBP-narrow-symbol", cents: 1250, currency: "GBP" },
];

/**
 * `formatMonthlyRate` — MAJOR units. The two registers differ only in whether the figure may
 * admit it does not know; they never differ in PRECISION for the same number, which is what
 * lets a breakdown line and its total sit in one column.
 *
 * Rounding to cents happens ONCE, before the `<1` test, so 0.999 reads `$1.00/mo` and never
 * `<$1/mo` beside a `$1.00/mo`. The `<= 0` test runs FIRST on the raw value, because 0.001 is
 * a real cost that must not round into "nothing is running".
 */
export const MONTHLY_RATE: MonthlyRateCase[] = [
	{ id: "monthlyRate/estimate/zero-is-not-a-bill", amount: 0, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/zero-is-a-column-entry", amount: 0, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/negative-clamps", amount: -3, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/negative-clamps", amount: -3, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/sub-dollar-ADMITS-IT", amount: 0.02, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/sub-dollar-DOES-NOT", amount: 0.02, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/a-tenth-of-a-cent-is-still-running", amount: 0.001, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/a-tenth-of-a-cent-rounds-to-zero-cents", amount: 0.001, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/0.999-ROUNDS-TO-A-DOLLAR-NOT-TO-LESS-THAN-ONE", amount: 0.999, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO", amount: 12.5, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/HALF-CENT-ROUNDS-AWAY-FROM-ZERO", amount: 12.5, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/half-cent-at-an-odd-dollar", amount: 13.5, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/estimate/thousands-separator", amount: 1240.37, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/a-breakdown-line", amount: 60.25, style: "exact", currency: "USD" },
	{ id: "monthlyRate/exact/its-sibling-line", amount: 45.1, style: "exact", currency: "USD" },
	{ id: "monthlyRate/exact/and-their-total", amount: 105.35, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/JPY-HAS-NO-MINOR-UNIT", amount: 1240, style: "estimate", currency: "JPY" },
	{ id: "monthlyRate/estimate/EUR-NARROW-SYMBOL", amount: 12.5, style: "estimate", currency: "EUR" },
];

/**
 * Functions deliberately NOT in the table, with the reason. An absence with a stated reason is
 * reviewable; a silent gap is not, and the generator asserts this list plus the table covers
 * every export of the package.
 */
export const EXCLUDED: Record<string, string> = {
	formatRelative:
		"Mirroring this in Go means reimplementing date-fns's formatDistance ladder ('less than a " +
		"minute ago', 'about 1 hour ago', 'almost 2 years ago') and pinning to a date-fns MAJOR. " +
		"A user seeing $12/mo in the CLI and $12.50/mo on the billing page concludes the product is " +
		"lying about money; a user seeing '1 hour ago' and 'about 1 hour ago' will not hold both at " +
		"once. The CLI keeps go-humanize. Revisit if relative time ever appears in a receipt or an " +
		"invoice, where the two surfaces are read side by side.",
};
