// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's Usage card (#6118: read over `overview.usage`, prefetched on the server).
//
// 1. #2876: runner minutes rendered as "0.943 / 200 min". `usedMinutes` arrives as an unrounded
//    float, so it must read "<1 min / 200 min", and the "% used" caption must not say "0% used".
// 2. #6118: the caption said "Last 30 days" over a value that counts from the start of the CURRENT
//    BILLING PERIOD. It must name the period's start — in UTC, the zone the period is anchored in.
// 3. #6118: pending, failed and answered are three renders; a failure is a region error with a
//    retry, never a skeleton forever (RUBRIC B4).

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewUsage } from "@/lib/rpc/procedures/overview";

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));
// The upgrade sheet pulls in Stripe and a tree of actions; the CTA itself is not under test here.
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { UsageCard, UsageCardSkeleton, overviewUsageQuery, usagePeriodCaption } from "@/components/overview/usage-card";
import { never, reads, renderWithReads, testClient } from "./rpc-fake";

const usage = (over: Partial<OverviewUsage["runner"]> = {}, rest: Partial<OverviewUsage> = {}): OverviewUsage => ({
	hosted: true,
	plan: "community",
	memberCount: 3,
	canInvite: false,
	runner: { usedMinutes: 0.9433333333333334, includedMinutes: 200, periodStart: "2026-10-01T00:00:00.000Z", ...over },
	// Unlimited concurrency keeps the SECOND gauge out of the render, so a "0% used" assertion below
	// is unambiguously about the minutes row.
	concurrency: { running: 0, max: null },
	// AI disabled keeps the two AI gauges out of the way — their readout is a reset time.
	ai: {
		enabled: false,
		sessionUsed: 0,
		sessionBudget: 0,
		sessionResetAt: null,
		weeklyUsed: 0,
		weeklyBudget: 0,
		weeklyResetAt: "2026-10-26T00:00:00.000Z",
	},
	...rest,
});

/** Renders the card with `data` already in the cache — what the page's prefetch hands it. */
function renderAnswered(data: OverviewUsage) {
	const client = testClient();
	client.setQueryData(overviewUsageQuery().queryKey, data);
	return renderWithReads(<UsageCard orgSlug="acme" projectCount={4} />, client);
}

beforeEach(() => {
	reads.usage.mockReset();
	reads.usage.mockImplementation(never);
});

describe("UsageCard runner-minutes readout", () => {
	it("renders a sub-minute float as '<1 min', never '0.943'", () => {
		renderAnswered(usage());
		expect(screen.getByText("<1 min / 200 min")).toBeInTheDocument();
		expect(screen.queryByText(/0\.943/)).not.toBeInTheDocument();
	});

	it("does not say '0% used' when something HAS run", () => {
		renderAnswered(usage());
		expect(screen.getByText("<1% used")).toBeInTheDocument();
		expect(screen.queryByText("0% used")).not.toBeInTheDocument();
	});

	it("still says '0% used' and '0 min' when the allowance is genuinely untouched", () => {
		renderAnswered(usage({ usedMinutes: 0 }));
		expect(screen.getByText("0 min / 200 min")).toBeInTheDocument();
		expect(screen.getByText("0% used")).toBeInTheDocument();
	});

	it("humanises an hour-plus total and keeps the allowance in plan minutes", () => {
		renderAnswered(usage({ usedMinutes: 135.4 }));
		expect(screen.getByText("2h 15m / 200 min")).toBeInTheDocument();
		expect(screen.getByText("68% used")).toBeInTheDocument();
	});

	it("shows an overage past 100% rather than flattening it", () => {
		renderAnswered(usage({ usedMinutes: 250 }));
		expect(screen.getByText("4h 10m / 200 min")).toBeInTheDocument();
		expect(screen.getByText("125% used")).toBeInTheDocument();
	});

	it("reads no data on mount when the page prefetched it (B1)", () => {
		renderAnswered(usage());
		expect(reads.usage).not.toHaveBeenCalled();
	});
});

describe("UsageCard caption — what the value actually covers (#6118)", () => {
	const zone = process.env.TZ;
	afterEach(() => {
		process.env.TZ = zone;
	});

	it("names the billing period's start, not 'Last 30 days'", () => {
		renderAnswered(usage({ periodStart: "2026-10-01T00:00:00.000Z" }));
		expect(screen.getByText("Since 1 Oct 2026")).toBeInTheDocument();
		expect(screen.queryByText(/last 30 days/i)).not.toBeInTheDocument();
	});

	it("prints the period's UTC day whatever the runtime's zone, so server and browser agree", () => {
		// 23:30 UTC on 31 Oct is already 1 Nov in Auckland: a caption in the runtime's zone would say
		// "1 Nov" here and "31 Oct" on a UTC server — a different day, and a hydration mismatch.
		process.env.TZ = "Pacific/Auckland";
		expect(usagePeriodCaption("2026-10-31T23:30:00.000Z")).toBe("Since 31 Oct 2026");
	});

	it("shows no caption while the read is pending — it would be a guess", () => {
		renderWithReads(<UsageCard orgSlug="acme" projectCount={4} />);
		expect(screen.queryByText(/^Since /)).not.toBeInTheDocument();
	});
});

describe("UsageCard states (RUBRIC B3/B4)", () => {
	it("pending renders the skeleton — no error, no numbers", () => {
		const { container } = renderWithReads(<UsageCard orgSlug="acme" projectCount={4} />);
		expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
		expect(screen.queryByText(/Couldn't load usage/)).not.toBeInTheDocument();
		expect(screen.queryByText(/% used/)).not.toBeInTheDocument();
	});

	it("a failed read is a region error with a retry, not a skeleton forever", async () => {
		reads.usage.mockRejectedValue(new Error("boom"));
		const { container } = renderWithReads(<UsageCard orgSlug="acme" projectCount={4} />);
		expect(await screen.findByText("Couldn't load usage")).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).not.toBeNull();
		expect(container.querySelector("[aria-busy='true']")).toBeNull();

		reads.usage.mockResolvedValue(usage());
		const before = reads.usage.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		await waitFor(() => expect(screen.getByText("<1 min / 200 min")).toBeInTheDocument());
		expect(reads.usage.mock.calls.length).toBe(before + 1);
	});
});

// #6347: the release gate's B1 held `/[org]` with every read stalled, so the render it compared was
// the SERVER's — and "starts on first use", the AI session readout before any session has run, was
// missing from it. That readout reads no clock, so it is data and belongs in the server HTML; only a
// running session's countdown ("resets in 4 hr") must wait for hydration (React #418 otherwise).
//
// Mutation check (run in CI on this PR's branch): routing the not-started readout back through
// `ClockSlot` fails the first test.
describe("UsageCard first paint — the AI session readout (B1)", () => {
	const ai = (sessionResetAt: string | null): Partial<OverviewUsage> => ({
		ai: {
			enabled: true,
			sessionUsed: 0,
			sessionBudget: 100,
			sessionResetAt,
			weeklyUsed: 0,
			weeklyBudget: 500,
			weeklyResetAt: "2026-10-26T00:00:00.000Z",
		},
	});

	/** The card's server HTML with `data` prefetched — what the page's first paint carries. */
	function serverHtml(data: OverviewUsage): string {
		const client = testClient();
		client.setQueryData(overviewUsageQuery().queryKey, data);
		return renderToString(
			<QueryClientProvider client={client}>
				<UsageCard orgSlug="acme" projectCount={4} />
			</QueryClientProvider>,
		);
	}

	// `ClockSlot` puts an invisible copy of its widest string in the server HTML to hold its width;
	// the session meter's is "resets in 23 hr 59 min", so its presence says the clock path was taken.
	const SESSION_SIZER = "resets in 23 hr 59 min";

	it("prints a session that has not started in the server HTML", () => {
		const html = serverHtml(usage({}, ai(null)));
		expect(html).toContain("starts on first use");
		expect(html).not.toContain(SESSION_SIZER);
	});

	it("leaves a running session's countdown to hydration", () => {
		const html = serverHtml(usage({}, ai("2026-10-20T10:00:00.000Z")));
		expect(html).toContain(SESSION_SIZER);
		expect(html).not.toContain("starts on first use");
	});
});

// #6347 (B2): the pending card drew two gauges over an answered card of four (runner minutes,
// concurrent jobs and the two AI meters every tier has) — the route skeleton's worst-moving block.
describe("UsageCardSkeleton", () => {
	it("draws the four gauges a default-plan org answers with", () => {
		const { container } = renderWithReads(<UsageCardSkeleton />);
		expect(container.querySelectorAll('[data-slot="skeleton"].rounded-full.size-10').length).toBe(4);
	});
});
