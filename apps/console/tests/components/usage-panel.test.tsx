// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the Usage page panel: mock the server actions it loads on mount and
// assert it renders the four sections with the mocked numbers, and that the header shows the
// right affordance (paid → "Manage billing", Hobby → "Upgrade to Pro").

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AiUsageSummary,
	BillingSummary,
	UsageOverTime,
	UsageReport,
} from "@/app/server/actions/billing";

vi.mock("@/app/server/actions/billing", () => ({
	getBillingSummary: vi.fn(),
	getOrgUsage: vi.fn(),
	getResourceCounts: vi.fn(),
	getUsageOverTime: vi.fn(),
	getAiUsageSummary: vi.fn(),
	getLiveAiPrices: vi.fn(),
	setUsageHardCap: vi.fn(),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
}));
// The purchase sheets pull in Stripe + many actions — stub them; they're covered elsewhere.
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/components/billing/upgrade-ai-sheet", () => ({ UpgradeAiSheet: () => null }));
vi.mock("@/components/billing/credit-pack-dialog", () => ({
	CreditPackDialog: () => null,
}));

import { UsagePanel } from "@/components/settings/usage/usage-panel";
import {
	getAiUsageSummary,
	getBillingSummary,
	getLiveAiPrices,
	getOrgUsage,
	getResourceCounts,
	getUsageOverTime,
} from "@/app/server/actions/billing";
import type { LiveAiPriceMap } from "@/lib/billing/pricing";

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
	hosted: true,
	hasOrg: true,
	plan: "team",
	status: "active",
	state: "active",
	currentPeriodEnd: "2026-07-01T00:00:00.000Z",
	canManage: true,
	cancelAtPeriodEnd: false,
	seats: 5,
	memberCount: 3,
	unitAmountUsd: 20,
	...over,
});

const usage: UsageReport = {
	usedMinutes: 320,
	includedMinutes: 500,
	overageMinutes: 0,
	overageCost: 0,
	pct: 0.64,
	approaching: false,
	overLimit: false,
	periodStart: "2026-06-01T00:00:00.000Z",
	periodEnd: "2026-07-01T00:00:00.000Z",
	plan: "team",
	hardCap: false,
	runningJobs: 1,
	maxConcurrentJobs: 8,
};

const overTime: UsageOverTime = {
	series: [{ date: "2026-06-01", runnerMinutes: 320, jobs: 12, aiCredits: 1200 }],
	totals: { runnerMinutes: 320, jobs: 12, aiCredits: 1200 },
};

const ai: AiUsageSummary = {
	enabled: true,
	tier: "ai_plus",
	sessionUsed: 40,
	sessionBudget: 200,
	sessionResetAt: "2100-01-01T00:00:00.000Z",
	weeklyUsed: 1200,
	weeklyBudget: 1500,
	weeklyResetAt: "2100-01-01T00:00:00.000Z",
	purchasedBalance: 500,
	paidTiersEnabled: true,
	orgWeeklyCapCredits: null,
	perUserWeeklyCapCredits: null,
	canManageCaps: false,
};

const aiPrices: LiveAiPriceMap = {
	ai_free: {
		unitAmountUsd: 0,
		unitAmountEur: 0,
		currency: "usd",
		interval: "month",
		label: "Free",
	},
	ai_plus: {
		unitAmountUsd: 20,
		unitAmountEur: 18,
		currency: "usd",
		interval: "month",
		label: "$20 / mo",
	},
	ai_max: {
		unitAmountUsd: 100,
		unitAmountEur: 90,
		currency: "usd",
		interval: "month",
		label: "$100 / mo",
	},
};

beforeEach(() => {
	vi.mocked(getOrgUsage).mockResolvedValue(usage);
	vi.mocked(getResourceCounts).mockResolvedValue({
		projects: 9,
		clusters: 2,
		spendUnderManagement: 1234,
	});
	vi.mocked(getUsageOverTime).mockResolvedValue(overTime);
	vi.mocked(getAiUsageSummary).mockResolvedValue(ai);
	vi.mocked(getLiveAiPrices).mockResolvedValue(aiPrices);
});

describe("UsagePanel", () => {
	it("renders the four sections for a paid org with a Manage-billing link", async () => {
		vi.mocked(getBillingSummary).mockResolvedValue(summary());
		render(<UsagePanel />);

		expect(await screen.findByText("Pro plan")).toBeInTheDocument();
		expect(screen.getByText("Plan & limits")).toBeInTheDocument();
		expect(screen.getByText("Resources")).toBeInTheDocument();
		expect(screen.getByText("Usage over time")).toBeInTheDocument();
		expect(screen.getByText("AI plan & usage")).toBeInTheDocument();
		// Resource counters + AI budget are wired from the mocked numbers.
		expect(screen.getByText("Projects")).toBeInTheDocument();
		expect(screen.getByText("9")).toBeInTheDocument(); // projects (projects)
		expect(screen.getByText("2")).toBeInTheDocument(); // clusters
		expect(screen.getByRole("link", { name: /manage billing/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /upgrade to pro/i })).toBeNull();
	});

	it("offers Upgrade to Pro for a Hobby org", async () => {
		vi.mocked(getBillingSummary).mockResolvedValue(
			summary({ plan: "community", status: "none", seats: null }),
		);
		render(<UsagePanel />);

		expect(await screen.findByText("Hobby plan")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /manage billing/i })).toBeNull();
	});

	it("shows the self-managed notice when billing isn't wired", async () => {
		vi.mocked(getBillingSummary).mockResolvedValue(summary({ hosted: false }));
		render(<UsagePanel />);
		expect(await screen.findByText(/self-managed deployment/i)).toBeInTheDocument();
	});

	describe("AI plan & usage card", () => {
		it("labels the meters as the rolling session + weekly limit", async () => {
			vi.mocked(getBillingSummary).mockResolvedValue(summary());
			render(<UsagePanel />);
			expect(await screen.findByText("Current session")).toBeInTheDocument();
			expect(screen.getByText("Weekly limit")).toBeInTheDocument();
		});

		it("shows the idle session state when there is no usage in the window", async () => {
			vi.mocked(getBillingSummary).mockResolvedValue(summary());
			vi.mocked(getAiUsageSummary).mockResolvedValue({
				...ai,
				sessionUsed: 0,
				sessionResetAt: null,
			});
			render(<UsagePanel />);
			expect(await screen.findByText("Starts on first use")).toBeInTheDocument();
		});

		it("offers Buy credits on a paid tier at/near a limit", async () => {
			vi.mocked(getBillingSummary).mockResolvedValue(summary());
			// weekly 1200/1500 = 80% → at the upsell threshold on a paid tier.
			render(<UsagePanel />);
			expect(
				await screen.findByRole("button", { name: /buy credits/i }),
			).toBeInTheDocument();
		});

		it("hides Buy credits below the limit threshold", async () => {
			vi.mocked(getBillingSummary).mockResolvedValue(summary());
			vi.mocked(getAiUsageSummary).mockResolvedValue({
				...ai,
				sessionUsed: 10,
				weeklyUsed: 100, // well under 80% on both windows
			});
			render(<UsagePanel />);
			await screen.findByText("Current session");
			expect(screen.queryByRole("button", { name: /buy credits/i })).toBeNull();
		});

		it("hides Buy credits and the balance strip on the free tier", async () => {
			vi.mocked(getBillingSummary).mockResolvedValue(summary());
			vi.mocked(getAiUsageSummary).mockResolvedValue({
				...ai,
				tier: "ai_free",
				sessionUsed: 200, // even at limit, free never sees the top-up CTA
				weeklyUsed: 1500,
				purchasedBalance: 0,
			});
			render(<UsagePanel />);
			await screen.findByText("Current session");
			expect(screen.queryByRole("button", { name: /buy credits/i })).toBeNull();
			expect(screen.queryByText(/top-up credits never expire/i)).toBeNull();
		});
	});
});
