// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	PAID_MARKETS,
	PAYER_CAPACITIES,
	type PaidMarketCell,
	VAT_ID_STATUSES,
	type VatIdStatus,
	anyPaidMarketOpen,
	complimentaryGrantEligible,
	matchPaidMarketCell,
	paidMarketEnabled,
	paidMarketEvidence,
	vatIdGivenOf,
} from "./commerce";
import { LEGAL_ENTITY } from "./entity";
import {
	DECIDED_MARKET_COUNTRIES,
	EU_MEMBER_STATES,
	NORTH_AMERICA_MARKETS,
	PAID_CELL_CLOSED_REASONS,
	PAID_CELL_CLOSED_REASON_DETAIL,
	PAID_LAUNCH_ANNOUNCED_FOR,
	type PaidLaunchInputs,
	RELEASE_STAGE,
	SELLER_COUNTRY,
	currentPaidLaunchInputs,
	isIsoDate,
	openMarketSummary,
	paidLaunchCell,
	paidLaunchState,
	toIsoDate,
} from "./launch";

const EVIDENCE = "Synthetic evidence used only by this test file.";

/** Inputs with nothing open, no date and no registration, asked on a fixed day. */
const shut: PaidLaunchInputs = {
	cells: [],
	announcedFor: null,
	vatRegistered: false,
	asOf: "2026-11-17",
};

/** The number of decided cells: per country, the consumer and the organization once per VAT status. */
const DECIDED_CELLS = 29 * 3;

/** A synthetic open cell, optionally narrowed by VAT-number status. */
function cell(
	country: string,
	capacity: PaidMarketCell["capacity"],
	vatId?: VatIdStatus,
): PaidMarketCell {
	return vatId === undefined
		? { country, capacity, evidence: EVIDENCE }
		: { country, capacity, vatId, evidence: EVIDENCE };
}

/** The cells the Early Access ruling opens: BG and US businesses, EU businesses with no VAT number. */
function earlyAccessCells(): PaidMarketCell[] {
	return [
		cell("BG", "organization"),
		cell("US", "organization"),
		...EU_MEMBER_STATES.filter((country) => country !== SELLER_COUNTRY).map((country) =>
			cell(country, "organization", "not_given"),
		),
	];
}

/** One synthetic open cell for every decided country × capacity. */
function everyDecidedCell(): PaidMarketCell[] {
	return DECIDED_MARKET_COUNTRIES.flatMap((country) =>
		PAYER_CAPACITIES.map((capacity) => cell(country, capacity)),
	);
}

describe("the decided markets", () => {
	it("are the 27 EU member states, the United States and Canada, each listed once", () => {
		expect(EU_MEMBER_STATES).toHaveLength(27);
		expect([...NORTH_AMERICA_MARKETS]).toEqual(["US", "CA"]);
		expect(new Set(DECIDED_MARKET_COUNTRIES).size).toBe(29);
		expect(DECIDED_MARKET_COUNTRIES).toHaveLength(29);
		for (const country of DECIDED_MARKET_COUNTRIES) {
			expect(country).toMatch(/^[A-Z]{2}$/);
		}
	});

	it("include the seller's own country, written as an ISO code and not a VAT prefix", () => {
		expect(EU_MEMBER_STATES).toContain(SELLER_COUNTRY);
		expect(EU_MEMBER_STATES).toContain("GR");
		expect(EU_MEMBER_STATES).not.toContain("EL");
		expect(DECIDED_MARKET_COUNTRIES).not.toContain("MX");
		expect(DECIDED_MARKET_COUNTRIES).not.toContain("GB");
	});
});

describe("the launch state as the repository holds it today", () => {
	const today = paidLaunchState(currentPaidLaunchInputs(new Date("2026-11-17T12:00:00Z")));

	// The limit this unit is built under: nothing a visitor can buy changes. These read the REAL
	// inputs, so they go red on the day a cell opens or a date is set — which is the day somebody
	// should be reading this file.
	it("gathers the real cell list, the real date and the real registration flag", () => {
		const inputs = currentPaidLaunchInputs(new Date("2026-11-17T23:59:59Z"));
		expect(inputs.cells).toBe(PAID_MARKETS);
		expect(inputs.announcedFor).toBe(PAID_LAUNCH_ANNOUNCED_FOR);
		expect(inputs.vatRegistered).toBe(LEGAL_ENTITY.vatRegistered);
		expect(inputs.asOf).toBe("2026-11-17");
	});

	it("agrees with the purchase gate's own readers on every decided cell", () => {
		for (const entry of today.cells) {
			const given = vatIdGivenOf(entry.vatId);
			const enabled = paidMarketEnabled(entry.country, entry.capacity, given);
			expect(entry.paid.status === "open").toBe(enabled);
			if (entry.paid.status === "open") {
				expect(entry.paid.evidence).toBe(
					paidMarketEvidence(entry.country, entry.capacity, given),
				);
			}
		}
		expect(today.paid.status === "open").toBe(anyPaidMarketOpen());
	});

	it("is closed for paid and for the trial while no cell is open and no date is set", () => {
		if (PAID_MARKETS.length > 0 || PAID_LAUNCH_ANNOUNCED_FOR !== null) return;
		expect(today.paid).toEqual({ status: "closed", lapsedAnnouncement: null });
		expect(today.trial).toEqual({ status: "closed", lapsedAnnouncement: null });
		expect(today.coverage).toBe("none");
		expect(today.cells).toHaveLength(DECIDED_CELLS);
		for (const entry of today.cells) {
			expect(entry.paid.status).toBe("closed");
			expect(entry.trial.status).toBe("closed");
		}
	});

	it("reads the clock only when no date is passed, and still returns a real date", () => {
		expect(isIsoDate(currentPaidLaunchInputs().asOf)).toBe(true);
		expect(paidLaunchState().cells.length).toBeGreaterThanOrEqual(DECIDED_CELLS);
	});
});

describe("why a closed cell is closed", () => {
	it("names every decided cell in country × capacity × VAT-status order", () => {
		const state = paidLaunchState(shut);
		expect(state.cells.map((c) => `${c.country}/${c.capacity}/${c.vatId}`)).toEqual(
			DECIDED_MARKET_COUNTRIES.flatMap((country) => [
				`${country}/consumer/null`,
				...VAT_ID_STATUSES.map((status) => `${country}/organization/${status}`),
			]),
		);
		expect(state.cells).toHaveLength(DECIDED_CELLS);
	});

	it("gives the seller's own country the plain not-recorded reason, whatever the VAT status", () => {
		for (const capacity of PAYER_CAPACITIES) {
			for (const given of [true, false, null]) {
				expect(paidLaunchCell("BG", capacity, given, shut).paid).toEqual({
					status: "closed",
					reason: "evidence_not_recorded",
				});
			}
		}
	});

	it("says only a business in another member state WITH a VAT number waits on the registration", () => {
		expect(paidLaunchCell("DE", "organization", true, shut).paid).toEqual({
			status: "closed",
			reason: "seller_registration_required",
		});
		expect(paidLaunchCell("DE", "organization", false, shut).paid).toEqual({
			status: "closed",
			reason: "evidence_not_recorded",
		});
		// The consumer cell of the same country does not carry that reason.
		expect(paidLaunchCell("DE", "consumer", null, shut).paid).toEqual({
			status: "closed",
			reason: "evidence_not_recorded",
		});
	});

	// The registration removes a REASON. It must never be read as opening the cell.
	it("drops the registration reason once registered, and still does not open the cell", () => {
		const registered = { ...shut, vatRegistered: true };
		expect(paidLaunchCell("DE", "organization", true, registered).paid).toEqual({
			status: "closed",
			reason: "evidence_not_recorded",
		});
		expect(paidLaunchState(registered).paid.status).toBe("closed");
		expect(paidLaunchState(registered).coverage).toBe("none");
	});

	it("keeps Canada on the sub-national reason whatever the registration says", () => {
		for (const vatRegistered of [false, true]) {
			for (const capacity of PAYER_CAPACITIES) {
				expect(paidLaunchCell("CA", capacity, true, { ...shut, vatRegistered }).paid).toEqual({
					status: "closed",
					reason: "subnational_thresholds_unresolved",
				});
			}
		}
	});

	it("gives the United States the plain not-recorded reason", () => {
		for (const capacity of PAYER_CAPACITIES) {
			expect(paidLaunchCell("US", capacity, true, shut).paid).toEqual({
				status: "closed",
				reason: "evidence_not_recorded",
			});
		}
	});

	it("says a country outside the decided markets has not been decided", () => {
		for (const country of ["MX", "GB", "CH", "JP"]) {
			expect(paidLaunchCell(country, "organization", null, shut).paid).toEqual({
				status: "closed",
				reason: "market_not_decided",
			});
		}
	});

	// Fail-closed on the question itself, as paidMarketEnabled is: a missing country must never
	// become the seller's own.
	it("refuses a missing or malformed country and an undeclared capacity", () => {
		const unidentified = { status: "closed", reason: "market_not_identified" };
		for (const country of [null, undefined, "", " ", "B", "BGR", "Bulgaria"]) {
			const entry = paidLaunchCell(country, "consumer", null, shut);
			expect(entry.paid).toEqual(unidentified);
			expect(entry.trial).toEqual(unidentified);
			expect(entry.country).toBe("");
		}
		for (const capacity of [null, undefined]) {
			const entry = paidLaunchCell("BG", capacity, null, shut);
			expect(entry.paid).toEqual(unidentified);
			expect(entry.capacity).toBeNull();
			expect(entry.country).toBe("BG");
		}
	});

	// The VAT-number status is part of identifying the market for an EU business outside Bulgaria:
	// an undeclared one is refused rather than guessed, and nowhere else is it needed.
	it("refuses an undeclared VAT status for a business in another member state only", () => {
		for (const country of EU_MEMBER_STATES.filter((c) => c !== SELLER_COUNTRY)) {
			const entry = paidLaunchCell(country, "organization", null, shut);
			expect(entry.paid).toEqual({ status: "closed", reason: "market_not_identified" });
			expect(entry.vatId).toBeNull();
		}
		expect(paidLaunchCell("DE", "consumer", null, shut).paid).toEqual({
			status: "closed",
			reason: "evidence_not_recorded",
		});
		for (const country of ["BG", "US"]) {
			expect(paidLaunchCell(country, "organization", null, shut).paid).toEqual({
				status: "closed",
				reason: "evidence_not_recorded",
			});
		}
	});

	it("records the VAT status asked for an organization, and none for a consumer", () => {
		expect(paidLaunchCell("DE", "organization", true, shut).vatId).toBe("given");
		expect(paidLaunchCell("DE", "organization", false, shut).vatId).toBe("not_given");
		expect(paidLaunchCell("DE", "consumer", true, shut).vatId).toBeNull();
	});

	it("stays unidentified for a malformed question even when every cell is open and a date is set", () => {
		const wide = { ...shut, cells: everyDecidedCell(), announcedFor: "2027-02-15" };
		expect(paidLaunchCell("DE", "organization", null, wide).paid).toEqual({
			status: "closed",
			reason: "market_not_identified",
		});
		expect(paidLaunchCell(null, "consumer", null, wide).paid).toEqual({
			status: "closed",
			reason: "market_not_identified",
		});
		expect(paidLaunchCell("BG", null, null, wide).paid).toEqual({
			status: "closed",
			reason: "market_not_identified",
		});
	});

	it("only ever gives a reason from the closed set, and explains each one", () => {
		const seen = new Set<string>();
		for (const entry of paidLaunchState(shut).cells) {
			if (entry.paid.status === "open") continue;
			expect(PAID_CELL_CLOSED_REASONS).toContain(entry.paid.reason);
			seen.add(entry.paid.reason);
		}
		expect([...seen].sort()).toEqual([
			"evidence_not_recorded",
			"seller_registration_required",
			"subnational_thresholds_unresolved",
		]);
		// Produced only by the purchase gate, which reads turnover; the launch state never does.
		expect(PAID_CELL_CLOSED_REASONS).toContain("threshold_reached");
		expect(Object.keys(PAID_CELL_CLOSED_REASON_DETAIL).sort()).toEqual(
			[...PAID_CELL_CLOSED_REASONS].sort(),
		);
		for (const reason of PAID_CELL_CLOSED_REASONS) {
			expect(PAID_CELL_CLOSED_REASON_DETAIL[reason].length).toBeGreaterThan(40);
		}
	});
});

describe("an open cell", () => {
	const oneOpen = { ...shut, cells: [cell("BG", "organization")] };

	it("is open with its evidence, and opens nothing beside it", () => {
		expect(paidLaunchCell("BG", "organization", null, oneOpen).paid).toEqual({
			status: "open",
			evidence: EVIDENCE,
		});
		expect(paidLaunchCell("BG", "consumer", null, oneOpen).paid.status).toBe("closed");
		expect(paidLaunchCell("DE", "organization", false, oneOpen).paid.status).toBe("closed");
		const open = paidLaunchState(oneOpen).cells.filter((c) => c.paid.status === "open");
		expect(open.map((c) => `${c.country}/${c.capacity}/${c.vatId}`)).toEqual([
			"BG/organization/given",
			"BG/organization/not_given",
		]);
	});

	it("matches the country as the purchase gate does: trimmed and case-insensitive", () => {
		expect(paidLaunchCell(" bg ", "organization", null, oneOpen).paid.status).toBe("open");
		expect(paidLaunchCell(" bg ", "organization", null, oneOpen).country).toBe("BG");
	});

	it("makes the product open and the coverage partial", () => {
		const state = paidLaunchState(oneOpen);
		expect(state.paid).toEqual({ status: "open" });
		expect(state.trial).toEqual({ status: "open" });
		expect(state.coverage).toBe("partial");
	});

	// The list is the authority. The reasons explain an absence; they are not a second gate that
	// could disagree with the one the purchase path reads.
	it("is open when listed even where a reason would otherwise have applied", () => {
		const listed = { ...shut, cells: [cell("CA", "consumer"), cell("DE", "organization")] };
		expect(paidLaunchCell("CA", "consumer", null, listed).paid.status).toBe("open");
		expect(paidLaunchCell("DE", "organization", true, listed).paid.status).toBe("open");
	});

	it("reports full coverage only when every decided cell is open", () => {
		const all = everyDecidedCell();
		expect(paidLaunchState({ ...shut, cells: all }).coverage).toBe("full");
		expect(paidLaunchState({ ...shut, cells: all.slice(1) }).coverage).toBe("partial");
	});

	it("lists an open cell outside the decided markets rather than hiding it", () => {
		const outside = { ...shut, cells: [cell("GB", "organization")] };
		const state = paidLaunchState(outside);
		expect(state.cells).toHaveLength(DECIDED_CELLS + 1);
		expect(state.cells.at(-1)).toEqual({
			country: "GB",
			capacity: "organization",
			vatId: null,
			paid: { status: "open", evidence: EVIDENCE },
			trial: { status: "open", evidence: EVIDENCE },
		});
		expect(state.paid).toEqual({ status: "open" });
		// It is on sale, but it is not part of the decided market, so it does not count toward it.
		expect(state.coverage).toBe("none");
	});

	it("does not open on a cell whose country is not an upper-case code", () => {
		const malformed = { ...shut, cells: [cell("bg", "organization")] };
		expect(paidLaunchCell("BG", "organization", null, malformed).paid.status).toBe("closed");
		expect(paidLaunchState(malformed).paid.status).toBe("closed");
		expect(paidLaunchState(malformed).cells).toHaveLength(DECIDED_CELLS);
	});
});

describe("an announced date", () => {
	const announced = { ...shut, announcedFor: "2027-02-15" };

	it("announces the product and every decided cell, keeping each cell's reason", () => {
		const state = paidLaunchState(announced);
		expect(state.paid).toEqual({ status: "announced", from: "2027-02-15" });
		expect(state.trial).toEqual({ status: "announced", from: "2027-02-15" });
		expect(state.coverage).toBe("none");
		for (const entry of state.cells) {
			expect(entry.paid.status).toBe("announced");
		}
		expect(paidLaunchCell("DE", "organization", true, announced).paid).toEqual({
			status: "announced",
			from: "2027-02-15",
			reason: "seller_registration_required",
		});
	});

	// A date is a promise and nothing else.
	it("opens nothing", () => {
		const state = paidLaunchState(announced);
		expect(state.cells.some((c) => c.paid.status === "open")).toBe(false);
		expect(state.cells.some((c) => c.trial.status === "open")).toBe(false);
	});

	it("does not announce a country nobody decided to sell into", () => {
		expect(paidLaunchCell("MX", "consumer", null, announced).paid).toEqual({
			status: "closed",
			reason: "market_not_decided",
		});
	});

	it("leaves an open cell open and announces the rest", () => {
		const mixed = { ...announced, cells: [cell("BG", "organization")] };
		const state = paidLaunchState(mixed);
		expect(state.paid).toEqual({ status: "open" });
		expect(paidLaunchCell("BG", "organization", null, mixed).paid.status).toBe("open");
		expect(paidLaunchCell("BG", "consumer", null, mixed).paid.status).toBe("announced");
	});

	// "Available from today" over a closed cell is already untrue, so the day itself is not ahead.
	it("stops being announced on the day it arrives, and says which date lapsed", () => {
		for (const asOf of ["2027-02-15", "2027-02-16", "2028-01-01"]) {
			const state = paidLaunchState({ ...announced, asOf });
			expect(state.paid).toEqual({ status: "closed", lapsedAnnouncement: "2027-02-15" });
			expect(state.trial).toEqual({ status: "closed", lapsedAnnouncement: "2027-02-15" });
			expect(paidLaunchCell("BG", "consumer", null, { ...announced, asOf }).paid).toEqual({
				status: "closed",
				reason: "evidence_not_recorded",
			});
		}
		expect(paidLaunchState({ ...announced, asOf: "2027-02-14" }).paid.status).toBe(
			"announced",
		);
	});

	it("treats a malformed date, or a malformed day of asking, as no promise", () => {
		for (const announcedFor of ["15 Feb 2027", "2027-2-15", "2027-02-30", "2027-13-01", ""]) {
			expect(paidLaunchState({ ...shut, announcedFor }).paid).toEqual({
				status: "closed",
				lapsedAnnouncement: null,
			});
		}
		for (const asOf of ["", "today", "2026-11-31"]) {
			expect(paidLaunchState({ ...announced, asOf }).paid.status).toBe("closed");
		}
	});
});

describe("the trial", () => {
	// The trial sits behind the same rule as paid. Held across every combination of inputs this
	// file uses, so a later change that gives the trial its own path has to change this test.
	it("has the paid state, overall and cell for cell, under every input", () => {
		const variants: PaidLaunchInputs[] = [
			shut,
			{ ...shut, vatRegistered: true },
			{ ...shut, announcedFor: "2027-02-15" },
			{ ...shut, announcedFor: "2027-02-15", asOf: "2027-03-01" },
			{ ...shut, cells: [cell("BG", "organization")] },
			{ ...shut, cells: [cell("GB", "consumer")], announcedFor: "2027-02-15" },
			{ ...shut, cells: everyDecidedCell(), vatRegistered: true },
			{ ...shut, cells: earlyAccessCells() },
		];
		for (const inputs of variants) {
			const state = paidLaunchState(inputs);
			expect(state.trial).toEqual(state.paid);
			for (const entry of state.cells) {
				expect(entry.trial).toEqual(entry.paid);
			}
			for (const country of ["BG", "DE", "CA", "US", "MX", "", "bg"]) {
				for (const capacity of [...PAYER_CAPACITIES, null]) {
					for (const given of [true, false, null]) {
						const entry = paidLaunchCell(country, capacity, given, inputs);
						expect(entry.trial).toEqual(entry.paid);
					}
				}
			}
		}
	});
});

describe("dates", () => {
	it("accepts a real calendar date and nothing else", () => {
		expect(isIsoDate("2027-01-31")).toBe(true);
		expect(isIsoDate("2028-02-29")).toBe(true);
		expect(isIsoDate("2027-02-29")).toBe(false);
		expect(isIsoDate("2027-00-10")).toBe(false);
		expect(isIsoDate("2027-01-31T00:00:00Z")).toBe(false);
		expect(isIsoDate(" 2027-01-31")).toBe(false);
		expect(isIsoDate(null)).toBe(false);
		expect(isIsoDate(undefined)).toBe(false);
	});

	it("writes a date in UTC, so the day does not depend on the machine's zone", () => {
		expect(toIsoDate(new Date("2027-01-31T23:30:00+02:00"))).toBe("2027-01-31");
		expect(toIsoDate(new Date("2027-01-31T23:30:00-05:00"))).toBe("2027-02-01");
	});
});

describe("the VAT-number dimension", () => {
	// The reason the dimension exists: opening EU businesses that give no VAT number must not also
	// open the ones that give one, which the seller may not charge before its registration.
	it("never opens the VAT-number case from a no-VAT-number cell", () => {
		for (const country of EU_MEMBER_STATES.filter((c) => c !== SELLER_COUNTRY)) {
			const inputs = { ...shut, cells: [cell(country, "organization", "not_given")] };
			expect(paidLaunchCell(country, "organization", false, inputs).paid.status).toBe("open");
			expect(paidLaunchCell(country, "organization", true, inputs).paid).toEqual({
				status: "closed",
				reason: "seller_registration_required",
			});
			expect(paidLaunchCell(country, "organization", null, inputs).paid).toEqual({
				status: "closed",
				reason: "market_not_identified",
			});
			expect(paidLaunchCell(country, "consumer", null, inputs).paid.status).toBe("closed");
			expect(matchPaidMarketCell(inputs.cells, country, "organization", true)).toBeUndefined();
		}
	});

	it("opens both statuses from a cell without vatId, once the status is declared", () => {
		const inputs = { ...shut, cells: [cell("DE", "organization")] };
		expect(paidLaunchCell("DE", "organization", true, inputs).paid.status).toBe("open");
		expect(paidLaunchCell("DE", "organization", false, inputs).paid.status).toBe("open");
		expect(paidLaunchCell("DE", "organization", null, inputs).paid.status).toBe("closed");
	});

	it("passes an undeclared status in Bulgaria and the US, where it changes nothing", () => {
		const inputs = { ...shut, cells: [cell("BG", "organization"), cell("US", "organization")] };
		for (const country of ["BG", "US"]) {
			for (const given of [true, false, null]) {
				expect(paidLaunchCell(country, "organization", given, inputs).paid.status).toBe("open");
			}
		}
	});

	it("does not let a narrowed cell match an undeclared status, or any consumer", () => {
		const narrowed = [cell("BG", "organization", "given"), cell("FR", "consumer", "not_given")];
		expect(matchPaidMarketCell(narrowed, "BG", "organization", null)).toBeUndefined();
		expect(matchPaidMarketCell(narrowed, "BG", "organization", true)).toBeDefined();
		expect(matchPaidMarketCell(narrowed, "FR", "consumer", false)).toBeUndefined();
		expect(matchPaidMarketCell(narrowed, "FR", "consumer", null)).toBeUndefined();
	});
});

describe("the Early Access cells", () => {
	const earlyAccess = { ...shut, cells: earlyAccessCells() };

	it("open BG and US businesses and EU businesses without a VAT number, and nothing else", () => {
		const state = paidLaunchState(earlyAccess);
		const open = state.cells
			.filter((c) => c.paid.status === "open")
			.map((c) => `${c.country}/${c.capacity}/${c.vatId}`);
		const expected = DECIDED_MARKET_COUNTRIES.flatMap((country) => {
			if (country === "BG" || country === "US") {
				return [`${country}/organization/given`, `${country}/organization/not_given`];
			}
			return EU_MEMBER_STATES.includes(country) ? [`${country}/organization/not_given`] : [];
		});
		expect(open).toEqual(expected);
		expect(open).toHaveLength(2 + 2 + 26);
		expect(state.paid).toEqual({ status: "open" });
		expect(state.coverage).toBe("partial");
	});

	it("keeps every consumer, Canada and every VAT-number EU business closed", () => {
		for (const country of DECIDED_MARKET_COUNTRIES) {
			expect(paidLaunchCell(country, "consumer", null, earlyAccess).paid.status).toBe("closed");
		}
		for (const given of [true, false]) {
			expect(paidLaunchCell("CA", "organization", given, earlyAccess).paid.status).toBe("closed");
		}
		for (const country of EU_MEMBER_STATES.filter((c) => c !== SELLER_COUNTRY)) {
			expect(paidLaunchCell(country, "organization", true, earlyAccess).paid).toEqual({
				status: "closed",
				reason: "seller_registration_required",
			});
		}
	});

	// The buyers the sale refuses for want of a registration are exactly the buyers the grant takes.
	it("routes exactly the closed VAT-number EU businesses to the complimentary grant", () => {
		for (const entry of paidLaunchState(earlyAccess).cells) {
			const eligible = complimentaryGrantEligible(
				entry.country,
				entry.capacity,
				vatIdGivenOf(entry.vatId),
				earlyAccess.vatRegistered,
			);
			const refusedForRegistration =
				entry.paid.status === "closed" && entry.paid.reason === "seller_registration_required";
			expect(eligible).toBe(refusedForRegistration);
		}
	});
});

describe("the launch state and the purchase gate's matching", () => {
	// `paidMarketEnabled` reads PAID_MARKETS, which is empty; this holds the same agreement over
	// synthetic lists by calling the matcher it delegates to with each list.
	it("agree on every enumerated cell under every input", () => {
		const variants: PaidLaunchInputs[] = [
			shut,
			{ ...shut, cells: earlyAccessCells() },
			{ ...shut, cells: everyDecidedCell() },
			{ ...shut, cells: [cell("DE", "organization", "given")], vatRegistered: true },
			{ ...shut, cells: [cell("GB", "organization"), cell("CA", "consumer")] },
		];
		for (const inputs of variants) {
			for (const entry of paidLaunchState(inputs).cells) {
				const match = matchPaidMarketCell(
					inputs.cells,
					entry.country,
					entry.capacity,
					vatIdGivenOf(entry.vatId),
				);
				expect(entry.paid.status === "open").toBe(match !== undefined);
				if (entry.paid.status === "open") expect(entry.paid.evidence).toBe(match?.evidence);
			}
		}
	});

	it("never returns threshold_reached, because it reads no turnover", () => {
		for (const inputs of [shut, { ...shut, cells: earlyAccessCells() }]) {
			for (const entry of paidLaunchState(inputs).cells) {
				if (entry.paid.status !== "open") expect(entry.paid.reason).not.toBe("threshold_reached");
			}
		}
	});
});

describe("the stage name and the open markets in words", () => {
	it("names the stage Early Access", () => {
		expect(RELEASE_STAGE).toBe("Early Access");
	});

	it("says nothing is open while no cell is", () => {
		expect(openMarketSummary([])).toBeNull();
		if (PAID_MARKETS.length === 0) expect(openMarketSummary()).toBeNull();
	});

	it("describes the Early Access cells", () => {
		expect(openMarketSummary(earlyAccessCells())).toBe(
			"businesses in Bulgaria and the US, and EU businesses without a VAT number",
		);
	});

	it("lists countries when only some member states are open", () => {
		expect(
			openMarketSummary([
				cell("FR", "organization", "not_given"),
				cell("DE", "organization", "not_given"),
			]),
		).toBe("businesses without a VAT number in Germany and France");
		expect(openMarketSummary([cell("BG", "organization")])).toBe("businesses in Bulgaria");
	});

	it("reads a country with both statuses open as open to every business", () => {
		expect(
			openMarketSummary([
				cell("DE", "organization", "given"),
				cell("DE", "organization", "not_given"),
			]),
		).toBe("businesses in Germany");
	});

	it("says the EU when every member state is open, and names individuals separately", () => {
		const consumers = EU_MEMBER_STATES.map((country) => cell(country, "consumer"));
		expect(openMarketSummary([...consumers, cell("US", "consumer")])).toBe(
			"individuals in the EU and the US",
		);
		expect(openMarketSummary(everyDecidedCell())).toBe(
			"businesses in the EU, the US, and Canada, and individuals in the EU, the US, and Canada",
		);
	});

	it("prints an undecided country as its code, and ignores a consumer cell narrowed by vatId", () => {
		expect(openMarketSummary([cell("GB", "organization")])).toBe("businesses in GB");
		expect(openMarketSummary([cell("FR", "consumer", "not_given")])).toBeNull();
	});
});
