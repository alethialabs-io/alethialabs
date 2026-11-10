// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the AI upgrade sheet's subscription intent. Stripe locks a subscription's currency at
// creation, so a currency switch creates a new intent. The old intent's client secret is dropped
// by the switch itself (an event handler), not by the effect that asks again: the render after the
// click must not still be offering the payment form for the old currency.

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Intent = { clientSecret: string; currency: "usd" | "eur" };

const h = vi.hoisted(() => ({
	createAiSubscriptionIntent: vi.fn(),
	getAiUsageSummary: vi.fn(),
}));

vi.mock("@/app/server/actions/billing", () => ({
	createAiSubscriptionIntent: (...args: unknown[]) => h.createAiSubscriptionIntent(...args),
	getAiUsageSummary: () => h.getAiUsageSummary(),
	saveTaxId: vi.fn(),
	updateBillingAddress: vi.fn(),
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { email: "owner@example.com" } }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/billing/billing-checkout-form", () => ({
	billingAddressFrom: vi.fn(),
	BillingCheckoutForm: ({ clientSecret }: { clientSecret: string }) => <p>pay with {clientSecret}</p>,
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/billing/currency-toggle", () => ({
	CurrencyToggle: ({ onChange }: { onChange: (c: "eur") => void }) => (
		<button type="button" onClick={() => onChange("eur")}>
			switch to EUR
		</button>
	),
}));

import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";

/** A promise the test settles by hand. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	h.createAiSubscriptionIntent.mockReset();
	h.getAiUsageSummary.mockResolvedValue({ tier: "ai_free", paidTiersEnabled: true });
});

describe("UpgradeAiSheet — the subscription intent", () => {
	it("drops the old currency's payment form the moment the currency switches", async () => {
		const usd = deferred<Intent>();
		const eur = deferred<Intent>();
		h.createAiSubscriptionIntent.mockReturnValueOnce(usd.promise).mockReturnValueOnce(eur.promise);

		render(<UpgradeAiSheet open onOpenChange={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Upgrade to AI Plus" }));
		await act(async () => usd.resolve({ clientSecret: "cs_usd", currency: "usd" }));
		expect(screen.getByText("pay with cs_usd")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "switch to EUR" }));
		expect(screen.queryByText("pay with cs_usd")).toBeNull();
		expect(h.createAiSubscriptionIntent).toHaveBeenLastCalledWith("ai_plus", { currency: "eur" });

		await act(async () => eur.resolve({ clientSecret: "cs_eur", currency: "eur" }));
		expect(screen.getByText("pay with cs_eur")).toBeTruthy();
	});

	it("a reopening never shows the previous opening's payment form, however the sheet was closed", async () => {
		const first = deferred<Intent>();
		const second = deferred<Intent>();
		h.createAiSubscriptionIntent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const { rerender } = render(<UpgradeAiSheet open onOpenChange={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Upgrade to AI Plus" }));
		await act(async () => first.resolve({ clientSecret: "cs_first", currency: "usd" }));
		expect(screen.getByText("pay with cs_first")).toBeTruthy();

		// The PARENT closes and reopens it, without going through the sheet's own close.
		rerender(<UpgradeAiSheet open={false} onOpenChange={() => {}} />);
		rerender(<UpgradeAiSheet open onOpenChange={() => {}} />);
		expect(screen.queryByText("pay with cs_first")).toBeNull();

		await act(async () => second.resolve({ clientSecret: "cs_second", currency: "usd" }));
		expect(screen.getByText("pay with cs_second")).toBeTruthy();
	});
});

