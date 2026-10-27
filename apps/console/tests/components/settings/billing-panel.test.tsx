// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page panel (#6127). Its reads are GET procedures behind a fake transport (the REAL
// TanStack utils, ./billing-rpc-fake), its writes go through the real `useActionMutation`. Pins:
//   · error ≠ empty: a failed saved-cards read says so, where it used to render "No saved cards";
//   · a member without the billing permission gets one note and the billing-admin reads are never
//     made (they used to be made, refused, toasted, and left a skeleton up forever);
//   · cancel/resume go through the mutation contract;
//   · the AI tier is one linked row; the AI card lives on Usage only (#6133).

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { money } from "@repo/format";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/actions/result";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";
import type { AiUsageSummary } from "@/lib/rpc/procedures/usage";

const { cancelPlan, resumePlan, toast, fetchWorkspace } = vi.hoisted(() => ({
	cancelPlan: vi.fn<(raw: object) => Promise<ActionResult<{ ok: true }>>>(),
	resumePlan: vi.fn<(raw: object) => Promise<ActionResult<{ ok: true }>>>(),
	toast: { success: vi.fn(), error: vi.fn() },
	fetchWorkspace: vi.fn(),
}));

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./billing-rpc-fake")).fakeOrpc }));
vi.mock("@/app/server/actions/billing", () => ({
	cancelPlan,
	resumePlan,
	makeDefaultCard: vi.fn(),
	saveBackupCards: vi.fn(),
	removeCard: vi.fn(),
	startAddCard: vi.fn(),
	saveAiSpendLimits: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useParams: () => ({ org: "acme" }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (select: (s: { fetchWorkspace: () => void }) => unknown) => select({ fetchWorkspace }),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
vi.mock("@/components/billing/upgrade-ai-sheet", () => ({ UpgradeAiSheet: () => null }));
vi.mock("@/components/billing/credit-pack-dialog", () => ({ CreditPackDialog: () => null }));
vi.mock("@/components/billing/stripe-elements", () => ({ StripeElementsProvider: () => null }));
vi.mock("@/components/billing/payment-form", () => ({ PaymentForm: () => null }));

import { BillingPanel } from "@/components/settings/billing/billing-panel";
import { failed, reads, refused, renderWithReads, resetReads } from "./billing-rpc-fake";

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

const ai: AiUsageSummary = {
	enabled: true,
	tier: "ai_plus",
	sessionUsed: 40,
	sessionBudget: 200,
	sessionResetAt: null,
	weeklyUsed: 100,
	weeklyBudget: 1500,
	weeklyResetAt: "2100-01-01T00:00:00.000Z",
	purchasedBalance: 0,
	paidTiersEnabled: true,
	orgWeeklyCapCredits: null,
	perUserWeeklyCapCredits: null,
	canManageCaps: true,
};

beforeEach(() => {
	resetReads();
	cancelPlan.mockReset();
	resumePlan.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
	fetchWorkspace.mockReset();
	reads.ai.mockResolvedValue(ai);
	reads.liveAiPrices.mockRejectedValue(failed());
	reads.paymentMethods.mockResolvedValue([]);
	reads.planHistory.mockResolvedValue([]);
	reads.transactions.mockResolvedValue([]);
	reads.invoices.mockResolvedValue([]);
});

describe("BillingPanel", () => {
	it("a failed saved-cards read is an error with a retry — never 'No saved cards'", async () => {
		reads.summary.mockResolvedValue(summary());
		reads.paymentMethods.mockRejectedValue(failed());
		renderWithReads(<BillingPanel />);
		expect(await screen.findByText("Couldn't load saved cards")).toBeInTheDocument();
		expect(screen.queryByText(/No saved cards/)).toBeNull();
	});

	it("an empty saved-cards read IS 'No saved cards'", async () => {
		reads.summary.mockResolvedValue(summary());
		renderWithReads(<BillingPanel />);
		expect(await screen.findByText(/No saved cards/)).toBeInTheDocument();
	});

	it("a member without the billing permission gets one note, and the admin reads are never made", async () => {
		reads.summary.mockResolvedValue(summary({ canManageBilling: false }));
		renderWithReads(<BillingPanel />);
		expect(await screen.findByText("Billing admins only")).toBeInTheDocument();
		expect(screen.queryByText("Payment methods")).toBeNull();
		expect(screen.queryByText("Plan history")).toBeNull();
		expect(reads.paymentMethods).not.toHaveBeenCalled();
		expect(reads.planHistory).not.toHaveBeenCalled();
		expect(reads.transactions).not.toHaveBeenCalled();
		expect(reads.invoices).not.toHaveBeenCalled();
	});

	it("a failed summary is an error with a retry, not the skeleton forever", async () => {
		reads.summary.mockRejectedValue(failed());
		renderWithReads(<BillingPanel />);
		expect(await screen.findByText("Couldn't load billing")).toBeInTheDocument();
		expect(document.querySelector("[aria-busy='true']")).toBeNull();
	});

	it("a refused section renders as refused, distinct from its error", async () => {
		reads.summary.mockResolvedValue(summary());
		reads.planHistory.mockRejectedValue(refused("ENTITLEMENT_REQUIRED"));
		const { container } = renderWithReads(<BillingPanel />);
		await waitFor(() =>
			expect(container.querySelector("[data-state='refused'][data-refusal='plan']")).not.toBeNull(),
		);
		expect(screen.queryByText("Couldn't load plan history")).toBeNull();
	});

	// #6133, design decision A: Usage owns all of AI. Billing states the tier as ONE row on the plan
	// card and links to the Usage page's AI section; the AI card (meters, credits, spend limits) and
	// the cloud-spend note are not on this page.
	it("states the AI tier as one plan-card row linking to Usage — never the AI card itself", async () => {
		reads.summary.mockResolvedValue(summary());
		renderWithReads(<BillingPanel />);
		const row = await screen.findByTestId("billing-ai-plan-row");
		expect(await within(row).findByText("AI Plus")).toBeInTheDocument();
		expect(within(row).getByRole("link", { name: /usage & limits/i })).toHaveAttribute(
			"href",
			"/acme/~/usage#ai",
		);
		expect(screen.queryByText("AI plan & usage")).toBeNull();
		expect(screen.queryByText("Current session")).toBeNull();
		expect(screen.queryByText("Weekly limit")).toBeNull();
		expect(screen.queryByText("Spend limits")).toBeNull();
		expect(screen.queryByRole("button", { name: /upgrade ai plan/i })).toBeNull();
		expect(screen.queryByText(/billed separately/i)).toBeNull();
	});

	it("a failed AI read says so in the row and keeps the link to Usage", async () => {
		reads.summary.mockResolvedValue(summary());
		reads.ai.mockRejectedValue(failed());
		renderWithReads(<BillingPanel />);
		const row = await screen.findByTestId("billing-ai-plan-row");
		expect(await within(row).findByText("Couldn't load the AI plan")).toBeInTheDocument();
		expect(within(row).getByRole("link", { name: /usage & limits/i })).toBeInTheDocument();
	});

	it("cancelling goes through the dialog and the mutation contract, and confirms", async () => {
		reads.summary.mockResolvedValue(summary());
		cancelPlan.mockResolvedValue({ ok: true, data: { ok: true } });
		renderWithReads(<BillingPanel />);
		fireEvent.click(await screen.findByRole("button", { name: /cancel plan/i }));
		fireEvent.click(await screen.findByRole("button", { name: /confirm cancellation/i }));
		await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({}));
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Subscription will cancel at the period end."),
		);
		expect(fetchWorkspace).toHaveBeenCalled();
	});

	it("a refused cancel shows the server's sentence", async () => {
		reads.summary.mockResolvedValue(summary());
		cancelPlan.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "No active subscription." },
		});
		renderWithReads(<BillingPanel />);
		fireEvent.click(await screen.findByRole("button", { name: /cancel plan/i }));
		fireEvent.click(await screen.findByRole("button", { name: /confirm cancellation/i }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No active subscription."));
	});
});
