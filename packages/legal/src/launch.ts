// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether paid plans, and the card-less Pro trial, are open, announced or closed — for the product
// as a whole and for each country × capacity cell (#6774, REL-S2).
//
// This module DESCRIBES the gate; it does not move it. `PAID_MARKETS` in commerce.ts stays the only
// thing that opens a cell and `paidMarketEnabled` stays the reader the purchase gate calls. Nothing
// here can open a sale: a cell reads `open` exactly when it is in the cell list it was given, and
// every other input can only change WHY a closed cell is closed or WHEN it is announced for.
//
// It is pure data and pure functions, like the rest of the package: no database, no Stripe, no
// environment. That leaves one thing outside it on purpose — the console's test-mode waiver
// (`testModeMarketOpen` in apps/console/lib/billing/eligibility.ts) is a property of one running
// console, not of the launch, and a caller that needs it combines it itself.

import {
	EU_MEMBER_STATES,
	PAID_MARKETS,
	PAYER_CAPACITIES,
	type PaidMarketCell,
	type PayerCapacity,
	SELLER_COUNTRY,
	VAT_ID_STATUSES,
	type VatIdStatus,
	matchPaidMarketCell,
	vatIdGivenOf,
	vatIdStatusOf,
	vatIdStatusRequired,
} from "./commerce";
import { LEGAL_ENTITY } from "./entity";

// ── The decided markets ─────────────────────────────────────────────────────────────────────────

// The seller's country and the EU member states moved to commerce.ts, which needs them for the
// VAT-number rule (#7320). They are re-exported so `@repo/legal/launch` imports keep working.
export { EU_MEMBER_STATES, SELLER_COUNTRY };

/**
 * The North American countries in the decided market. The decision says "North America"; the tax
 * research covers the United States and Canada and nothing else, so that is how it is read here
 * (`docs/legal/TAX_MARKET_PRECONDITIONS.md` §5.6). Adding a country is a decision, not a tidy-up.
 */
export const NORTH_AMERICA_MARKETS: readonly string[] = ["US", "CA"];

/**
 * Every country the maintainer has decided to sell into: the EU and North America, to businesses
 * and to individuals. Being listed here opens nothing — it only separates "decided, not open yet"
 * from "nobody has decided to sell there".
 */
export const DECIDED_MARKET_COUNTRIES: readonly string[] = [
	...EU_MEMBER_STATES,
	...NORTH_AMERICA_MARKETS,
];

/**
 * The date paid plans are announced for, as `YYYY-MM-DD`, or `null` when no date is promised.
 *
 * ⚠️ IT IS `null`, AND SETTING IT IS THE MAINTAINER'S. A date here is a public promise: every
 * surface that reads the launch state starts saying "available from" that day. It opens no cell and
 * takes no money. A date that has arrived or passed while the cells are still closed stops being
 * announced (see `paidLaunchState`), so a missed date reads as closed rather than as a promise that
 * was already broken.
 */
export const PAID_LAUNCH_ANNOUNCED_FOR: string | null = null;

// ── The stage name ──────────────────────────────────────────────────────────────────────────────

/**
 * The name of the commercial stage the product is in, as every surface prints it (ruling
 * 2026-11-23: paid use before the beta is called "Early Access").
 *
 * ONE constant on purpose. Before it, four surfaces each carried their own "Beta" literal and none
 * of them agreed on when it changed. A surface that needs the stage name imports this; it does not
 * write the words itself. Feature-level "Beta" tags on single features are a different thing and do
 * not read it.
 */
export const RELEASE_STAGE = "Early Access";

// ── The contract ────────────────────────────────────────────────────────────────────────────────

/**
 * Why a cell is closed — a closed set, so a surface can branch without parsing prose.
 *
 *  - `market_not_identified` — the country or the capacity is missing or malformed, or the buyer is
 *    an organization in an EU member state other than the seller's and has not declared whether it
 *    has a VAT number. Nothing is assumed about who is asking.
 *  - `market_not_decided` — the country is outside `DECIDED_MARKET_COUNTRIES`.
 *  - `subnational_thresholds_unresolved` — the country sets tax thresholds below the country level
 *    that a country-wide cell cannot honour, and the question is recorded as blocking.
 *  - `seller_registration_required` — an organization in an EU member state other than the
 *    seller's that GAVE a VAT number, while `vatRegistered` is false. The same organization without
 *    a VAT number does not carry this reason. (Such a buyer is offered the complimentary grant
 *    instead: `complimentaryGrantEligible` in commerce.ts.)
 *  - `evidence_not_recorded` — the market is decided and nothing above applies, but no cell with its
 *    evidence has been added to `PAID_MARKETS`.
 *  - `threshold_reached` — the cell is listed, but the next sale would cross a tax threshold
 *    (thresholds.ts). The launch state reads no turnover, so `paidLaunchState` and `paidLaunchCell`
 *    NEVER return it: it exists so the purchase gate, which does read turnover, refuses with a
 *    reason from this same set. It is the only reason that can apply to a listed cell.
 *
 * One reason per cell: the first that applies, in the order above. A cell that is in the list is
 * open whatever this taxonomy would have said about it — the list is the authority, and the reason
 * only ever explains an absence (except `threshold_reached`, above).
 */
export type PaidCellClosedReason =
	| "market_not_identified"
	| "market_not_decided"
	| "subnational_thresholds_unresolved"
	| "seller_registration_required"
	| "evidence_not_recorded"
	| "threshold_reached";

/** Every closed reason, in the order they are tested. */
export const PAID_CELL_CLOSED_REASONS: readonly PaidCellClosedReason[] = [
	"market_not_identified",
	"market_not_decided",
	"subnational_thresholds_unresolved",
	"seller_registration_required",
	"evidence_not_recorded",
	"threshold_reached",
];

/**
 * What each reason means and where its record lives. Written for the person deciding whether a cell
 * can open, not for a visitor: no public page should render these.
 */
export const PAID_CELL_CLOSED_REASON_DETAIL: Readonly<
	Record<PaidCellClosedReason, string>
> = {
	market_not_identified:
		"The country or the payer capacity was missing or malformed, or an organization in another EU " +
		"member state did not declare whether it has a VAT number, so no market could be identified.",
	market_not_decided:
		"The country is outside the decided markets (the EU, the United States and Canada).",
	subnational_thresholds_unresolved:
		"Provincial thresholds below the country level are recorded as unresolved, and a country-wide " +
		"cell cannot refuse a single province. See docs/legal/TAX_MARKET_PRECONDITIONS.md, section 3.7.",
	seller_registration_required:
		"The buyer is a business in another EU member state that gives a VAT number, which may not be " +
		"charged before the seller's registration exists. See docs/legal/TAX_MARKET_PRECONDITIONS.md, " +
		"section 3.3.",
	evidence_not_recorded:
		"The market is decided, but no cell with its evidence has been added to PAID_MARKETS. " +
		"See docs/legal/PAID_MARKETS.md for the four conditions.",
	threshold_reached:
		"The cell is open, but the next sale would cross a tax threshold (EUR 51,130 in Bulgaria, " +
		"EUR 10,000 for cross-border EU sales to buyers with no VAT number, or a US state's threshold). " +
		"See docs/legal/TAX_MARKET_PRECONDITIONS.md, sections 3.1 and 3.5.",
};

/**
 * The state of one cell.
 *
 *  - `open` — the cell is in the cell list; `evidence` is the string recorded on it.
 *  - `announced` — closed today, in a decided market, with a date promised that is still ahead.
 *    `reason` is why it is closed today.
 *  - `closed` — closed, with no date ahead.
 */
export type PaidCellState =
	| { readonly status: "open"; readonly evidence: string }
	| {
			readonly status: "announced";
			readonly from: string;
			readonly reason: PaidCellClosedReason;
	  }
	| { readonly status: "closed"; readonly reason: PaidCellClosedReason };

/**
 * The trial's state for one cell. It is the SAME type as the paid state and is produced by the same
 * rule from the same inputs — that is the whole of "the trial sits behind the same gate as paid".
 * The name exists so a caller says which of the two it is reading.
 */
export type TrialCellState = PaidCellState;

/** One cell with the state of both things a person in it could start. */
export interface PaidLaunchCell {
	/** ISO 3166-1 alpha-2, upper-case. Empty when the country could not be identified. */
	readonly country: string;
	/** `null` when the capacity was not declared. */
	readonly capacity: PayerCapacity | null;
	/**
	 * The organization's VAT-number status the cell was asked for, or `null` when it was not declared
	 * or the capacity is `consumer` (a consumer has none).
	 */
	readonly vatId: VatIdStatus | null;
	readonly paid: PaidCellState;
	readonly trial: TrialCellState;
}

/**
 * The state of the product as a whole — the answer to "is anything on sale anywhere".
 *
 *  - `open` — at least one cell is open.
 *  - `announced` — no cell is open and a date is promised that is still ahead.
 *  - `closed` — no cell is open and no date is ahead. `lapsedAnnouncement` carries a promised date
 *    that has arrived or passed, so a missed date is visible rather than silently dropped.
 */
export type LaunchState =
	| { readonly status: "open" }
	| { readonly status: "announced"; readonly from: string }
	| { readonly status: "closed"; readonly lapsedAnnouncement: string | null };

/**
 * How much of the decided market is open: `none`, `partial`, or `full` when every decided cell is
 * open. It is a count, not a verdict — which of these counts as "paid is ready" is the maintainer's
 * to define, and this module does not define it.
 */
export type DecidedMarketCoverage = "none" | "partial" | "full";

/** Everything the launch state is derived from. Nothing else is read. */
export interface PaidLaunchInputs {
	/** The open cells. In production, `PAID_MARKETS`. */
	readonly cells: readonly PaidMarketCell[];
	/** The promised date as `YYYY-MM-DD`, or `null`. In production, `PAID_LAUNCH_ANNOUNCED_FOR`. */
	readonly announcedFor: string | null;
	/** Whether the seller holds a VAT registration. In production, `LEGAL_ENTITY.vatRegistered`. */
	readonly vatRegistered: boolean;
	/** The day the question is asked on, as `YYYY-MM-DD` (UTC). */
	readonly asOf: string;
}

/** The launch state: the whole product, then every cell. */
export interface PaidLaunchState {
	readonly paid: LaunchState;
	/** Derived by the same rule as `paid`, from the same inputs. */
	readonly trial: LaunchState;
	readonly coverage: DecidedMarketCoverage;
	/**
	 * Every decided cell, in `DECIDED_MARKET_COUNTRIES` × `PAYER_CAPACITIES` order, with each
	 * `organization` listed once per `VAT_ID_STATUSES` entry (`given`, then `not_given`) — 3 cells per
	 * country. Then any open cell outside the decided markets, so that an open cell is never missing
	 * from the list.
	 *
	 * The organization is split in every country, not only in the EU, because a cell may be narrowed
	 * by `vatId` anywhere; in Bulgaria and outside the EU a cell without `vatId` simply opens both.
	 */
	readonly cells: readonly PaidLaunchCell[];
}

// ── Derivation ──────────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a string is a real calendar date written as `YYYY-MM-DD`. `2027-02-30` matches the shape
 * and is not a date, so the parts are checked against the calendar and not only against the pattern.
 */
export function isIsoDate(value: string | null | undefined): value is string {
	if (!value) return false;
	const match = ISO_DATE.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

/** A date as `YYYY-MM-DD` in UTC — the form `PaidLaunchInputs.asOf` takes. */
export function toIsoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * The inputs as the repository holds them today: the real cell list, the real promised date, the
 * real registration flag. This is the one place those three are gathered, and the one impure step —
 * it reads the clock unless a date is passed.
 */
export function currentPaidLaunchInputs(now: Date = new Date()): PaidLaunchInputs {
	return {
		cells: PAID_MARKETS,
		announcedFor: PAID_LAUNCH_ANNOUNCED_FOR,
		vatRegistered: LEGAL_ENTITY.vatRegistered,
		asOf: toIsoDate(now),
	};
}

/**
 * The promised date if it is still a promise, otherwise `null`.
 *
 * FAIL-CLOSED: a malformed date, a malformed `asOf`, and a date that is today or earlier all yield
 * `null`. "Available from today" over a closed cell is already untrue, so the day itself does not
 * count as ahead.
 */
function announcementAhead(inputs: PaidLaunchInputs): string | null {
	const { announcedFor, asOf } = inputs;
	if (!isIsoDate(announcedFor) || !isIsoDate(asOf)) return null;
	return announcedFor > asOf ? announcedFor : null;
}

/** A well-formed promised date that is no longer ahead, or `null`. */
function lapsedAnnouncement(inputs: PaidLaunchInputs): string | null {
	const { announcedFor } = inputs;
	if (!isIsoDate(announcedFor)) return null;
	return announcementAhead(inputs) === null ? announcedFor : null;
}

/** The country as an upper-case alpha-2 code, or `null` when it is missing or not two characters. */
function normaliseCountry(country: string | null | undefined): string | null {
	if (!country) return null;
	const iso = country.trim().toUpperCase();
	return iso.length === 2 ? iso : null;
}

/** The capacity if it is one of the two known values, otherwise `null`. */
function knownCapacity(
	capacity: PayerCapacity | null | undefined,
): PayerCapacity | null {
	return PAYER_CAPACITIES.find((known) => known === capacity) ?? null;
}

/** Why a cell that is not in the cell list is closed: the first reason that applies. */
function closedReason(
	country: string,
	capacity: PayerCapacity,
	vatId: VatIdStatus | null,
	inputs: PaidLaunchInputs,
): PaidCellClosedReason {
	if (!DECIDED_MARKET_COUNTRIES.includes(country)) return "market_not_decided";
	if (country === "CA") return "subnational_thresholds_unresolved";
	if (
		vatId === "given" &&
		vatIdStatusRequired(country, capacity) &&
		!inputs.vatRegistered
	) {
		return "seller_registration_required";
	}
	return "evidence_not_recorded";
}

/**
 * The state of one cell under the given inputs — the ONE rule both the paid state and the trial
 * state are read from.
 *
 * `open` is decided by the cell list alone, through `matchPaidMarketCell` — the same function
 * `paidMarketEnabled` calls — so the two cannot disagree about a cell. A closed cell in a decided
 * market is `announced` while a promised date is ahead; a cell outside the decided markets is never
 * announced, because the promise was not made about it.
 */
function cellState(
	country: string | null,
	capacity: PayerCapacity | null,
	vatId: VatIdStatus | null,
	inputs: PaidLaunchInputs,
): PaidCellState {
	if (country === null || capacity === null) {
		return { status: "closed", reason: "market_not_identified" };
	}
	if (vatId === null && vatIdStatusRequired(country, capacity)) {
		return { status: "closed", reason: "market_not_identified" };
	}
	const open = matchPaidMarketCell(inputs.cells, country, capacity, vatIdGivenOf(vatId));
	if (open) return { status: "open", evidence: open.evidence };

	const reason = closedReason(country, capacity, vatId, inputs);
	const from = announcementAhead(inputs);
	if (from !== null && reason !== "market_not_decided") {
		return { status: "announced", from, reason };
	}
	return { status: "closed", reason };
}

/**
 * The paid and trial state for one buyer, for any country — decided or not.
 *
 * FAIL-CLOSED on the inputs, as `paidMarketEnabled` is: a missing or malformed country and an
 * undeclared capacity are closed with `market_not_identified`, never defaulted to the seller's own
 * country; so is an organization in an EU member state other than the seller's whose VAT-number
 * status is undeclared.
 *
 * @param vatIdGiven whether an organization gave a VAT number; `null`/omitted when undeclared.
 *   Ignored for a consumer. Same meaning as in `paidMarketEnabled`.
 */
export function paidLaunchCell(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
	vatIdGiven: boolean | null = null,
	inputs: PaidLaunchInputs = currentPaidLaunchInputs(),
): PaidLaunchCell {
	const iso = normaliseCountry(country);
	const known = knownCapacity(capacity);
	const vatId = known === "organization" ? vatIdStatusOf(vatIdGiven) : null;
	const state = cellState(iso, known, vatId, inputs);
	return { country: iso ?? "", capacity: known, vatId, paid: state, trial: state };
}

/** The whole-product state for a set of cells: open if any is, else announced, else closed. */
function overallState(
	cells: readonly PaidLaunchCell[],
	inputs: PaidLaunchInputs,
): LaunchState {
	if (cells.some((cell) => cell.paid.status === "open")) {
		return { status: "open" };
	}
	const from = announcementAhead(inputs);
	if (from !== null) return { status: "announced", from };
	return { status: "closed", lapsedAnnouncement: lapsedAnnouncement(inputs) };
}

/** The decided cells for one country: the consumer, then the organization once per VAT status. */
function decidedCellsFor(country: string, inputs: PaidLaunchInputs): PaidLaunchCell[] {
	return PAYER_CAPACITIES.flatMap((capacity) =>
		capacity === "organization"
			? VAT_ID_STATUSES.map((status) =>
					paidLaunchCell(country, capacity, vatIdGivenOf(status), inputs),
				)
			: [paidLaunchCell(country, capacity, null, inputs)],
	);
}

/**
 * The launch state: whether paid plans and the trial are open, announced or closed, for the product
 * and for every cell.
 *
 * Pure when `inputs` is passed. With no argument it reads the repository's own inputs and today's
 * date, which is what a page calls.
 *
 * Three properties the tests hold it to:
 *
 *  1. A cell is `open` exactly when `matchPaidMarketCell` finds it in `inputs.cells` — the rule
 *     `paidMarketEnabled` uses. No date, flag or reason opens one.
 *  2. The trial's state equals the paid state, cell for cell and overall, because it is the same
 *     value from the same rule.
 *  3. With today's inputs everything is `closed` — which is what a visitor can buy today.
 */
export function paidLaunchState(
	inputs: PaidLaunchInputs = currentPaidLaunchInputs(),
): PaidLaunchState {
	const decided = DECIDED_MARKET_COUNTRIES.flatMap((country) =>
		decidedCellsFor(country, inputs),
	);
	const seen = new Set<string>();
	const outside = inputs.cells
		.filter((cell) => !DECIDED_MARKET_COUNTRIES.includes(cell.country))
		.map((cell) =>
			paidLaunchCell(cell.country, cell.capacity, vatIdGivenOf(cell.vatId), inputs),
		)
		.filter((cell) => cell.paid.status === "open")
		.filter((cell) => {
			const key = `${cell.country}/${cell.capacity}/${cell.vatId}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const cells = [...decided, ...outside];

	const openDecided = decided.filter((cell) => cell.paid.status === "open").length;
	const coverage: DecidedMarketCoverage =
		openDecided === 0 ? "none" : openDecided === decided.length ? "full" : "partial";

	const overall = overallState(cells, inputs);
	return { paid: overall, trial: overall, coverage, cells };
}

// ── The open markets, in words ──────────────────────────────────────────────────────────────────

/**
 * English names for the decided countries, written to follow "in" ("in the Netherlands"). A country
 * outside this list is printed as its code — an open cell outside the decided markets is a decision
 * nobody has made, and it should look odd on a page rather than be dressed up.
 */
const COUNTRY_NAMES: Readonly<Record<string, string>> = {
	AT: "Austria",
	BE: "Belgium",
	BG: "Bulgaria",
	CY: "Cyprus",
	CZ: "Czechia",
	DE: "Germany",
	DK: "Denmark",
	EE: "Estonia",
	ES: "Spain",
	FI: "Finland",
	FR: "France",
	GR: "Greece",
	HR: "Croatia",
	HU: "Hungary",
	IE: "Ireland",
	IT: "Italy",
	LT: "Lithuania",
	LU: "Luxembourg",
	LV: "Latvia",
	MT: "Malta",
	NL: "the Netherlands",
	PL: "Poland",
	PT: "Portugal",
	RO: "Romania",
	SE: "Sweden",
	SI: "Slovenia",
	SK: "Slovakia",
	US: "the US",
	CA: "Canada",
};

/** A list in English with a serial comma: "a", "a and b", "a, b, and c". */
function englishList(items: readonly string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`;
}

/** Countries in decided-market order, then any others alphabetically, so the wording is stable. */
function orderCountries(countries: ReadonlySet<string>): string[] {
	const rank = (country: string): number => {
		const index = DECIDED_MARKET_COUNTRIES.indexOf(country);
		return index === -1 ? DECIDED_MARKET_COUNTRIES.length : index;
	};
	return [...countries].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The countries' names, in a stable order. */
function countryNames(countries: ReadonlySet<string>): string[] {
	return orderCountries(countries).map((country) => COUNTRY_NAMES[country] ?? country);
}

/** Whether every EU member state is in `countries`. */
function coversEu(countries: ReadonlySet<string>): boolean {
	return EU_MEMBER_STATES.every((country) => countries.has(country));
}

/** `countries` without the EU member states. */
function withoutEu(countries: ReadonlySet<string>): Set<string> {
	return new Set([...countries].filter((country) => !EU_MEMBER_STATES.includes(country)));
}

/**
 * "in X, Y and Z" for a set of countries, saying "the EU" in place of the 27 member states when all
 * of them are present.
 */
function inCountries(countries: ReadonlySet<string>): string {
	if (!coversEu(countries)) return `in ${englishList(countryNames(countries))}`;
	return `in ${englishList(["the EU", ...countryNames(withoutEu(countries))])}`;
}

/**
 * The phrase for organization cells narrowed to one VAT status, e.g. "EU businesses without a VAT
 * number". A member state already open to every business counts as covered, so a Bulgarian cell
 * without `vatId` plus the 26 other member states' `not_given` cells reads as the whole EU.
 */
function narrowedPhrase(
	narrowed: ReadonlySet<string>,
	anyStatus: ReadonlySet<string>,
	qualifier: string,
): string[] {
	if (narrowed.size === 0) return [];
	const covered = new Set([...narrowed, ...anyStatus]);
	if (!coversEu(covered)) return [`businesses ${qualifier} ${inCountries(narrowed)}`];
	const rest = withoutEu(narrowed);
	return [
		`EU businesses ${qualifier}`,
		...(rest.size > 0 ? [`businesses ${qualifier} ${inCountries(rest)}`] : []),
	];
}

/**
 * Who can buy today, in words, derived from the cells — or `null` when no cell is open.
 *
 * For example, with Bulgarian and US business cells and a `not_given` business cell for each of the
 * other 26 member states: "businesses in Bulgaria and the US, and EU businesses without a VAT
 * number". The phrase is lower-case so a surface can put it after its own words ("Early Access is
 * open to …"). It names only open cells; it never says what is closed.
 *
 * It is derived, never typed, so the sentence cannot claim a market that the gate refuses. An
 * organization with both a `given` and a `not_given` cell in a country reads as open to every
 * business there.
 *
 * @param cells in production, `PAID_MARKETS` (the default).
 */
export function openMarketSummary(
	cells: readonly PaidMarketCell[] = PAID_MARKETS,
): string | null {
	const statusesByCountry = new Map<string, Set<VatIdStatus | "any">>();
	const consumers = new Set<string>();
	for (const cell of cells) {
		if (cell.capacity === "consumer") {
			// A consumer cell narrowed by vatId never matches (commerce.ts), so it opens nothing.
			if (cell.vatId === undefined) consumers.add(cell.country);
			continue;
		}
		const statuses = statusesByCountry.get(cell.country) ?? new Set<VatIdStatus | "any">();
		statuses.add(cell.vatId ?? "any");
		statusesByCountry.set(cell.country, statuses);
	}

	const anyStatus = new Set<string>();
	const notGiven = new Set<string>();
	const given = new Set<string>();
	for (const [country, statuses] of statusesByCountry) {
		if (statuses.has("any") || (statuses.has("given") && statuses.has("not_given"))) {
			anyStatus.add(country);
		} else if (statuses.has("not_given")) {
			notGiven.add(country);
		} else {
			given.add(country);
		}
	}

	const phrases = [
		...(anyStatus.size > 0 ? [`businesses ${inCountries(anyStatus)}`] : []),
		...narrowedPhrase(notGiven, anyStatus, "without a VAT number"),
		...narrowedPhrase(given, anyStatus, "with a VAT number"),
		...(consumers.size > 0 ? [`individuals ${inCountries(consumers)}`] : []),
	];
	if (phrases.length === 0) return null;
	// Two phrases that already contain "and" need the comma, or the second reads as one more country.
	if (phrases.length === 2 && phrases.some((phrase) => phrase.includes(" and "))) {
		return phrases.join(", and ");
	}
	return englishList(phrases);
}
