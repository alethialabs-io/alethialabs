// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the AI upgrade sheet's subscription intent. Stripe locks a subscription's currency at
// creation, so a currency switch creates a new intent. The old intent's client secret is dropped
// by the switch itself (an event handler), not by the effect that asks again: the render after the
// click must not still be offering the payment form for the old currency.
//
// #6906 (REL-L3): AI Plus and AI Max are sold behind the same gate as Pro. When the server says
// nothing is on sale, the paid tiers are disabled with the launch state's own sentence.
//
// #7324: choosing a tier first declares the payer and takes the billing address; the intent waits
// for both and carries the address. The two forms are stubbed here to submit a fixed declaration —
// their own fields are pinned in tests/billing/payer-declaration-form.test.tsx.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider-neutral checkout (Paddle L4) routes this instance to Stripe, so the sheet's existing
// Stripe flow below is what runs — as it did before the routing existed.
vi.mock("@/app/server/actions/checkout", () => ({
	checkoutRail: async () => ({ provider: "stripe" }),
	startCheckout: async () => ({ ok: true, data: { provider: "stripe" } }),
}));
import type { LaunchState } from "@repo/legal/launch";

type Intent = { clientSecret: string; currency: "usd" | "eur" };

const h = vi.hoisted(() => ({
	createAiSubscriptionIntent: vi.fn(),
	getAiUsageSummary: vi.fn(),
	salesOpen: vi.fn<() => Promise<{ open: boolean }>>(),
}));

// The launch state the sheet reads; the beforeEach puts back today's real one (closed).
const launch = vi.hoisted(() => {
	const holder: { paid: LaunchState } = { paid: { status: "closed", lapsedAnnouncement: null } };
	return holder;
});
vi.mock(import("@repo/legal/launch"), async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, paidLaunchState: () => ({ ...real.paidLaunchState(), paid: launch.paid }) };
});
vi.mock("@/lib/rpc/client", () => ({
	rpcClient: { billing: { salesOpen: () => h.salesOpen() } },
}));

vi.mock("@/app/server/actions/billing", () => ({
	createAiSubscriptionIntent: (...args: unknown[]) => h.createAiSubscriptionIntent(...args),
	getAiUsageSummary: () => h.getAiUsageSummary(),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: vi.fn(async () => ({ capacity: "organization", billingCountry: "US" })),
	payerConversionStatus: vi.fn(async () => ({ allowed: true })),
}));
const ADDRESS = { name: "Acme", line1: "1 Main St", city: "NYC", postalCode: "10001", country: "US", state: "NY" };
vi.mock("@/components/billing/payer-declaration-form", () => ({
	declaredPayerFacts: (d: unknown) => d,
	refusalActionFor: () => null,
	PayerDeclarationForm: ({ onDeclare }: { onDeclare: (d: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				onDeclare({
					capacity: "organization",
					billingCountry: "US",
					authorityAttestation: "CEO",
					vatIdStatus: null,
					vatId: null,
					billingState: "NY",
				})
			}
		>
			declare
		</button>
	),
	BillingAddressForm: ({ onSubmit }: { onSubmit: (a: unknown) => void }) => (
		<button type="button" onClick={() => onSubmit(ADDRESS)}>
			address
		</button>
	),
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { email: "owner@example.com" } }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	useParams: () => ({ org: "acme" }),
}));
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

/** Chooses AI Plus, then submits the stubbed declaration and address steps. */
async function chooseAndDeclare(): Promise<void> {
	fireEvent.click(await screen.findByRole("button", { name: "Upgrade to AI Plus" }));
	fireEvent.click(await screen.findByRole("button", { name: "declare" }));
	fireEvent.click(await screen.findByRole("button", { name: "address" }));
}

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
	h.salesOpen.mockReset();
	h.salesOpen.mockResolvedValue({ open: true });
	launch.paid = { status: "closed", lapsedAnnouncement: null };
});

describe("UpgradeAiSheet — the subscription intent", () => {
	it("drops the old currency's payment form the moment the currency switches", async () => {
		const usd = deferred<Intent>();
		const eur = deferred<Intent>();
		h.createAiSubscriptionIntent.mockReturnValueOnce(usd.promise).mockReturnValueOnce(eur.promise);

		render(<UpgradeAiSheet open onOpenChange={() => {}} />);
		await chooseAndDeclare();
		await act(async () => usd.resolve({ clientSecret: "cs_usd", currency: "usd" }));
		expect(screen.getByText("pay with cs_usd")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "switch to EUR" }));
		expect(screen.queryByText("pay with cs_usd")).toBeNull();
		// The provider routing (`startCheckout`) is asked first, so the intent follows a tick later.
		await waitFor(() =>
			expect(h.createAiSubscriptionIntent).toHaveBeenLastCalledWith("ai_plus", {
				currency: "eur",
				billingAddress: ADDRESS,
			}),
		);

		await act(async () => eur.resolve({ clientSecret: "cs_eur", currency: "eur" }));
		expect(screen.getByText("pay with cs_eur")).toBeTruthy();
	});

	it("a reopening never shows the previous opening's payment form, however the sheet was closed", async () => {
		const first = deferred<Intent>();
		const second = deferred<Intent>();
		h.createAiSubscriptionIntent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const { rerender } = render(<UpgradeAiSheet open onOpenChange={() => {}} />);
		await chooseAndDeclare();
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

describe("UpgradeAiSheet — the launch state (#6906)", () => {
	it("open: the paid tiers are offered", async () => {
		render(<UpgradeAiSheet open onOpenChange={() => {}} />);
		const plus = await screen.findByRole("button", { name: "Upgrade to AI Plus" });
		expect(plus).toBeEnabled();
		expect(screen.getByRole("button", { name: "Upgrade to AI Max" })).toBeEnabled();
	});

	it("closed: the paid tiers say they are not on sale and cannot be chosen", async () => {
		h.salesOpen.mockResolvedValue({ open: false });
		render(<UpgradeAiSheet open onOpenChange={() => {}} />);

		const buttons = await screen.findAllByRole("button", { name: "Not on sale yet" });
		expect(buttons).toHaveLength(2);
		for (const button of buttons) expect(button).toBeDisabled();
		expect(screen.queryByRole("button", { name: /Upgrade to AI/ })).toBeNull();
		expect(screen.queryByText("Coming soon")).toBeNull();
		expect(h.createAiSubscriptionIntent).not.toHaveBeenCalled();
	});

	it("announced: the disabled tiers name the promised date", async () => {
		launch.paid = { status: "announced", from: "2099-02-15" };
		h.salesOpen.mockResolvedValue({ open: false });
		render(<UpgradeAiSheet open onOpenChange={() => {}} />);

		const buttons = await screen.findAllByRole("button", {
			name: "Paid plans available from 15 Feb 2099",
		});
		expect(buttons).toHaveLength(2);
		for (const button of buttons) expect(button).toBeDisabled();
	});
});
