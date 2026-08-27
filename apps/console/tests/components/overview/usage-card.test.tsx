// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locks the reported defect (#2876): the org overview rendered runner minutes as "0.943 / 200 min".
// `usedMinutes` arrives as an unrounded float (`extract(epoch from …) / 60.0`), nothing rounds it,
// and `toLocaleString()` defaults to three fraction digits. It must read "<1 min / 200 min", and
// the "% used" caption beside it must not contradict that by saying "0% used".

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AiUsageSummary,
	BillingSummary,
	UsageReport,
} from "@/app/server/actions/billing";

vi.mock("@/app/server/actions/billing", () => ({
	getOrgUsage: vi.fn(),
	getBillingSummary: vi.fn(),
	getAiUsageSummary: vi.fn(),
}));
// The upgrade sheet pulls in Stripe and a tree of actions; the CTA itself is not under test here.
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { UsageCard } from "@/components/overview/usage-card";
import {
	getAiUsageSummary,
	getBillingSummary,
	getOrgUsage,
} from "@/app/server/actions/billing";

const usage = (over: Partial<UsageReport> = {}): UsageReport => ({
	usedMinutes: 0.9433333333333334,
	includedMinutes: 200,
	overageMinutes: 0,
	overageCost: 0,
	pct: 0.9433333333333334 / 200,
	approaching: false,
	overLimit: false,
	periodStart: "2026-08-01T00:00:00.000Z",
	periodEnd: "2026-09-01T00:00:00.000Z",
	plan: "community",
	hardCap: false,
	runningJobs: 0,
	// Unlimited concurrency keeps the SECOND gauge out of the render, so a "0% used"
	// assertion below is unambiguously about the minutes row.
	maxConcurrentJobs: null,
	...over,
});

const billing = (over: Partial<BillingSummary> = {}): BillingSummary => ({
	hosted: true,
	hasOrg: true,
	plan: "community",
	status: "none",
	state: "none",
	currentPeriodEnd: null,
	canManage: false,
	cancelAtPeriodEnd: false,
	seats: null,
	memberCount: 3,
	unitAmountUsd: null,
	...over,
});

// AI disabled keeps the two AI gauges out of the way — they are a separate concern with their
// own readout (a reset time), and this file is about the minutes row.
const ai = (): AiUsageSummary => ({
	enabled: false,
	tier: "ai_free",
	sessionUsed: 0,
	sessionBudget: 0,
	sessionResetAt: null,
	weeklyUsed: 0,
	weeklyBudget: 0,
	weeklyResetAt: "2026-09-01T00:00:00.000Z",
	purchasedBalance: 0,
	paidTiersEnabled: false,
	orgWeeklyCapCredits: null,
	perUserWeeklyCapCredits: null,
	canManageCaps: false,
});

beforeEach(() => {
	vi.mocked(getOrgUsage).mockResolvedValue(usage());
	vi.mocked(getBillingSummary).mockResolvedValue(billing());
	vi.mocked(getAiUsageSummary).mockResolvedValue(ai());
});

describe("UsageCard runner-minutes readout", () => {
	it("renders a sub-minute float as '<1 min', never '0.943'", async () => {
		render(<UsageCard orgSlug="itgix" projectCount={4} />);

		expect(await screen.findByText("<1 min / 200 min")).toBeInTheDocument();
		expect(screen.queryByText(/0\.943/)).not.toBeInTheDocument();
	});

	it("does not say '0% used' when something HAS run", async () => {
		render(<UsageCard orgSlug="itgix" projectCount={4} />);

		expect(await screen.findByText("<1% used")).toBeInTheDocument();
		expect(screen.queryByText("0% used")).not.toBeInTheDocument();
	});

	it("still says '0% used' and '0 min' when the allowance is genuinely untouched", async () => {
		vi.mocked(getOrgUsage).mockResolvedValue(usage({ usedMinutes: 0, pct: 0 }));
		render(<UsageCard orgSlug="itgix" projectCount={4} />);

		expect(await screen.findByText("0 min / 200 min")).toBeInTheDocument();
		expect(screen.getByText("0% used")).toBeInTheDocument();
	});

	it("humanises an hour-plus total and keeps the allowance in plan minutes", async () => {
		vi.mocked(getOrgUsage).mockResolvedValue(
			usage({ usedMinutes: 135.4, pct: 135.4 / 200 }),
		);
		render(<UsageCard orgSlug="itgix" projectCount={4} />);

		expect(await screen.findByText("2h 15m / 200 min")).toBeInTheDocument();
		expect(screen.getByText("68% used")).toBeInTheDocument();
	});

	it("shows an overage past 100% rather than flattening it", async () => {
		vi.mocked(getOrgUsage).mockResolvedValue(
			usage({
				usedMinutes: 250,
				overageMinutes: 50,
				overLimit: true,
				approaching: true,
				pct: 1.25,
			}),
		);
		render(<UsageCard orgSlug="itgix" projectCount={4} />);

		expect(await screen.findByText("4h 10m / 200 min")).toBeInTheDocument();
		expect(screen.getByText("125% used")).toBeInTheDocument();
	});
});
