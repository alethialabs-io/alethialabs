// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One place that turns a number into a string a person reads.
 *
 * Before this package the console had eleven formatting helpers: four shared, seven local,
 * three functions named `formatDate` with different output in a single directory, two
 * byte-identical `formatBytes`, and `date-fns` imported raw at nineteen call sites. The same
 * quantity therefore rendered differently depending on which page you were on — runner minutes
 * read `0.943 / 200 min` on the org overview, `0 / 200` in settings, and `0.4166666666 / 200`
 * in an agent widget, from one float.
 *
 * Everything here is pure: same input, same output, no clock, no locale guessing, no I/O. That
 * is what makes it testable to the edges, and the edges are where the bugs were.
 */

import { formatDistance } from "date-fns";

/** Locale for every Intl call here. Fixed, so output cannot vary by where the code runs. */
const LOCALE = "en-GB";

/**
 * Human-readable minutes.
 *
 * The rule, in full, because each branch fixes a real defect:
 *   0            -> `0 min`     (nothing has run — NOT `<1 min`, which reads as "a little")
 *   0 < m < 1    -> `<1 min`    (this is the `0.943 / 200 min` bug)
 *   m < 60       -> `3 min`     (whole minutes; a fractional minute is noise, not precision)
 *   m >= 60      -> `2h 15m`, and `1h` exactly when the remainder rounds to zero
 *
 * Rounding happens ONCE, before the hour test, so a value cannot round differently in two
 * branches: 59.4 -> `59 min`, 59.6 -> `1h`. Rounding inside each branch instead would let 59.6
 * print `1h 0m` in one place and `60 min` in another, which is the class of disagreement this
 * package exists to end.
 *
 * @param minutes elapsed or allotted minutes; may be fractional. Negative is clamped to 0.
 */
export function formatMinutes(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
	if (minutes < 1) return "<1 min";

	const whole = Math.round(minutes);
	if (whole < 60) return `${whole} min`;

	const hours = Math.floor(whole / 60);
	const rest = whole % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A consumed-against-allowance readout: `<1 min / 200 min`.
 *
 * This exists because `formatMinutes` alone is not enough to make the four call sites agree, and
 * they immediately did not. Two independent migrations reached two different answers from the same
 * helper — one rendered `<1 min / 200 min`, the other `12 min / 3h 20m` — which is the exact
 * disagreement the package was created to end, reappearing one layer up.
 *
 * The rule, and why:
 *   - The USED side is humanised. It is a measurement, and three decimal places of a minute is
 *     noise (`0.943 / 200 min` was the reported bug).
 *   - The ALLOWANCE side is NOT. `200` is the number the plan and the pricing page quote, so it is
 *     effectively a proper noun; `3h 20m` is arithmetically identical and unrecognisable to the
 *     person checking whether they are near their limit.
 *
 * So: one function, one answer. A caller that wants something else should say why in a comment
 * rather than assembling its own pair — that is how four renderings happened the first time.
 *
 * @param usedMinutes minutes consumed; may be fractional.
 * @param includedMinutes the plan's allowance, in whole minutes.
 */
export function formatQuota(usedMinutes: number, includedMinutes: number): string {
	const included = Number.isFinite(includedMinutes) && includedMinutes > 0 ? Math.round(includedMinutes) : 0;
	return `${formatMinutes(usedMinutes)} / ${included.toLocaleString(LOCALE)} min`;
}

/**
 * An elapsed millisecond span as `42s` or `1m 12s`.
 *
 * Ported verbatim from `apps/console/lib/jobs/format.ts`, which was already the right shape and
 * was duplicated byte-identically inline in the job detail page.
 *
 * @param ms elapsed milliseconds. Negative is clamped to 0.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

/** How much of a timestamp to show. */
export type DateStyle = "date" | "datetime" | "month" | "time";

const DATE_OPTS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
	date: { day: "numeric", month: "short", year: "numeric" },
	datetime: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
	month: { month: "long", year: "numeric" },
	// `time` exists for one shape: a log gutter, where the date is the same on every line and
	// repeating it is noise, but the second matters. `hourCycle: "h23"` rather than
	// `hour12: false`, which is the option that renders midnight as 24:00 in some locales.
	time: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
};

/**
 * An absolute timestamp. Replaces three same-named `formatDate` implementations that disagreed.
 *
 * Returns an em dash for anything unparseable rather than `Invalid Date`, because these render
 * straight into a table cell and a user-visible `Invalid Date` is worse than an obvious blank.
 *
 * TIME ZONE. With no `timeZone` this renders in the runtime's zone, which is what a user wants
 * (a job that ran at 15:00 their time should say 15:00). The trap is React: rendered in a server
 * component it uses the SERVER's zone, and re-rendered on the client it uses the BROWSER's — a
 * hydration mismatch that surfaces as a flicker or a console error, not as a wrong date. Use the
 * `datetime` style in client components, or pass an explicit `timeZone` when it must be stable.
 *
 * @param value an ISO string, epoch millis, or a Date.
 * @param style how much to show; defaults to the date alone.
 * @param timeZone an IANA zone to pin the output to; omit for the runtime's own.
 */
export function formatDate(
	value: string | number | Date | null | undefined,
	style: DateStyle = "date",
	timeZone?: string,
): string {
	const d = toDate(value);
	if (!d) return "—";
	return new Intl.DateTimeFormat(LOCALE, { ...DATE_OPTS[style], ...(timeZone ? { timeZone } : {}) }).format(d);
}

/**
 * A timestamp relative to now — `3 minutes ago`, `about 1 month ago`.
 *
 * Wraps `date-fns`, which nineteen console files import directly today. Reads the clock, so it
 * is the one function here that is not referentially transparent; tests inject the instant.
 *
 * @param value an ISO string, epoch millis, or a Date.
 * @param now the instant to measure against; defaults to the real clock.
 */
export function formatRelative(value: string | number | Date | null | undefined, now?: Date): string {
	const d = toDate(value);
	if (!d) return "—";
	// `formatDistance` takes an explicit baseline; `formatDistanceToNow` does not, which would
	// make this untestable without faking the global clock. `addSuffix` supplies "ago"/"in …".
	return formatDistance(d, now ?? new Date(), { addSuffix: true });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A byte count. Replaces the duplicate pair in `components/support/`.
 *
 * Uses 1024 steps with the short unit names the existing call sites already showed, and keeps
 * one decimal above kilobytes only — `1.4 MB`, but `812 B`, because a fractional byte is a lie.
 *
 * @param bytes a non-negative byte count. Negative is clamped to 0.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * A money amount held in minor units (cents), which is how Stripe and the billing tables store it.
 *
 * Takes minor units on purpose: every bug in this area starts with someone passing 12.5 where
 * 1250 was meant, and a signature that says `cents` makes that visible at the call site.
 *
 * @param cents amount in minor units.
 * @param currency ISO 4217 code; defaults to USD.
 */
export function formatMoney(cents: number, currency = "USD"): string {
	const amount = Number.isFinite(cents) ? cents / 100 : 0;
	// No explicit decimals: a billed amount keeps the currency's own (2 for USD, 0 for JPY).
	return money(amount, currency);
}

/**
 * Which question a monthly figure is answering. The two registers differ ONLY in whether the
 * figure is allowed to round away detail it does not have; they never differ in precision for the
 * same number, which is what lets a line and a total sit in one column.
 */
export type MonthlyRateStyle = "estimate" | "exact";

/**
 * A recurring monthly cost, held in MAJOR units — `$12.50/mo`, `$1,240.37/mo`.
 *
 * The sibling of {@link formatMoney}, and it is a sibling rather than an option on it because the
 * two answer different questions and take different units.
 *
 * UNITS. `formatMoney` takes cents because a billed amount comes from Stripe and the billing
 * tables, where money is stored in minor units. This takes major units because a monthly estimate
 * comes from `projects.estimated_monthly_cost` and the plan's cost result, which are `numeric`
 * columns holding dollars. Passing one to the other is off by 100 either way, so the two names
 * carry the unit — `formatMoney(1250)` and `formatMonthlyRate(12.5)` are the same money.
 *
 * CENTS ARE ALWAYS SHOWN. The first cut of this function dropped them above $100, on the argument
 * that they are fake precision on an estimate. That argument is true of a lone headline and false
 * everywhere else in this console, because this quantity almost never appears alone: review found
 * three breakdown-and-total pairs whose own lines stopped adding up (`$60.25` + `$45.10` under a
 * total of `$105`, from a real `totalMonthlyCost` of 105.35) and two canvas cards side by side
 * reading `$99.99/mo` and `$100/mo` for the same field. A threshold that changes precision inside
 * one column is the disagreement this package exists to end, so there is no threshold.
 *
 * THE TWO REGISTERS are about ADMISSION, not precision:
 *
 *   "estimate" — a lone headline whose parts are not on screen (a project card, a plan's
 *                "Est." summary). It may admit it does not know:
 *                  <= 0       -> `$0/mo`      nothing is running — NOT `$0.00/mo`, which reads
 *                                             like a bill
 *                  0 < x < 1  -> `<$1/mo`     the same admission `formatMinutes` makes for
 *                                             `<1 min`; `$0.02/mo` for a whole project reads as
 *                                             a broken number, not a cheap one
 *                  otherwise  -> `$12.50/mo`, `$1,240.37/mo`
 *
 *   "exact"    — a line in a breakdown, the total of one, or a card in a set that sums to a
 *                total on the same screen. It may NOT round anything away, because the reader is
 *                adding the column up: a $0.50 hosted zone and a $0.03 bucket must not both read
 *                `<$1/mo`, and a genuine zero must read `$0.00/mo` so the column aligns.
 *                  <= 0       -> `$0.00/mo`
 *                  otherwise  -> `$0.03/mo`, `$126.40/mo`
 *
 * Rounding to cents happens ONCE, before the `<1` test, so a figure cannot be rounded differently
 * by two branches: 0.999 reads `$1.00/mo`, never `<$1/mo` beside a `$1.00/mo`. The `<= 0` test is
 * the exception and runs FIRST, on the raw value — 0.001 is a real cost that must not round into
 * "nothing is running".
 *
 * NO `~`. Three call sites prefixed one and thirteen did not, which is the disagreement, not the
 * fix — the same field cannot be approximate on one screen and exact on the next. A page that
 * wants to say "estimated" says it in words beside the number, where it is readable.
 *
 * @param amount a recurring monthly cost in major units (dollars, euros). Negative is clamped to 0.
 * @param style which register — see above. Defaults to the headline `"estimate"`.
 * @param currency ISO 4217 code; defaults to USD.
 */
export function formatMonthlyRate(amount: number, style: MonthlyRateStyle = "estimate", currency = "USD"): string {
	const suffix = "/mo";
	// `undefined` decimals keeps the currency's own (2 for USD, 0 for JPY) — the same choice
	// `formatMoney` makes, so a breakdown line and a billed amount cannot disagree about JPY.
	if (!Number.isFinite(amount) || amount <= 0) {
		return `${money(0, currency, style === "exact" ? undefined : 0)}${suffix}`;
	}
	const rounded = Math.round(amount * 100) / 100;
	if (style === "estimate" && rounded < 1) return `<${money(1, currency, 0)}${suffix}`;
	return `${money(rounded, currency)}${suffix}`;
}

/**
 * The one Intl currency call both money functions go through, so `formatMoney` and
 * `formatMonthlyRate` cannot disagree about the symbol.
 *
 * `currencyDisplay: "narrowSymbol"` is load-bearing: en-GB renders USD as "US$12.50" by default,
 * which is wrong for a product that bills in dollars. narrowSymbol gives "$12.50", "€12.50",
 * "£12.50". Verified against Intl before relying on it.
 *
 * @param decimals fixed fraction digits; omit to keep the currency's own.
 */
function money(amount: number, currency: string, decimals?: number): string {
	const digits = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
	return new Intl.NumberFormat(LOCALE, {
		style: "currency",
		currency,
		currencyDisplay: "narrowSymbol",
		...digits,
	}).format(amount);
}

/** Coerce the accepted input shapes to a valid Date, or null when it cannot be read. */
function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}
