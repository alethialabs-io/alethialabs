// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	setUsageHardCap: vi.fn(),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
}));
// The purchase sheets pull in Stripe + many actions — stub them; they're covered elsewhere.
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));

import { UsagePanel } from "@/components/settings/usage/usage-panel";
import {
	getAiUsageSummary,
	getBillingSummary,
	getOrgUsage,
	getResourceCounts,
	getUsageOverTime,
} from "@/app/server/actions/billing";

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
	hosted: true,
	hasOrg: true,
	plan: "team",
	status: "active",
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
	windowUsed: 1200,
	weeklyBudget: 3000,
	purchasedBalance: 500,
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
});

describe("UsagePanel", () => {
	it("renders the four sections for a paid org with a Manage-billing link", async () => {
		vi.mocked(getBillingSummary).mockResolvedValue(summary());
		render(<UsagePanel />);

		expect(await screen.findByText("Pro plan")).toBeInTheDocument();
		expect(screen.getByText("Plan & limits")).toBeInTheDocument();
		expect(screen.getByText("Resources")).toBeInTheDocument();
		expect(screen.getByText("Usage over time")).toBeInTheDocument();
		expect(screen.getByText("AI usage")).toBeInTheDocument();
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
});
