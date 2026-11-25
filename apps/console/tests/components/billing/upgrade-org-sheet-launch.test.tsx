// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6906 (REL-L3) — the org upgrade sheet reads the launch state. The server's `billing.salesOpen`
// says whether a sale can be taken; `paidLaunchState()` says whether a date is promised, and the
// sentence for each comes from the shared launch copy. One test per state: open (the declaration),
// announced ("Pro is available from <date>"), closed ("Pro isn't on sale yet").
//
// Lives under tests/components/billing/ because the sheet's other tests sit in a directory another
// open unit owns; the sentences it checks are the billing launch copy.

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider-neutral checkout (Paddle L4) routes this instance to Stripe, so the sheet's existing
// Stripe flow below is what runs — as it did before the routing existed.
vi.mock("@/app/server/actions/checkout", () => ({
	checkoutRail: async () => ({ provider: "stripe" }),
	startCheckout: async () => ({ ok: true, data: { provider: "stripe" } }),
}));
import type { LaunchState } from "@repo/legal/launch";

const { salesOpen, declarePayer, payerConversionStatus, createSubscriptionIntent } = vi.hoisted(() => ({
	salesOpen: vi.fn<() => Promise<{ open: boolean }>>(),
	declarePayer: vi.fn(),
	payerConversionStatus: vi.fn(),
	createSubscriptionIntent: vi.fn(),
}));

// The launch state the sheet reads. Today's real state is closed; a test that needs a promised date
// swaps `paid` and the beforeEach puts it back.
const launch = vi.hoisted(() => {
	const holder: { paid: LaunchState } = { paid: { status: "closed", lapsedAnnouncement: null } };
	return holder;
});
vi.mock(import("@repo/legal/launch"), async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, paidLaunchState: () => ({ ...real.paidLaunchState(), paid: launch.paid }) };
});

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

import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";

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
	launch.paid = { status: "closed", lapsedAnnouncement: null };
});

describe("UpgradeOrgSheet — the launch state (#6906)", () => {
	it("closed: says Pro isn't on sale yet, with no date and no declaration form", async () => {
		salesOpen.mockResolvedValue({ open: false });
		renderOpen();

		expect(await screen.findByRole("heading", { name: "Pro isn't on sale yet" })).toBeVisible();
		expect(
			screen.getByText(
				"We can't take payment for Pro in any country yet. Hobby stays free, with no time limit.",
			),
		).toBeVisible();
		expect(screen.queryByText("Who is this purchase for?")).toBeNull();
	});

	it("announced: names the promised date instead, still with no declaration form", async () => {
		launch.paid = { status: "announced", from: "2099-02-15" };
		salesOpen.mockResolvedValue({ open: false });
		renderOpen();

		expect(
			await screen.findByRole("heading", { name: "Pro is available from 15 Feb 2099" }),
		).toBeVisible();
		expect(
			screen.getByText(
				"We can't take payment for Pro yet. Paid plans are available from 15 Feb 2099; Hobby stays free, with no time limit.",
			),
		).toBeVisible();
		expect(screen.queryByRole("heading", { name: "Pro isn't on sale yet" })).toBeNull();
		expect(screen.queryByText("Who is this purchase for?")).toBeNull();
		expect(screen.getByRole("link", { name: /Contact sales/ })).toBeVisible();
	});

	it("open: asks the payer, whatever the launch state would have said", async () => {
		launch.paid = { status: "announced", from: "2099-02-15" };
		salesOpen.mockResolvedValue({ open: true });
		renderOpen();

		expect(await screen.findByText("Who is this purchase for?")).toBeVisible();
		expect(screen.queryByRole("heading", { name: /Pro is available from/ })).toBeNull();
	});
});
