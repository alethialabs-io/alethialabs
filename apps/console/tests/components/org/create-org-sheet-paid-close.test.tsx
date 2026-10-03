// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — closing the create-a-team sheet after paying must not drop the payment.
//
// The sheet charges first and creates the org after. When the create (a slug claimed during payment)
// or the link then failed, the sheet showed a retry screen promising "you won't be charged again" —
// and closing it called `reset()`, which cleared the subscription and customer ids. The customer was
// left charged with no organization, and reopening the sheet started a NEW purchase.
//
// Now a close on that screen is confirmed first, and the pending setup is kept in the tab's
// sessionStorage so reopening resumes it on the retry screen, against the SAME subscription. Against
// the old sheet the first case fails at once: the Close button calls `onOpenChange(false)` and no
// confirmation ever renders.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isOrgSlugAvailable = vi.fn();
const createOrg = vi.fn();
const createIntent = vi.fn();
const linkSubscription = vi.fn();
const declarePayer = vi.fn();

vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: vi.fn(),
	createNewOrgSubscriptionIntent: (...a: unknown[]) => createIntent(...a),
	getProOffer: vi.fn().mockResolvedValue({ kind: "pay" }),
	isOrgSlugAvailable: (...a: unknown[]) => isOrgSlugAvailable(...a),
	linkSubscriptionToNewOrg: (...a: unknown[]) => linkSubscription(...a),
	setCustomerBillingAddress: vi.fn().mockResolvedValue(undefined),
	startProTrial: vi.fn(),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: (...a: unknown[]) => declarePayer(...a),
	payerConversionStatus: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			create: (...a: unknown[]) => createOrg(...a),
			delete: vi.fn().mockResolvedValue({}),
			inviteMember: vi.fn(),
		},
	},
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "user-1", email: "owner@example.com" } }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		pick({ fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// Stripe and the payer form are other screens' subjects. Each stand-in is one button that reports
// what the real component reports when the customer finishes it — in the real shapes, since those
// shapes are what is written to storage and validated on the way back.
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: ({ onDeclare }: { onDeclare: (d: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				onDeclare({
					capacity: "organization",
					billingCountry: "DE",
					authorityAttestation: "CTO",
				})
			}
		>
			Declare payer
		</button>
	),
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/billing/billing-checkout-form", () => ({
	billingAddressFrom: vi.fn(() => ({})),
	BillingCheckoutForm: ({ onPaid }: { onPaid: (b: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				onPaid({
					name: "Acme GmbH",
					line1: "Hauptstr. 1",
					city: "Berlin",
					postalCode: "10115",
					country: "DE",
					taxType: "eu_vat",
					taxValue: "",
					useAsPrimary: false,
				})
			}
		>
			Pay
		</button>
	),
}));
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { pendingPaidSetupKey } from "@/components/org/pending-paid-setup";

const KEY = pendingPaidSetupKey("user-1");

/** Name → declare → pay, ending on whichever retry screen the mocked create/link leads to. */
async function payAndFail(user: ReturnType<typeof userEvent.setup>, onOpenChange = vi.fn()) {
	const view = render(<CreateOrgSheet open onOpenChange={onOpenChange} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
	await user.click(await screen.findByRole("button", { name: "Declare payer" }));
	await user.click(await screen.findByRole("button", { name: "Pay" }));
	await screen.findByText(/your payment went through/i);
	return view;
}

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
	isOrgSlugAvailable.mockResolvedValue(true);
	createIntent.mockResolvedValue({
		subscriptionId: "sub_1",
		customerId: "cus_1",
		clientSecret: "pi_secret",
		currency: "eur",
	});
	linkSubscription.mockResolvedValue(undefined);
	declarePayer.mockResolvedValue(undefined);
	// The slug was free at Continue; another team created `acme-cloud` while this one paid.
	createOrg.mockImplementation(async ({ slug }: { slug: string }) =>
		slug === "acme-cloud"
			? { data: null, error: { message: "Organization already exists" } }
			: { data: { id: "org-new", slug }, error: null },
	);
});

afterEach(() => {
	window.sessionStorage.clear();
});

describe("CreateOrgSheet — closing an unfinished paid setup", () => {
	it("asks before closing, and 'Finish setup now' goes back to the retry", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		await payAndFail(user, onOpenChange);

		await user.click(screen.getByRole("button", { name: "Close" }));

		expect(screen.getByText(/close before your team is set up/i)).toBeInTheDocument();
		expect(screen.getByText(/won.t be charged again/i)).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /finish setup now/i }));
		expect(screen.getByLabelText("Team URL")).toHaveValue("acme-cloud");
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("'Close for now' closes, and reopening resumes on the SAME subscription — no second intent", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const first = await payAndFail(user, onOpenChange);

		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(screen.getByRole("button", { name: /close for now/i }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(window.sessionStorage.getItem(KEY)).toContain("sub_1");

		// The sheet's parent may unmount it on close; a fresh mount is the harder case.
		first.unmount();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		expect(await screen.findByText(/your payment went through/i)).toBeInTheDocument();
		const field = screen.getByLabelText("Team URL");
		expect(field).toHaveValue("acme-cloud");
		await user.clear(field);
		await user.type(field, "acmecloud");
		await user.click(screen.getByRole("button", { name: /complete setup/i }));

		await vi.waitFor(() =>
			expect(linkSubscription).toHaveBeenCalledWith(
				expect.objectContaining({
					orgId: "org-new",
					subscriptionId: "sub_1",
					customerId: "cus_1",
				}),
			),
		);
		expect(createOrg).toHaveBeenLastCalledWith({ name: "Acme Cloud", slug: "acmecloud" });
		expect(declarePayer).toHaveBeenCalledWith(
			{ capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
			{ orgId: "org-new" },
		);
		expect(createIntent).toHaveBeenCalledTimes(1);
		// Linked: nothing is left to resume.
		expect(window.sessionStorage.getItem(KEY)).toBeNull();
	});

	it("resumes a failed LINK by linking the org already created, not by creating another", async () => {
		createOrg.mockResolvedValue({ data: { id: "org-made", slug: "acme-cloud" }, error: null });
		linkSubscription.mockRejectedValueOnce(new Error("Stripe is unavailable"));
		const user = userEvent.setup();
		const first = await payAndFail(user);

		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(screen.getByRole("button", { name: /close for now/i }));
		first.unmount();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await user.click(await screen.findByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(linkSubscription).toHaveBeenCalledTimes(2));
		expect(linkSubscription).toHaveBeenLastCalledWith(
			expect.objectContaining({ orgId: "org-made", subscriptionId: "sub_1" }),
		);
		expect(createOrg).toHaveBeenCalledTimes(1);
		expect(createIntent).toHaveBeenCalledTimes(1);
	});

	it("does not link twice when the declaration failed AFTER the link", async () => {
		createOrg.mockResolvedValue({ data: { id: "org-made", slug: "acme-cloud" }, error: null });
		declarePayer.mockRejectedValueOnce(new Error("legal store is down"));
		const user = userEvent.setup();
		await payAndFail(user);

		await user.click(screen.getByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(2));
		expect(linkSubscription).toHaveBeenCalledTimes(1);
	});

	it("asks the browser to confirm leaving the page while the setup is unfinished", async () => {
		const user = userEvent.setup();
		await payAndFail(user);

		const event = new Event("beforeunload", { cancelable: true });
		act(() => {
			window.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores a stored record that does not parse, and starts at the name step", async () => {
		window.sessionStorage.setItem(KEY, JSON.stringify({ subscriptionId: "sub_x" }));
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByLabelText(/team name/i)).toBeInTheDocument();
		expect(screen.queryByText(/your payment went through/i)).not.toBeInTheDocument();
	});
});
