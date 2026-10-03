// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — closing the create-a-team sheet after paying must not drop the payment.
//
// The sheet charges first and creates the org after. When the create (a slug claimed during payment)
// or the link then failed, the sheet showed a retry screen promising "you won't be charged again" —
// and closing it called `reset()`, which cleared the subscription and customer ids. The customer was
// left charged with no organization, and reopening the sheet started a NEW purchase.
//
// Now the pending setup is written to the tab's sessionStorage the moment the charge is confirmed,
// rewritten after each post-payment step, and cleared only after the last one (the payer declaration).
// Every close while it exists — the steps still running, or one of them failed — is confirmed first,
// and reopening resumes at the first unfinished step against the SAME subscription and the SAME org.
// Against 77f0e9a95 the first case fails at once (no confirmation renders); against 5a9b069e6 the last
// three fail (a close mid-run, a close after a post-link failure, and a close mid-retry).

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

/** The shape `authClient.organization.create` resolves with. */
type CreateResult = {
	data: { id: string; slug: string } | null;
	error: { message: string; code?: string } | null;
};

/** A promise the test settles by hand — how a step is held "in flight" across a close. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Name → declare → pay, stopping as soon as the charge is confirmed (the steps may still be running). */
async function pay(user: ReturnType<typeof userEvent.setup>, onOpenChange = vi.fn()) {
	const view = render(<CreateOrgSheet open onOpenChange={onOpenChange} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
	await user.click(await screen.findByRole("button", { name: "Declare payer" }));
	await user.click(await screen.findByRole("button", { name: "Pay" }));
	return view;
}

/** The stored record, parsed — what a reopened sheet will resume from. */
function stored(): { createdOrgId: string | null; linked: boolean; declaration: unknown } | null {
	const raw = window.sessionStorage.getItem(KEY);
	return raw ? JSON.parse(raw) : null;
}

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

	// The three below are the review's blockers on 5a9b069e6, each reproduced against it.

	it("a close WHILE the first setup is in flight is confirmed; a create that then fails resumes on reopen — no second purchase", async () => {
		const held = deferred<CreateResult>();
		createOrg.mockReturnValueOnce(held.promise);
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const first = await pay(user, onOpenChange);
		await vi.waitFor(() => expect(createOrg).toHaveBeenCalledTimes(1));

		// The record exists from the moment the charge was confirmed — before the create returned.
		expect(stored()).toMatchObject({ createdOrgId: null, linked: false });

		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByText(/setup is still running/i)).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /close for now/i }));
		expect(onOpenChange).toHaveBeenCalledWith(false);

		await act(async () => {
			held.resolve({ data: null, error: { message: "network unreachable" } });
		});
		expect(stored()).toMatchObject({ createdOrgId: null, linked: false });

		first.unmount();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByText(/couldn.t finish setting up/i)).toBeInTheDocument();
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-cloud" }, error: null });
		await user.click(screen.getByRole("button", { name: /complete setup/i }));

		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(linkSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-new", subscriptionId: "sub_1", customerId: "cus_1" }),
		);
		expect(createIntent).toHaveBeenCalledTimes(1);
		expect(stored()).toBeNull();
	});

	it("a declaration that fails AFTER the link: close, reopen, and it resumes at the declaration with the typed attestation", async () => {
		createOrg.mockResolvedValue({ data: { id: "org-made", slug: "acme-cloud" }, error: null });
		declarePayer.mockRejectedValueOnce(new Error("legal store is down"));
		const user = userEvent.setup();
		const first = await payAndFail(user);

		// Linked, not declared: the record is still there, and it says so.
		expect(stored()).toMatchObject({
			createdOrgId: "org-made",
			linked: true,
			declaration: { authorityAttestation: "CTO" },
		});

		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByText(/picks up at the step that has not finished/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /close for now/i }));
		first.unmount();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await user.click(await screen.findByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(2));
		expect(declarePayer).toHaveBeenLastCalledWith(
			{ capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
			{ orgId: "org-made" },
		);
		expect(linkSubscription).toHaveBeenCalledTimes(1);
		expect(createOrg).toHaveBeenCalledTimes(1);
		expect(createIntent).toHaveBeenCalledTimes(1);
		expect(stored()).toBeNull();
	});

	it("a close while a RETRY is in flight is confirmed, and the reopened sheet attaches to it — never a second org", async () => {
		// First run: the create fails outright, so the record has no org yet.
		createOrg.mockResolvedValueOnce({ data: null, error: { message: "network unreachable" } });
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const first = await payAndFail(user, onOpenChange);

		// The retry's create is held in flight; when it lands, the link after it fails.
		const held = deferred<CreateResult>();
		createOrg.mockReturnValueOnce(held.promise);
		linkSubscription.mockRejectedValueOnce(new Error("Stripe is unavailable"));
		await user.click(screen.getByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(createOrg).toHaveBeenCalledTimes(2));

		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByText(/setup is still running/i)).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /close for now/i }));

		first.unmount();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		// Attached to the run still in flight: no button to start a second one beside it.
		expect(await screen.findByRole("button", { name: /finishing/i })).toBeDisabled();

		await act(async () => {
			held.resolve({ data: { id: "org-made", slug: "acme-cloud" }, error: null });
		});
		expect(await screen.findByText(/couldn.t finish setting up/i)).toBeInTheDocument();
		expect(stored()).toMatchObject({ createdOrgId: "org-made", linked: false });

		await user.click(screen.getByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(linkSubscription).toHaveBeenLastCalledWith(
			expect.objectContaining({ orgId: "org-made", subscriptionId: "sub_1" }),
		);
		expect(createOrg).toHaveBeenCalledTimes(2);
		expect(createIntent).toHaveBeenCalledTimes(1);
		expect(stored()).toBeNull();
	});
});
