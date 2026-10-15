// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0002 S10 — what the create-a-team sheet SHOWS for the purchase intent's notice and for a run
// that a hold or the link refused.
//
//   - The intent's `notice` (§5.5, the 2026-10-14 amendment to S10): shown above the payment form
//     when the intent carries one, and absent when it does not.
//   - A refused run (C57, C78, S half): its clause is the final answer. No "Complete setup" retry is
//     offered, the tab's record is gone, and closing needs no confirmation, because nothing is left
//     here to finish.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	createIntent: vi.fn(),
	resolveSetup: vi.fn(),
	linkSubscription: vi.fn(),
	createOrg: vi.fn(),
	findUnfinished: vi.fn(),
}));

vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: vi.fn().mockResolvedValue({ ok: true }),
	saveNewOrgSetupDetails: vi.fn().mockResolvedValue({ ok: true }),
	findUnfinishedNewOrgSetup: (...a: unknown[]) => m.findUnfinished(...a),
	resolveNewOrgSetup: (...a: unknown[]) => m.resolveSetup(...a),
	createNewOrgSubscriptionIntent: (...a: unknown[]) => m.createIntent(...a),
	getProOffer: vi.fn().mockResolvedValue({ kind: "pay" }),
	isOrgSlugAvailable: vi.fn().mockResolvedValue(true),
	linkSubscriptionToNewOrg: (...a: unknown[]) => m.linkSubscription(...a),
	setCustomerBillingAddress: vi.fn().mockResolvedValue(undefined),
	startProTrial: vi.fn(),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: vi.fn().mockResolvedValue(undefined),
	payerConversionStatus: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			create: (...a: unknown[]) => m.createOrg(...a),
			delete: vi.fn().mockResolvedValue({}),
			inviteMember: vi.fn(),
		},
	},
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "user-holds", email: "owner@example.com" } }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		pick({ fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// The payer form and Stripe are other screens' subjects: each stand-in is one button reporting what
// the real component reports, in the real shapes.
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: ({ onDeclare }: { onDeclare: (d: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				onDeclare({ capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" })
			}
		>
			Declare payer
		</button>
	),
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/billing/billing-checkout-form", async (importActual) => {
	const actual = await importActual<typeof import("@/components/billing/billing-checkout-form")>();
	return {
		billingAddressFrom: vi.fn(() => ({})),
		checkoutFieldOf: actual.checkoutFieldOf,
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
	};
});
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { toast } from "sonner";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { pendingPaidSetupKey } from "@/components/org/pending-paid-setup";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";

const NOTICE =
	"An earlier payment went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you. If you buy again now and that refund fails, you may see both charges until we have refunded it again.";

/** The resume lookup's answer for the charge: no org yet, and the hold it reports (or none). */
function lookup(hold: NewOrgSetupState["hold"]): NewOrgSetupState {
	return {
		subscriptionId: "sub_1",
		customerId: "cus_1",
		paid: true,
		planState: "confirming",
		paymentUrl: null,
		hold,
		ended: null,
		org: null,
		linked: false,
		declared: false,
		name: "Acme Cloud",
		slug: "acme-cloud",
		billing: null,
		currency: "eur",
	};
}

/** Name → declare, ending on the payment step. Returns the render, for a test that reopens the sheet. */
async function toPayment(user: ReturnType<typeof userEvent.setup>, onOpenChange = vi.fn()) {
	const view = render(<CreateOrgSheet open onOpenChange={onOpenChange} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
	await user.click(await screen.findByRole("button", { name: "Declare payer" }));
	await screen.findByRole("button", { name: "Pay" });
	return view;
}

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
	m.createIntent.mockResolvedValue({
		kind: "intent",
		subscriptionId: "sub_1",
		customerId: "cus_1",
		clientSecret: "pi_secret",
		currency: "eur",
	});
	m.resolveSetup.mockResolvedValue(lookup(null));
	m.findUnfinished.mockResolvedValue(null);
	m.createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-cloud" }, error: null });
	m.linkSubscription.mockResolvedValue({ kind: "linked", planState: "active", paymentUrl: null });
});

describe("CreateOrgSheet — the purchase intent's notice (ADR 0002 §5.5, S10 amendment)", () => {
	it("shows the notice above the payment form when the intent carries one", async () => {
		m.createIntent.mockResolvedValue({
			kind: "intent",
			subscriptionId: "sub_1",
			customerId: "cus_1",
			clientSecret: "pi_secret",
			currency: "eur",
			notice: NOTICE,
		});
		const user = userEvent.setup();
		await toPayment(user);

		const shown = screen.getByRole("alert");
		expect(shown).toHaveTextContent(NOTICE);
		// Above the payment form: it precedes the Pay control in document order.
		const pay = screen.getByRole("button", { name: "Pay" });
		expect(shown.compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows no notice when the intent carries none", async () => {
		const user = userEvent.setup();
		await toPayment(user);

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
	});
});

describe("CreateOrgSheet — a refused setup is final (ADR 0002 C57, C78)", () => {
	it("C78: a held setup shows the hold's clause, offers no retry, keeps no record, and closes without asking", async () => {
		const clause =
			"An earlier payment went through after that checkout was cancelled. Its refund has not gone through yet; nothing new can be started until it has.";
		m.resolveSetup.mockResolvedValue(lookup({ state: "refund_due", notice: clause }));
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		await toPayment(user, onOpenChange);
		await user.click(screen.getByRole("button", { name: "Pay" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(clause);
		expect(m.createOrg).not.toHaveBeenCalled();
		expect(m.linkSubscription).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /complete setup/i })).not.toBeInTheDocument();
		expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
		expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-holds"))).toBeNull();
		// Said once, in the panel, not again in a toast.
		expect(toast.error).not.toHaveBeenCalledWith(clause);

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(screen.queryByText(/close before your team is set up/i)).not.toBeInTheDocument();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("C57: the link's typed refusal shows its clause with no retry", async () => {
		const clause =
			"This team already has an active plan, so this payment was not linked to it. Contact support at support@alethialabs.io, who will refund it or move it to the right team.";
		m.linkSubscription.mockResolvedValue({ kind: "refused", clause });
		const user = userEvent.setup();
		await toPayment(user);
		await user.click(screen.getByRole("button", { name: "Pay" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(clause);
		expect(screen.queryByRole("button", { name: /complete setup/i })).not.toBeInTheDocument();
		expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-holds"))).toBeNull();
	});

	it("C79: a thrown error still offers the retry, without promising no second charge", async () => {
		m.linkSubscription.mockRejectedValue(new Error("fetch failed"));
		const user = userEvent.setup();
		await toPayment(user);
		await user.click(screen.getByRole("button", { name: "Pay" }));

		expect(await screen.findByText(/retry to complete setup/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /complete setup/i })).toBeInTheDocument();
		expect(screen.queryByText(/charged (again|twice)/i)).not.toBeInTheDocument();
	});
});

describe("CreateOrgSheet — a held setup is not offered to finish (ADR 0002 §5.6)", () => {
	it("opening the sheet with a paid setup under a needs_operator hold shows the hold's sentence and no declare step", async () => {
		const notice =
			"This team already has an active plan, so this payment was not linked to it. Contact support at support@alethialabs.io, who will refund it or move it to the right team.";
		m.findUnfinished.mockResolvedValue(lookup({ state: "needs_operator", notice }));
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		expect(await screen.findByRole("alert")).toHaveTextContent(notice);
		expect(screen.queryByRole("button", { name: "Declare payer" })).not.toBeInTheDocument();
		expect(screen.queryByText(/finish setting it up/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /complete setup/i })).not.toBeInTheDocument();
	});
});

describe("CreateOrgSheet — a stop for support is final (ADR 0002 §5.6 rule 4)", () => {
	it("a charge not tied to this account says so, closes without promising a resume, and reopens to the same sentence", async () => {
		m.resolveSetup.mockResolvedValue(null);
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		const view = await toPayment(user, onOpenChange);
		/** Re-renders the sheet open or closed, as its parent does. */
		const rerender = (open: boolean) =>
			view.rerender(<CreateOrgSheet open={open} onOpenChange={onOpenChange} />);
		await user.click(screen.getByRole("button", { name: "Pay" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(/isn't tied to this account/);
		expect(screen.queryByRole("button", { name: /complete setup/i })).not.toBeInTheDocument();

		// A final stop does not ask the browser to confirm leaving: nothing in this tab can finish it.
		const leaving = new Event("beforeunload", { cancelable: true });
		act(() => {
			window.dispatchEvent(leaving);
		});
		expect(leaving.defaultPrevented).toBe(false);

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(screen.queryByText(/picks up at the step/i)).not.toBeInTheDocument();
		expect(onOpenChange).toHaveBeenCalledWith(false);

		rerender(false);
		rerender(true);
		expect(await screen.findByRole("alert")).toHaveTextContent(/isn't tied to this account/);
		expect(screen.queryByText(/retry to complete setup/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /complete setup/i })).not.toBeInTheDocument();
	});
});

describe("CreateOrgSheet — a stop for support is checked again, not replayed", () => {
	it("a tab whose stored stop support has since fixed asks the server again and finishes the setup", async () => {
		const stale =
			"Your payment went through and a team was already created for it, but this account isn't in it. Contact support with the time of the payment.";
		window.sessionStorage.setItem(
			pendingPaidSetupKey("user-holds"),
			JSON.stringify({
				subscriptionId: "sub_1",
				customerId: "cus_1",
				name: "Acme Cloud",
				slug: "acme-cloud",
				currency: "eur",
				declaration: { capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
				billing: null,
				customerDetailsSaved: true,
				createdOrgId: null,
				createdSlug: "",
				linked: false,
				slugRefusal: null,
				stopped: stale,
			}),
		);
		// Support added this account to the team: the server now reports it as the caller's.
		m.resolveSetup.mockResolvedValue({ ...lookup(null), org: { id: "org-1", slug: "acme-cloud" } });
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await vi.waitFor(() => expect(m.linkSubscription).toHaveBeenCalledTimes(1));
		expect(m.resolveSetup).toHaveBeenCalled();
		expect(m.createOrg).not.toHaveBeenCalled();
		expect(screen.queryByText(stale)).not.toBeInTheDocument();
		await vi.waitFor(() =>
			expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-holds"))).toBeNull(),
		);
	});
});
