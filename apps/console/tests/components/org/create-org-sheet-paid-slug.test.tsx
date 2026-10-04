// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — a slug claimed WHILE the customer pays must never leave a paying customer with nothing
// on screen.
//
// The org is created only after the card is confirmed (`handlePaid`). When the create then refused
// the slug, `createOrg` wrote the refusal to a field on the NAME step and returned null, and
// `handlePaid` returned with the customer still on the payment view — charged, and told nothing.
// The retry path could not have helped either: it re-ran the create with the same, colliding slug.
//
// The fix asks for a new slug in place. No new payment intent is involved, because the intent never
// carried the slug. Against the old sheet, the first case fails at its first `findBy` — nothing
// about the payment or the URL ever renders.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isOrgSlugAvailable = vi.fn();
const createOrg = vi.fn();
const createIntent = vi.fn();
const linkSubscription = vi.fn();
const declarePayer = vi.fn();

const findUnfinished = vi.fn();
const resolveSetup = vi.fn();

vi.mock("@/app/server/actions/billing", async () => {
	const fake = await import("./fake-new-org-server");
	return {
		attachTaxIdToCustomer: vi.fn(),
		findUnfinishedNewOrgSetup: (...a: unknown[]) => findUnfinished(...a),
		resolveNewOrgSetup: (input: { subscriptionId: string; customerId: string }) =>
			resolveSetup(input) ?? fake.fakeResolve(input),
		createNewOrgSubscriptionIntent: (...a: unknown[]) => createIntent(...a),
		getProOffer: vi.fn().mockResolvedValue({ kind: "pay" }),
		isOrgSlugAvailable: (...a: unknown[]) => isOrgSlugAvailable(...a),
		linkSubscriptionToNewOrg: fake.recordingLink((...a: unknown[]) => linkSubscription(...a)),
		setCustomerBillingAddress: vi.fn().mockResolvedValue(undefined),
		startProTrial: vi.fn(),
	};
});
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: (...a: unknown[]) => declarePayer(...a),
	payerConversionStatus: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
const inviteMember = vi.fn();

vi.mock("@/lib/auth/client", async () => {
	const fake = await import("./fake-new-org-server");
	return {
		authClient: {
			organization: {
				create: fake.recordingCreate((...a: unknown[]) => createOrg(...a)),
				delete: vi.fn().mockResolvedValue({}),
				inviteMember: (...a: unknown[]) => inviteMember(...a),
			},
		},
	};
});
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
// Stripe and the payer form are other screens' subjects. Each stand-in is one button that does
// what the real component reports when the customer finishes it.
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: ({ onDeclare }: { onDeclare: (d: unknown) => void }) => (
		<button
			type="button"
			onClick={() => onDeclare({ capacity: "organization", billingCountry: "DE" })}
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
			onClick={() => onPaid({ taxValue: "", taxType: "eu_vat", useAsPrimary: false })}
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
import { fakeServer } from "./fake-new-org-server";

const TAKEN = "That slug is taken — try another.";

/** Name → declare → pay, with the slug free at Continue and claimed at the create. */
async function payWithClaimedSlug(user: ReturnType<typeof userEvent.setup>) {
	render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
	await user.click(await screen.findByRole("button", { name: "Declare payer" }));
	await user.click(await screen.findByRole("button", { name: "Pay" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
	fakeServer.reset();
	findUnfinished.mockResolvedValue(null);
	resolveSetup.mockReturnValue(undefined);
	inviteMember.mockResolvedValue({ data: {}, error: null });
	isOrgSlugAvailable.mockResolvedValue(true);
	createIntent.mockResolvedValue({
		subscriptionId: "sub_1",
		customerId: "cus_1",
		clientSecret: "pi_secret",
		currency: "usd",
	});
	linkSubscription.mockResolvedValue({ planState: "active" });
	declarePayer.mockResolvedValue(undefined);
	// The slug was free at Continue; another team created `acme-cloud` while this one paid.
	createOrg.mockImplementation(async ({ slug }: { slug: string }) =>
		slug === "acme-cloud"
			? { data: null, error: { message: "Organization already exists" } }
			: { data: { id: "org-new", slug }, error: null },
	);
});

describe("CreateOrgSheet — a slug claimed during payment", () => {
	it("tells the paying customer, shows why under a URL field, and offers to finish", async () => {
		const user = userEvent.setup();
		await payWithClaimedSlug(user);

		expect(await screen.findByText(/your payment went through/i)).toBeInTheDocument();
		expect(screen.getByText(/won.t be charged/i)).toBeInTheDocument();
		const field = screen.getByLabelText("Team URL");
		expect(field).toHaveValue("acme-cloud");
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent(TAKEN);
		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(field).toHaveAttribute("aria-describedby", alert.id);
		expect(screen.getByRole("button", { name: /complete setup/i })).toBeEnabled();
		// Nothing was linked to an org that does not exist.
		expect(linkSubscription).not.toHaveBeenCalled();
	});

	it("finishes with the NEW slug on the same subscription — no second intent", async () => {
		const user = userEvent.setup();
		await payWithClaimedSlug(user);

		const field = await screen.findByLabelText("Team URL");
		await user.clear(field);
		// Typed, trailing dash and all: the field keeps a typed hyphen and trims the one left at the
		// end when the slug is submitted (#5453 — it used to have to be pasted).
		await user.type(field, "acme-cloud-eu-");
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
		expect(createOrg).toHaveBeenLastCalledWith({
			name: "Acme Cloud",
			slug: "acme-cloud-eu",
			metadata: { newOrgSubscriptionId: "sub_1" },
		});
		expect(createIntent).toHaveBeenCalledTimes(1);
	});

	it("keeps the customer on the retry when the new slug is refused too, saying why", async () => {
		const user = userEvent.setup();
		await payWithClaimedSlug(user);

		const field = await screen.findByLabelText("Team URL");
		await user.clear(field);
		await user.type(field, "docs");
		await user.click(screen.getByRole("button", { name: /complete setup/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"That slug is reserved — try another.",
		);
		expect(createOrg).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/your payment went through/i)).toBeInTheDocument();
	});
});
