// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6132 — the upgrade sheet and the closed market.
//
// F030: `PAID_MARKETS` is empty by design, so the payer declaration ended in "not yet able to sell"
// for every customer, AFTER three fields. The sheet now asks `billing.salesOpen` once as it opens and
// says "Pro isn't on sale yet" up front when nothing is on sale; the release gate's waiver makes the
// same read answer open, so the declaration (and the real checkout behind it) stays reachable there.
// A failed read falls through to the declaration — the gate behind it is still the authority.
//
// F031: a refusal names the declaration it judged. Changing a declared fact must drop it.

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { salesOpen, declarePayer, payerConversionStatus, createSubscriptionIntent } = vi.hoisted(() => ({
	salesOpen: vi.fn<() => Promise<{ open: boolean }>>(),
	declarePayer: vi.fn(),
	payerConversionStatus: vi.fn(),
	createSubscriptionIntent: vi.fn(),
}));

vi.mock("@/lib/rpc/client", () => ({
	orpc: createTanstackQueryUtils({ billing: { salesOpen: () => salesOpen() } }),
}));
vi.mock("@/app/server/actions/billing", () => ({
	createSubscriptionIntent: (...args: unknown[]) => createSubscriptionIntent(...args),
	saveTaxId: vi.fn(),
	updateBillingAddress: vi.fn(),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: (...args: unknown[]) => declarePayer(...args),
	payerConversionStatus: (...args: unknown[]) => payerConversionStatus(...args),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: { inviteMember: vi.fn() } } }));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { email: "owner@example.com" } }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		pick({ fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/billing/billing-checkout-form", () => ({
	billingAddressFrom: vi.fn(),
	BillingCheckoutForm: () => null,
}));
vi.mock("@/components/billing/stripe-elements", () => ({ StripeElementsProvider: () => null }));
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: null, label: "$20" }),
}));
// The country picker is its own subject (packages/ui/tests/country-select.test.tsx); a native select
// stands in so a change of country is one event here.
vi.mock("@repo/ui/country-select", () => ({
	CountrySelect: ({ value, onChange }: { value: string; onChange: (code: string) => void }) => (
		<select aria-label="Billing country" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select a country</option>
			<option value="DE">Germany</option>
			<option value="FR">France</option>
		</select>
	),
}));

import { SALES_CLOSED_COPY, UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";

const REFUSAL = "Alethia is not yet able to sell to customers in this country in this capacity.";

/** Renders the open sheet under a fresh query client. */
function renderOpen() {
	const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	return render(
		<QueryClientProvider client={client}>
			<UpgradeOrgSheet open onOpenChange={vi.fn()} orgSlug="acme" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	declarePayer.mockResolvedValue(undefined);
	payerConversionStatus.mockResolvedValue({ allowed: false, reason: "market_closed", message: REFUSAL });
});

describe("UpgradeOrgSheet — Pro not on sale anywhere (F030)", () => {
	it("opens on the closed view: the plan, Contact sales, and no declaration form", async () => {
		salesOpen.mockResolvedValue({ open: false });
		renderOpen();

		expect(await screen.findByRole("heading", { name: SALES_CLOSED_COPY.heading })).toBeVisible();
		expect(screen.getByText(SALES_CLOSED_COPY.body)).toBeVisible();
		// The tier is named Hobby (D2-A), from the catalog.
		expect(SALES_CLOSED_COPY.body).toContain("Hobby stays free, with no time limit.");
		const sales = screen.getByRole("link", { name: /Contact sales/ });
		expect(sales).toHaveAttribute("href", expect.stringMatching(/\/contact\/sales$/));
		expect(sales).toHaveAttribute("target", "_blank");
		expect(screen.queryByText("Who is this purchase for?")).toBeNull();
		expect(screen.queryByRole("button", { name: /Continue to payment/ })).toBeNull();
		// No promise of a notification (an open question resolved conservatively).
		expect(screen.queryByText(/tell you when/i)).toBeNull();
		expect(salesOpen).toHaveBeenCalledTimes(1);
	});

	it("asks the payer when Pro is on sale (the release gate's waiver answers open)", async () => {
		salesOpen.mockResolvedValue({ open: true });
		renderOpen();

		expect(await screen.findByText("Who is this purchase for?")).toBeVisible();
		expect(screen.queryByRole("heading", { name: SALES_CLOSED_COPY.heading })).toBeNull();
	});

	it("falls through to the declaration when the read fails — the gate stays the authority", async () => {
		salesOpen.mockRejectedValue(new Error("network"));
		renderOpen();

		expect(await screen.findByText("Who is this purchase for?")).toBeVisible();
		expect(screen.queryByRole("heading", { name: SALES_CLOSED_COPY.heading })).toBeNull();
	});
});

describe("UpgradeOrgSheet — a refusal about a previous answer (F031)", () => {
	it("drops the refusal once the payer changes the country, and again the capacity", async () => {
		salesOpen.mockResolvedValue({ open: true });
		const user = userEvent.setup();
		renderOpen();

		await user.click(await screen.findByRole("radio", { name: /An individual/ }));
		await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), "DE");
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(await screen.findByText(REFUSAL)).toBeVisible();

		await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), "FR");
		expect(screen.queryByText(REFUSAL)).toBeNull();

		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(await screen.findByText(REFUSAL)).toBeVisible();
		await user.click(screen.getByRole("radio", { name: /An organization/ }));
		expect(screen.queryByText(REFUSAL)).toBeNull();
		expect(createSubscriptionIntent).not.toHaveBeenCalled();
	});
});
