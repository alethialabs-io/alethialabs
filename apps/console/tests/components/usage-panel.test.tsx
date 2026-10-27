// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the Usage page panel. Its reads are GET procedures (#6127): the read client is
// a fake transport under the REAL TanStack utils (./settings/billing-rpc-fake), so the keys are the
// browser's. Asserts the four sections render the read numbers, the header affordance (paid →
// "Manage billing", Hobby → "Upgrade to Pro"), and the four distinct renders a section can end in.

import { screen, waitFor } from "@testing-library/react";
import { money } from "@repo/format";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveAiPriceMap } from "@/lib/billing/pricing";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";
import type { AiUsageSummary, UsageOverTime, UsageReport } from "@/lib/rpc/procedures/usage";

vi.mock("@/lib/rpc/client", async () => ({
	orpc: (await import("./settings/billing-rpc-fake")).fakeOrpc,
}));
vi.mock("@/app/server/actions/billing", () => ({
	setUsageHardCap: vi.fn(),
	saveAiSpendLimits: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
import { failed, reads, refused, renderWithReads, resetReads } from "./settings/billing-rpc-fake";

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
	hosted: true,
	hasOrg: true,
	plan: "team",
	status: "active",
	state: "active",
	currentPeriodEnd: "2026-07-01T00:00:00.000Z",
	canManage: true,
	canManageBilling: true,
	cancelAtPeriodEnd: false,
	seats: 5,
	memberCount: 3,
	unitAmount: money(2000, "usd"),
	...over,
});

const usage: UsageReport = {
	usedMinutes: 320,
	includedMinutes: 500,
	overageMinutes: 0,
	overageCost: money(0, "usd"),
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
		amounts: { usd: money(0, "usd"), eur: money(0, "eur") },
		currency: "usd",
		interval: "month",
		label: "Free",
	},
	ai_plus: {
		amounts: { usd: money(2000, "usd"), eur: money(1800, "eur") },
		currency: "usd",
		interval: "month",
		label: "$20 / mo",
	},
	ai_max: {
		amounts: { usd: money(10000, "usd"), eur: money(9000, "eur") },
		currency: "usd",
		interval: "month",
		label: "$100 / mo",
	},
};

beforeEach(() => {
	resetReads();
	reads.org.mockResolvedValue(usage);
	reads.resources.mockResolvedValue({
		projects: 9,
		clusters: 2,
		spendUnderManagement: 1234,
	});
	reads.overTime.mockResolvedValue(overTime);
	reads.ai.mockResolvedValue(ai);
	reads.liveAiPrices.mockResolvedValue(aiPrices);
});

describe("UsagePanel", () => {
	it("renders the four sections for a paid org with a Manage-billing link", async () => {
		reads.summary.mockResolvedValue(summary());
		renderWithReads(<UsagePanel />);

		expect(await screen.findByText("Pro plan")).toBeInTheDocument();
		expect(screen.getByText("Plan & limits")).toBeInTheDocument();
		expect(screen.getByText("Resources")).toBeInTheDocument();
		expect(screen.getByText("Usage over time")).toBeInTheDocument();
		expect(screen.getByText("AI plan & usage")).toBeInTheDocument();
		// Resource counters + AI budget are wired from the mocked numbers.
		expect(screen.getByText("Projects")).toBeInTheDocument();
		expect(await screen.findByText("9")).toBeInTheDocument(); // projects (projects)
		expect(screen.getByText("2")).toBeInTheDocument(); // clusters
		// The org-global billing route: `/{org}/settings/billing` (no `~`) is a PROJECT path.
		expect(screen.getByRole("link", { name: /manage billing/i })).toHaveAttribute(
			"href",
			"/acme/~/settings/billing",
		);
		expect(screen.queryByRole("button", { name: /upgrade to pro/i })).toBeNull();
	});

	it("is the AI card's only home, under the #ai anchor the Billing page links to (#6133)", async () => {
		reads.summary.mockResolvedValue(summary());
		renderWithReads(<UsagePanel />);
		const heading = await screen.findByText("AI plan & usage");
		expect(heading.closest("#ai")).not.toBeNull();
	});

	it("offers Upgrade to Pro for a Hobby org", async () => {
		reads.summary.mockResolvedValue(
			summary({ plan: "community", status: "none", seats: null }),
		);
		renderWithReads(<UsagePanel />);

		expect(await screen.findByText("Hobby plan")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /manage billing/i })).toBeNull();
	});

	it("shows the self-managed notice when billing isn't wired", async () => {
		reads.summary.mockResolvedValue(summary({ hosted: false }));
		renderWithReads(<UsagePanel />);
		expect(await screen.findByText(/self-managed deployment/i)).toBeInTheDocument();
	});

	describe("AI plan & usage card", () => {
		it("labels the meters as the rolling session + weekly limit", async () => {
			reads.summary.mockResolvedValue(summary());
			renderWithReads(<UsagePanel />);
			expect(await screen.findByText("Current session")).toBeInTheDocument();
			expect(screen.getByText("Weekly limit")).toBeInTheDocument();
		});

		it("shows the idle session state when there is no usage in the window", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.ai.mockResolvedValue({
				...ai,
				sessionUsed: 0,
				sessionResetAt: null,
			});
			renderWithReads(<UsagePanel />);
			// Exactly one match: the clock slot's width sizer is generated content, not a second copy.
			expect(await screen.findByText("Starts on first use")).toBeInTheDocument();
		});

		it("offers Buy credits on a paid tier at/near a limit", async () => {
			reads.summary.mockResolvedValue(summary());
			// weekly 1200/1500 = 80% → at the upsell threshold on a paid tier.
			renderWithReads(<UsagePanel />);
			expect(
				await screen.findByRole("button", { name: /buy credits/i }),
			).toBeInTheDocument();
		});

		it("hides Buy credits below the limit threshold", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.ai.mockResolvedValue({
				...ai,
				sessionUsed: 10,
				weeklyUsed: 100, // well under 80% on both windows
			});
			renderWithReads(<UsagePanel />);
			await screen.findByText("Current session");
			expect(screen.queryByRole("button", { name: /buy credits/i })).toBeNull();
		});

		it("hides Buy credits and the balance strip on the free tier", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.ai.mockResolvedValue({
				...ai,
				tier: "ai_free",
				sessionUsed: 200, // even at limit, free never sees the top-up CTA
				weeklyUsed: 1500,
				purchasedBalance: 0,
			});
			renderWithReads(<UsagePanel />);
			await screen.findByText("Current session");
			expect(screen.queryByRole("button", { name: /buy credits/i })).toBeNull();
			expect(screen.queryByText(/top-up credits never expire/i)).toBeNull();
		});
	});
	describe("four distinct renders (RUBRIC B4)", () => {
		it("a failed summary is an error with a retry — not the skeleton forever, not empty", async () => {
			reads.summary.mockRejectedValue(failed());
			renderWithReads(<UsagePanel />);
			expect(await screen.findByText("Couldn't load usage")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
			expect(document.querySelector("[aria-busy='true']")).toBeNull();
		});

		it("a pending summary is the page-shaped skeleton", () => {
			const { container } = renderWithReads(<UsagePanel />);
			expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
			expect(screen.queryByText("Plan & limits")).toBeNull();
		});

		it("a failed section is that section's error; the rest of the page renders", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.resources.mockRejectedValue(failed());
			renderWithReads(<UsagePanel />);
			expect(await screen.findByText("Couldn't load resources")).toBeInTheDocument();
			expect(screen.getByText("Plan & limits")).toBeInTheDocument();
			expect(screen.queryByText("Projects")).toBeNull();
		});

		it("a plan-gated section is its own refused render, not an error and not empty", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.resources.mockRejectedValue(refused("ENTITLEMENT_REQUIRED"));
			const { container } = renderWithReads(<UsagePanel />);
			await waitFor(() =>
				expect(container.querySelector("[data-state='refused'][data-refusal='plan']")).not.toBeNull(),
			);
			expect(screen.queryByText("Couldn't load resources")).toBeNull();
		});

		it("a refused read is not retried — asking again gets the same answer", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.resources.mockRejectedValue(refused("FORBIDDEN"));
			renderWithReads(<UsagePanel />);
			expect(await screen.findByText("Billing admins only")).toBeInTheDocument();
			expect(reads.resources).toHaveBeenCalledTimes(1);
		});
	});

	describe("usage over time (F023)", () => {
		it("a window of zero-filled days is the empty state, not a flat plot", async () => {
			reads.summary.mockResolvedValue(summary());
			reads.overTime.mockResolvedValue({
				series: [
					{ date: "2026-06-01", runnerMinutes: 0, jobs: 0, aiCredits: 0 },
					{ date: "2026-06-02", runnerMinutes: 0, jobs: 0, aiCredits: 0 },
				],
				totals: { runnerMinutes: 0, jobs: 0, aiCredits: 0 },
			});
			renderWithReads(<UsagePanel />);
			expect(await screen.findByText("No usage in this range")).toBeInTheDocument();
		});

		it("asks for the default window as its PRESET, the key the route prefetches", async () => {
			reads.summary.mockResolvedValue(summary());
			renderWithReads(<UsagePanel />);
			await waitFor(() => expect(reads.overTime).toHaveBeenCalled());
			expect(reads.overTime.mock.calls[0]?.[0]).toEqual({ range: { preset: "7d" } });
		});
	});

	it("does not offer the usage pause to a member without the billing permission", async () => {
		reads.summary.mockResolvedValue(summary({ canManageBilling: false }));
		renderWithReads(<UsagePanel />);
		await screen.findByText("Plan & limits");
		await screen.findByText("5h 20m / 500 min");
		expect(screen.queryByRole("checkbox")).toBeNull();
	});
});
