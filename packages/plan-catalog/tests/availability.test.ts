// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6906 (REL-L3) — the one set of sentences every pricing and upgrade surface shows for the launch
// state. One test per state, plus the rules that hold across them: the reseller (Paddle) is named only when open,
// and no state promises to notify anyone.
//
// EA-4 (#7326) adds the stage: the open state names the stage and the open markets it is GIVEN,
// and the last block reads every surface's source to hold that none of them writes the stage name
// itself — they all print `RELEASE_STAGE` from `@repo/legal/launch`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AI_PLAN_CATALOG,
	type LaunchWording,
	monthlyPriceLabel,
	type PaidAvailability,
	paidAvailabilityCopy,
	PLAN_CATALOG,
	releaseStageLine,
} from "../src/index";

/** A stand-in for `@repo/format`'s `formatDate(iso, "date", "UTC")` that is visibly not it. */
const day = (iso: string): string => `<${iso}>`;

/**
 * Stand-ins for `RELEASE_STAGE` and `openMarketSummary()` that are visibly not them, so a test can
 * tell the words came from the caller and were not typed in the package.
 */
const OPEN: LaunchWording = { stage: "<stage>", openMarkets: "<markets>" };
const NONE_OPEN: LaunchWording = { stage: "<stage>", openMarkets: null };

const STATES: readonly PaidAvailability[] = [
	{ status: "open" },
	{ status: "announced", from: "2027-02-15" },
	{ status: "closed" },
];

describe("paidAvailabilityCopy — open", () => {
	it("is on sale, names the stage and the open markets, and names the reseller, Paddle, in the billing lines", () => {
		const copy = paidAvailabilityCopy({ status: "open" }, day, OPEN);
		expect(copy.onSale).toBe(true);
		expect(copy.notice).toBe("<stage> is open to <markets>, with no uptime SLA");
		expect(copy.heading).toBeNull();
		expect(copy.body).toBeNull();
		expect(copy.proBilling).toBe(
			"Pro is billed per active member of your organization, monthly, through our reseller Paddle.",
		);
		expect(copy.aiBilling).toContain("through our reseller Paddle");
	});

	it("still names the stage and the SLA when no market can be named", () => {
		const copy = paidAvailabilityCopy({ status: "open" }, day, NONE_OPEN);
		expect(copy.notice).toBe("<stage>, with no uptime SLA");
	});
});

describe("paidAvailabilityCopy — announced", () => {
	it("says the promised date, formatted by the caller, on every line that shows it", () => {
		const copy = paidAvailabilityCopy({ status: "announced", from: "2027-02-15" }, day, OPEN);
		expect(copy.onSale).toBe(false);
		expect(copy.notice).toBe("Paid plans available from <2027-02-15>");
		expect(copy.heading).toBe("Pro is available from <2027-02-15>");
		expect(copy.body).toContain("Paid plans are available from <2027-02-15>");
		expect(copy.body).toContain("Hobby stays free, with no time limit.");
	});

	it("follows the date it is given rather than a fixed one", () => {
		const copy = paidAvailabilityCopy({ status: "announced", from: "2027-03-01" }, day, OPEN);
		expect(copy.notice).toBe("Paid plans available from <2027-03-01>");
	});
});

describe("paidAvailabilityCopy — closed", () => {
	it("keeps the sentence production says today, with no date", () => {
		const copy = paidAvailabilityCopy({ status: "closed" }, day, OPEN);
		expect(copy.onSale).toBe(false);
		expect(copy.notice).toBe("Not on sale yet");
		expect(copy.heading).toBe("Pro isn't on sale yet");
		expect(copy.body).toBe(
			"We can't take payment for Pro in any country yet. Hobby stays free, with no time limit.",
		);
	});
});

describe("paidAvailabilityCopy — across the states", () => {
	it("names the reseller, Paddle, only when the state is open", () => {
		for (const state of STATES) {
			const copy = paidAvailabilityCopy(state, day, OPEN);
			const lines = `${copy.proBilling} ${copy.aiBilling}`;
			expect(lines.includes("Paddle")).toBe(state.status === "open");
			expect(lines.includes("Stripe")).toBe(false);
		}
	});

	it("never promises to notify anyone, and never names a tier called Team", () => {
		for (const state of STATES) {
			const copy = paidAvailabilityCopy(state, day, OPEN);
			const text = Object.values(copy).filter((v) => typeof v === "string").join(" ");
			expect(text).not.toMatch(/tell you when|notify|let you know/i);
			expect(text).not.toMatch(/\bTeam\b/);
		}
	});
});

describe("paidAvailabilityCopy — the stage outside the open state", () => {
	it("leaves the not-on-sale sentences as they were, whatever the wording says", () => {
		for (const status of ["announced", "closed"] as const) {
			const state: PaidAvailability =
				status === "announced" ? { status, from: "2027-02-15" } : { status };
			const text = JSON.stringify(paidAvailabilityCopy(state, day, OPEN));
			expect(text).not.toContain("<stage>");
			expect(text).not.toContain("<markets>");
		}
	});
});

describe("releaseStageLine", () => {
	it("names who can buy when a market is open", () => {
		expect(releaseStageLine(OPEN)).toBe("<stage> is open to <markets>, with no uptime SLA.");
	});

	it("says nothing about buying when no market is open", () => {
		const line = releaseStageLine(NONE_OPEN);
		expect(line).toBe("No uptime SLA during <stage>.");
		expect(line).not.toMatch(/open|sale|buy/i);
	});
});

describe("one stage name on every surface (EA-4)", () => {
	const repo = join(__dirname, "..", "..", "..");
	const read = (path: string): string => readFileSync(join(repo, path), "utf8");

	// Every source that prints the commercial stage (spec §1.4, minus the sealed Terms and the
	// derived Consumer rights page). Each reads `RELEASE_STAGE`; none may spell the stage itself.
	const SURFACES = [
		"packages/plan-catalog/src/index.ts",
		"apps/console/components/billing/launch-copy.ts",
		"apps/console/components/shell/version-label.tsx",
		"apps/marketing/app/layout.tsx",
		"apps/marketing/components/landing/home/home-sections.tsx",
		"apps/marketing/components/landing/pricing.tsx",
	];

	// "beta" as a word, but not the `-beta` suffix of the platform release name
	// (`PLATFORM_RELEASE = "2027.01-beta"`, whose name is the maintainer's to keep or change).
	const BETA = /(?<![-\w])beta\b/i;
	const stage = /RELEASE_STAGE = "([^"]+)"/.exec(read("packages/legal/src/launch.ts"))?.[1];

	it("reads the stage name from @repo/legal/launch", () => {
		expect(stage).toBeTruthy();
	});

	it.each(SURFACES)("%s spells neither the old nor the current stage name", (path) => {
		const source = read(path);
		expect(source).not.toMatch(BETA);
		expect(source.includes(stage ?? "")).toBe(false);
	});

	it.each([
		"apps/console/components/shell/version-label.tsx",
		"apps/marketing/app/layout.tsx",
		"apps/marketing/components/landing/home/home-sections.tsx",
		"apps/marketing/components/landing/pricing.tsx",
	])("%s prints RELEASE_STAGE from @repo/legal/launch", (path) => {
		const source = read(path);
		expect(source).toMatch(/import \{[^}]*\bRELEASE_STAGE\b[^}]*\} from "@repo\/legal\/launch"/);
	});

	// The docs are prose and cannot import the constant, so they are held to it instead: no beta
	// wording, and the stage written exactly as the constant spells it.
	it.each([
		"apps/docs/content/docs/troubleshooting/billing.mdx",
		"apps/docs/content/docs/reference/limits.mdx",
	])("%s names the stage as RELEASE_STAGE spells it", (path) => {
		const source = read(path);
		expect(source).not.toMatch(BETA);
		expect(source).toContain(stage ?? "<no stage>");
	});
});

describe("monthlyPriceLabel", () => {
	it("renders AI Plus and AI Max in each currency from the catalog amounts", () => {
		const plus = AI_PLAN_CATALOG.find((p) => p.id === "ai_plus");
		const max = AI_PLAN_CATALOG.find((p) => p.id === "ai_max");
		if (!plus || !max) throw new Error("AI tiers missing from the catalog");
		expect(monthlyPriceLabel(plus, "usd")).toBe("$20 / mo");
		expect(monthlyPriceLabel(plus, "eur")).toBe("€18 / mo");
		expect(monthlyPriceLabel(max, "usd")).toBe("$100 / mo");
		expect(monthlyPriceLabel(max, "eur")).toBe("€90 / mo");
	});

	it("keeps a free entry's own label and falls back when a currency has no amount", () => {
		const hobby = PLAN_CATALOG.find((p) => p.id === "community");
		if (!hobby) throw new Error("Hobby missing from the catalog");
		expect(monthlyPriceLabel(hobby, "eur")).toBe("Free");
		expect(monthlyPriceLabel({ priceLabel: "Let's talk" }, "usd")).toBe("Let's talk");
	});
});
