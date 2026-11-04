// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6355 (RUBRIC B2): the org usage route's loading state takes the shape of the page that replaces
// it, and on a self-managed instance that page is ONE card. The loading state used to draw the hosted
// report's skeleton everywhere — a toolbar, three gauges in a row, four sections — and the release
// gate (a self-managed console) measured it moving 0.066 against the single notice that replaced it,
// with two skeleton blocks side by side where the page set one.
//
// The deployment fact the loading state branches on is the one the billing summary's `hosted` reads
// (`isStripeConfigured()`), so it is mocked here at that one seam. The last case renders the PANEL's
// self-managed answer and the loading state side by side and requires the same card — the two draw
// one component, and this is what keeps them one.

import { render, screen } from "@testing-library/react";
import { money } from "@repo/format";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";

const h = vi.hoisted(() => ({ stripe: false }));

vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => h.stripe }));
vi.mock("@/lib/rpc/client", async () => ({
	orpc: (await import("../components/settings/billing-rpc-fake")).fakeOrpc,
}));
vi.mock("@/app/server/actions/billing", () => ({
	setUsageHardCap: vi.fn(),
	saveAiSpendLimits: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/components/billing/upgrade-ai-sheet", () => ({ UpgradeAiSheet: () => null }));
vi.mock("@/components/billing/credit-pack-dialog", () => ({ CreditPackDialog: () => null }));

import UsageLoading from "@/app/(private)/[org]/~/usage/loading";
import { UsagePanel } from "@/components/settings/usage/usage-panel";
import { reads, renderWithReads, resetReads } from "../components/settings/billing-rpc-fake";

const selfManagedSummary: BillingSummary = {
	hosted: false,
	hasOrg: true,
	plan: "community",
	status: "none",
	state: "none",
	currentPeriodEnd: null,
	canManage: false,
	canManageBilling: false,
	cancelAtPeriodEnd: false,
	seats: null,
	memberCount: 1,
	unitAmount: money(0, "usd"),
};

/** Every bordered card the render draws. */
const cards = (root: ParentNode) => root.querySelectorAll('[data-slot="card"]');
/** Every placeholder bar the render draws. */
const placeholders = (root: ParentNode) => root.querySelectorAll('[data-slot="skeleton"]');

beforeEach(() => {
	resetReads();
	h.stripe = false;
});

describe("the org usage route's loading state (#6355, B2)", () => {
	describe("on a self-managed instance", () => {
		it("draws the page's single card and no placeholder bars", () => {
			const { container } = render(<UsageLoading />);
			expect(cards(container)).toHaveLength(1);
			expect(placeholders(container)).toHaveLength(0);
			expect(screen.getByText("Self-managed deployment")).toBeInTheDocument();
		});

		it("promises none of the hosted report — no gauge row, no toolbar, no sections", () => {
			const { container } = render(<UsageLoading />);
			// The gauge row was the two-blocks-side-by-side the gate measured against a one-column page.
			expect(container.querySelector('[class*="grid-cols"]')).toBeNull();
			expect(container.querySelectorAll("section")).toHaveLength(0);
		});

		it("still says it is loading", () => {
			const { container } = render(<UsageLoading />);
			expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		});
	});

	describe("on a hosted instance", () => {
		it("draws the report's skeleton — its four sections — and not the self-managed notice", () => {
			h.stripe = true;
			const { container } = render(<UsageLoading />);
			expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
			expect(container.querySelectorAll("section")).toHaveLength(4);
			expect(placeholders(container).length).toBeGreaterThan(0);
			expect(screen.queryByText("Self-managed deployment")).toBeNull();
		});
	});

	it("is the card the panel answers with on that instance, element for element", async () => {
		reads.summary.mockResolvedValue(selfManagedSummary);
		const panel = renderWithReads(<UsagePanel />);
		await screen.findByText("Self-managed deployment");
		const answered = cards(panel.container);
		expect(answered).toHaveLength(1);
		const loading = render(<UsageLoading />);
		const painted = cards(loading.container);
		expect(painted).toHaveLength(1);
		expect(painted[0]?.outerHTML).toBe(answered[0]?.outerHTML);
	});
});
