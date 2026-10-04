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

const findUnfinished = vi.fn();
const resolveSetup = vi.fn();
const attachTaxId = vi.fn();
const saveDetails = vi.fn();
const conversionStatus = vi.fn();
const updatePrimaryAddress = vi.fn();

vi.mock("@/app/server/actions/billing", async () => {
	const fake = await import("./fake-new-org-server");
	return {
		attachTaxIdToCustomer: (...a: unknown[]) => attachTaxId(...a),
		saveNewOrgSetupDetails: (...a: unknown[]) => saveDetails(...a),
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
	payerConversionStatus: (...a: unknown[]) => conversionStatus(...a),
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	updateOrgPrimaryAddress: (...a: unknown[]) => updatePrimaryAddress(...a),
}));
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
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// Stripe and the payer form are other screens' subjects. Each stand-in is one button that reports
// what the real component reports when the customer finishes it — in the real shapes, since those
// shapes are what is written to storage and validated on the way back. The payer form's stand-in
// also shows the refusal it is given, as the real one does.
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: ({
		onDeclare,
		refusal,
	}: {
		onDeclare: (d: unknown) => void;
		refusal: string | null;
	}) => (
		<>
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
			{refusal && <p role="alert">{refusal}</p>}
		</>
	),
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
/** What the stand-in checkout saw at the moment it "charged": whether the details had reached the server. */
const atCharge = { detailsSaved: false };
vi.mock("@/components/billing/billing-checkout-form", async (importActual) => {
	const actual = await importActual<typeof import("@/components/billing/billing-checkout-form")>();
	return {
		billingAddressFrom: vi.fn(() => ({})),
		checkoutFieldOf: actual.checkoutFieldOf,
		// Like the real form: `beforeConfirm` first, and a refusal stops the charge.
		BillingCheckoutForm: ({
			onPaid,
			beforeConfirm,
		}: {
			onPaid: (b: unknown) => void;
			beforeConfirm?: (b: unknown) => Promise<{ message: string } | null>;
		}) => {
			const billing = {
				name: "Acme GmbH",
				line1: "Hauptstr. 1",
				city: "Berlin",
				postalCode: "10115",
				country: "DE",
				taxType: "eu_vat",
				taxValue: "",
				useAsPrimary: false,
			};
			return (
				<button
					type="button"
					onClick={async () => {
						const refusal = beforeConfirm ? await beforeConfirm(billing) : null;
						if (refusal) return;
						atCharge.detailsSaved = saveDetails.mock.calls.length > 0;
						onPaid(billing);
					}}
				>
					Pay
				</button>
			);
		},
	};
});
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { fakeServer, orgCreatedButResponseLost } from "./fake-new-org-server";
import {
	pendingPaidSetupKey,
	UNATTENDED_FAILURE,
	UNATTENDED_SLUG_REFUSAL,
} from "@/components/org/pending-paid-setup";
import { toast } from "sonner";

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
	fakeServer.reset();
	findUnfinished.mockResolvedValue(null);
	resolveSetup.mockReturnValue(undefined);
	attachTaxId.mockResolvedValue({ ok: true });
	saveDetails.mockResolvedValue({ ok: true });
	conversionStatus.mockResolvedValue({ allowed: true });
	updatePrimaryAddress.mockResolvedValue(undefined);
	inviteMember.mockResolvedValue({ data: {}, error: null });
	window.sessionStorage.clear();
	isOrgSlugAvailable.mockResolvedValue(true);
	atCharge.detailsSaved = false;
	createIntent.mockResolvedValue({
		kind: "intent",
		subscriptionId: "sub_1",
		customerId: "cus_1",
		clientSecret: "pi_secret",
		currency: "eur",
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
		expect(createOrg).toHaveBeenLastCalledWith({
			name: "Acme Cloud",
			slug: "acmecloud",
			metadata: { newOrgSubscriptionId: "sub_1" },
		});
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

	it("a stored record that does not parse, with nothing unfinished on the server, starts at the name step — and says so", async () => {
		window.sessionStorage.setItem(KEY, JSON.stringify({ subscriptionId: "sub_x" }));
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByLabelText(/team name/i)).toBeInTheDocument();
		expect(screen.queryByText(/your payment went through/i)).not.toBeInTheDocument();
		await vi.waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/couldn.t read/i)),
		);
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

/** A record as it stands in storage mid-setup, for the tests that start from a reload. */
function record(over: Record<string, unknown>) {
	return {
		subscriptionId: "sub_1",
		customerId: "cus_1",
		name: "Acme Cloud",
		slug: "acme-cloud",
		currency: "eur",
		declaration: { capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
		billing: {
			name: "Acme GmbH",
			line1: "Hauptstr. 1",
			city: "Berlin",
			postalCode: "10115",
			country: "DE",
			taxType: "eu_vat",
			taxValue: "",
			useAsPrimary: false,
		},
		customerDetailsSaved: true,
		createdOrgId: null,
		createdSlug: "",
		linked: false,
		slugRefusal: null,
		...over,
	};
}

// The review's blockers on bb9c97124. The browser's record used to be the only account of how far
// the setup had got, so anything that happened on the server without the browser hearing of it —
// a create or a link whose response was lost — was invisible, and the resume acted on a false
// picture. Each case below fails against bb9c97124.
describe("CreateOrgSheet — the server, not the record, says how far a paid setup got", () => {
	it("a create whose response was lost (reload mid-create) is FOUND and reused — no second org, no new-URL ask", async () => {
		// The server committed the org; the browser reloaded before the response, so its record
		// still says "no org yet".
		orgCreatedButResponseLost("sub_1", { id: "org-first", slug: "acme-cloud" });
		window.sessionStorage.setItem(KEY, JSON.stringify(record({ createdOrgId: null })));
		// Were the sheet to create again, the slug would be "taken" — by the customer's own org.
		createOrg.mockResolvedValue({ data: null, error: { message: "Organization already exists" } });
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await user.click(await screen.findByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(createOrg).not.toHaveBeenCalled();
		expect(linkSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-first", subscriptionId: "sub_1" }),
		);
		expect(declarePayer).toHaveBeenCalledWith(expect.anything(), { orgId: "org-first" });
		expect(screen.queryByLabelText("Team URL")).not.toBeInTheDocument();
		expect(stored()).toBeNull();
	});

	it("a create refused as taken because the FIRST create landed meanwhile adopts that org instead of asking for a new URL", async () => {
		const user = userEvent.setup();
		// The pre-create check finds nothing; the create then collides with the customer's own org,
		// committed by a request whose response never arrived.
		resolveSetup.mockReturnValueOnce(
			Promise.resolve({
				subscriptionId: "sub_1",
				customerId: "cus_1",
				paid: true,
				org: null,
				linked: false,
				declared: false,
				name: "Acme Cloud",
				currency: "eur",
			}),
		);
		createOrg.mockImplementationOnce(async () => {
			orgCreatedButResponseLost("sub_1", { id: "org-first", slug: "acme-cloud" });
			return { data: null, error: { message: "Organization already exists" } };
		});
		await pay(user);

		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(createOrg).toHaveBeenCalledTimes(1);
		expect(linkSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-first" }),
		);
		expect(screen.queryByLabelText("Team URL")).not.toBeInTheDocument();
	});

	it("a link whose Stripe writes landed but whose response was lost is retried, and the retry completes", async () => {
		createOrg.mockResolvedValue({ data: { id: "org-made", slug: "acme-cloud" }, error: null });
		// The server linked the subscription, then the response was lost.
		linkSubscription.mockImplementationOnce(async () => {
			fakeServer.linked.set("sub_1", "org-made");
			throw new Error("Failed to fetch");
		});
		const user = userEvent.setup();
		await payAndFail(user);
		expect(stored()).toMatchObject({ createdOrgId: "org-made", linked: false });

		await user.click(screen.getByRole("button", { name: /complete setup/i }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		// Linked again — the server's link is idempotent for the same org, and this completes its
		// billing sync — and then declared.
		expect(linkSubscription).toHaveBeenCalledTimes(2);
		expect(createOrg).toHaveBeenCalledTimes(1);
		expect(stored()).toBeNull();
	});

	it.each([
		{
			name: "success",
			arrange: () => {},
			settle: { data: { id: "org-new", slug: "acme-cloud" }, error: null },
			expectToast: () =>
				expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/organization is ready/i)),
		},
		{
			name: "a slug refusal",
			arrange: () => {},
			settle: { data: null, error: { message: "Organization already exists" } },
			expectToast: () =>
				expect(toast.error).toHaveBeenCalledWith(UNATTENDED_SLUG_REFUSAL, expect.anything()),
		},
		{
			name: "a failure",
			arrange: () => linkSubscription.mockRejectedValueOnce(new Error("Stripe is unavailable")),
			settle: { data: { id: "org-new", slug: "acme-cloud" }, error: null },
			expectToast: () =>
				expect(toast.error).toHaveBeenCalledWith(UNATTENDED_FAILURE, expect.anything()),
		},
	])("a run that ends in $name after 'Close for now' says so in a toast", async ({ arrange, settle, expectToast }) => {
		arrange();
		const held = deferred<CreateResult>();
		createOrg.mockReturnValueOnce(held.promise);
		const user = userEvent.setup();
		await pay(user);
		await vi.waitFor(() => expect(createOrg).toHaveBeenCalledTimes(1));
		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(screen.getByRole("button", { name: /close for now/i }));

		await act(async () => {
			held.resolve(settle);
		});
		await vi.waitFor(expectToast);
	});

	it("an invite sent after a RESUMED setup names the org just made, not the session's active org", async () => {
		fakeServer.orgs.set("sub_1", { id: "org-made", slug: "acme-cloud" });
		fakeServer.linked.set("sub_1", "org-made");
		window.sessionStorage.setItem(
			KEY,
			JSON.stringify(record({ createdOrgId: "org-made", createdSlug: "acme-cloud", linked: true })),
		);
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await user.click(await screen.findByRole("button", { name: /complete setup/i }));
		await user.type(await screen.findByLabelText("Invite by email"), "dev@acme.test");
		await user.click(screen.getByRole("button", { name: /invite/i }));

		await vi.waitFor(() =>
			expect(inviteMember).toHaveBeenCalledWith(
				expect.objectContaining({ email: "dev@acme.test", organizationId: "org-made" }),
			),
		);
	});

	it("with NO record in this tab, a paid setup the server knows is resumed on the same subscription — never a new purchase", async () => {
		findUnfinished.mockResolvedValue({
			subscriptionId: "sub_9",
			customerId: "cus_9",
			paid: true,
			org: null,
			linked: false,
			declared: false,
			name: "Acme Cloud",
			slug: "acme-cloud",
			billing: null,
			currency: "eur",
		});
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-cloud" }, error: null });
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		expect(await screen.findByText(/we found a payment for a team/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Declare payer" }));

		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(createOrg).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "acme-cloud", metadata: { newOrgSubscriptionId: "sub_9" } }),
		);
		expect(linkSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ subscriptionId: "sub_9", customerId: "cus_9", orgId: "org-new" }),
		);
		expect(createIntent).not.toHaveBeenCalled();
	});

	// #5445: recovery used to drop everything typed at checkout — the tax id, "use as the team's
	// address" and a custom URL — because only the lost tab had them. The server's record keeps them.
	// Against 49030b809 the sheet ignored them: no tax id was sent and the team was created at the
	// slug derived from its name.
	it("a recovered setup restores the chosen URL, the tax id and the primary-address choice from the server's record", async () => {
		findUnfinished.mockResolvedValue({
			subscriptionId: "sub_9",
			customerId: "cus_9",
			paid: true,
			org: null,
			linked: false,
			declared: false,
			name: "Acme Cloud",
			slug: "acme-hq",
			billing: {
				name: "Acme GmbH",
				line1: "Hauptstr. 1",
				city: "Berlin",
				postalCode: "10115",
				country: "DE",
				taxType: "eu_vat",
				taxValue: "DE123456789",
				useAsPrimary: true,
			},
			currency: "eur",
		});
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-hq" }, error: null });
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		expect(await screen.findByLabelText("Team URL")).toHaveValue("acme-hq");
		expect(screen.queryByText(/tax id from checkout didn.t reach us/i)).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Declare payer" }));

		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(attachTaxId).toHaveBeenCalledWith({
			customerId: "cus_9",
			type: "eu_vat",
			value: "DE123456789",
		});
		expect(createOrg).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme-hq" }));
		await vi.waitFor(() =>
			expect(updatePrimaryAddress).toHaveBeenCalledWith(expect.anything(), "org-new"),
		);
		expect(createIntent).not.toHaveBeenCalled();
	});

	it("a recovered setup whose URL was taken since asks for another, with the reason, before anything runs", async () => {
		findUnfinished.mockResolvedValue({
			subscriptionId: "sub_9",
			customerId: "cus_9",
			paid: true,
			org: null,
			linked: false,
			declared: false,
			name: "Acme Cloud",
			slug: "acme-hq",
			billing: null,
			currency: "eur",
		});
		isOrgSlugAvailable.mockImplementation(async (slug: string) => slug !== "acme-hq");
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme2" }, error: null });
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		expect(await screen.findByText(/tax id from checkout didn.t reach us/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Declare payer" }));
		expect(await screen.findByText(/that slug is taken/i)).toBeInTheDocument();
		expect(createOrg).not.toHaveBeenCalled();

		const field = screen.getByLabelText("Team URL");
		await user.clear(field);
		await user.type(field, "acme2");
		await user.click(screen.getByRole("button", { name: "Declare payer" }));
		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(createOrg).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme2" }));
	});

	it("a recovered declaration is put to the same gate as a purchase; a refused one is said and nothing is declared", async () => {
		findUnfinished.mockResolvedValue({
			subscriptionId: "sub_9",
			customerId: "cus_9",
			paid: true,
			org: null,
			linked: false,
			declared: false,
			name: "Acme Cloud",
			slug: "acme-hq",
			billing: null,
			currency: "eur",
		});
		conversionStatus.mockResolvedValue({
			allowed: false,
			reason: "market_closed",
			message: "We can't sell to organizations in DE yet.",
		});
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);

		await user.click(await screen.findByRole("button", { name: "Declare payer" }));
		await vi.waitFor(() => expect(conversionStatus).toHaveBeenCalledTimes(1));
		expect(createOrg).not.toHaveBeenCalled();
		expect(declarePayer).not.toHaveBeenCalled();
	});

	it("when the server cannot be asked, the sheet says so — it does not read the failure as 'nothing to finish'", async () => {
		findUnfinished.mockRejectedValue(new Error("Stripe is unavailable"));
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await vi.waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/couldn.t check .* don.t pay again/i)),
		);
	});
});

describe("CreateOrgSheet — a charge the page never heard about is not replaced (#5445 review of 3aae22463)", () => {
	// Stripe took the payment, but `confirmCardPayment` reported an error (a dropped connection), so the
	// pay view stayed up with "← Back". Going back and declaring again sent the PAID subscription as
	// `priorSubscriptionId`; the server cancelled it with no refund and deleted its record. Now the server
	// answers `resume` for a paid prior, and the sheet finishes the setup on it. Against 3aae22463 the
	// sheet read that answer as a new intent: no org was created and nothing was linked.
	it("Back → declare again, and the server says the prior was PAID: the setup finishes on that charge — no second payment", async () => {
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
		const cont = screen.getByRole("button", { name: /continue/i });
		await vi.waitFor(() => expect(cont).toBeEnabled());
		await user.click(cont);
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });

		createIntent.mockResolvedValueOnce({
			kind: "resume",
			setup: {
				subscriptionId: "sub_1",
				customerId: "cus_1",
				paid: true,
				org: null,
				linked: false,
				declared: false,
				name: "Acme Cloud",
				slug: "acme",
				billing: null,
				currency: "eur",
			},
		});
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme" }, error: null });
		await user.click(screen.getByRole("button", { name: /back/i }));
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));

		await vi.waitFor(() => expect(declarePayer).toHaveBeenCalledTimes(1));
		expect(createIntent).toHaveBeenLastCalledWith(
			"team",
			expect.objectContaining({ priorSubscriptionId: "sub_1" }),
		);
		expect(createOrg).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: { newOrgSubscriptionId: "sub_1" } }),
		);
		expect(linkSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ subscriptionId: "sub_1", customerId: "cus_1", orgId: "org-new" }),
		);
		expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/won.t be charged again/i));
		expect(screen.queryByRole("button", { name: "Pay" })).not.toBeInTheDocument();
	});

	// #5455 advisory: the resume built the team from the FORM's name. After "← Back" the form can hold
	// a name other than the one the charge was taken under (and the Stripe customer carries), and the
	// team was created under that one. The server's name is used now.
	it("a paid prior is finished under the SERVER's name for it, not the form's", async () => {
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
		const cont = screen.getByRole("button", { name: /continue/i });
		await vi.waitFor(() => expect(cont).toBeEnabled());
		await user.click(cont);
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });

		createIntent.mockResolvedValueOnce({
			kind: "resume",
			setup: {
				subscriptionId: "sub_1",
				customerId: "cus_1",
				paid: true,
				org: null,
				linked: false,
				declared: false,
				name: "Acme Cloud GmbH",
				slug: "acme",
				billing: null,
				currency: "eur",
			},
		});
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-cloud" }, error: null });
		await user.click(screen.getByRole("button", { name: /back/i }));
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));

		await vi.waitFor(() => expect(createOrg).toHaveBeenCalled());
		expect(createOrg).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme Cloud GmbH" }));
		expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("Acme Cloud GmbH"));
	});

	// #5455 blocker: when the prior's payment may be under way, the server starts nothing and says why.
	// The previous head had no such answer; a reply without an intent opened the pay view on nothing.
	it("the server refuses to start a purchase beside a payment that may be under way: the reason is shown, nothing is paid or created", async () => {
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
		const cont = screen.getByRole("button", { name: /continue/i });
		await vi.waitFor(() => expect(cont).toBeEnabled());
		await user.click(cont);
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });

		const message = "An earlier payment on this checkout is still being processed, or could not be checked.";
		createIntent.mockResolvedValueOnce({ kind: "refused", message });
		await user.click(screen.getByRole("button", { name: /back/i }));
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));

		await vi.waitFor(() => expect(screen.queryByText(message)).toBeInTheDocument());
		expect(screen.queryByRole("button", { name: "Pay" })).not.toBeInTheDocument();
		expect(createOrg).not.toHaveBeenCalled();
	});

	// The details used to reach the server only in the first post-payment step, so a crash between the
	// charge and that step lost them. Against 3aae22463 nothing had been saved when the card was charged.
	it("the URL and the billing details reach the server BEFORE the card is charged", async () => {
		const user = userEvent.setup();
		await pay(user);
		await vi.waitFor(() => expect(createOrg).toHaveBeenCalled());
		expect(atCharge.detailsSaved).toBe(true);
		expect(saveDetails).toHaveBeenNthCalledWith(1, {
			subscriptionId: "sub_1",
			slug: "acme-cloud",
			billing: expect.objectContaining({ name: "Acme GmbH", line1: "Hauptstr. 1" }),
		});
	});

	it("a field the server refuses before the charge stops the charge — nothing is created", async () => {
		saveDetails.mockResolvedValueOnce({
			ok: false,
			refused: [{ field: "line1", message: "Use at most 200 characters." }],
		});
		const user = userEvent.setup();
		await pay(user);
		await new Promise((r) => setTimeout(r, 50));
		expect(createOrg).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(KEY)).toBeNull();
	});
});

describe("CreateOrgSheet — the plan state a finished paid setup shows (#5522)", () => {
	it("a link that reports 'not charged' reaches the final view as that state — not as active", async () => {
		createOrg.mockImplementation(async ({ slug }: { slug: string }) => ({
			data: { id: "org-new", slug },
			error: null,
		}));
		linkSubscription.mockResolvedValue({ planState: "not_charged", paymentUrl: null });
		const user = userEvent.setup();
		await pay(user);

		await screen.findByLabelText("Invite by email");
		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent("Not charged");
		expect(status).toHaveTextContent(/you were not charged/);
		expect(status).not.toHaveTextContent(/active/i);
	});

	it("a setup that finished while its payment was settling re-reads the server, and the badge flips to active", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			createOrg.mockImplementation(async ({ slug }: { slug: string }) => ({
				data: { id: "org-new", slug },
				error: null,
			}));
			// The link reads the subscription while its invoice is still settling; the server's next
			// answer (the fake resolve) says active, as Stripe would a few seconds later.
			linkSubscription.mockResolvedValue({ planState: "processing", paymentUrl: null });
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			await pay(user);

			const status = await screen.findByRole("status");
			expect(status).toHaveTextContent("Processing");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3_500);
			});
			await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Active"));
			expect(screen.getByRole("status")).toHaveTextContent(/Your Pro plan is active/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("an 'action needed' link carries Stripe's payment page through to the final view", async () => {
		createOrg.mockImplementation(async ({ slug }: { slug: string }) => ({
			data: { id: "org-new", slug },
			error: null,
		}));
		linkSubscription.mockResolvedValue({
			planState: "action_needed",
			paymentUrl: "https://invoice.stripe.com/i/acct_1/test_inv",
		});
		const user = userEvent.setup();
		await pay(user);

		const link = await screen.findByRole("link", { name: /complete the payment/i });
		expect(link).toHaveAttribute("href", "https://invoice.stripe.com/i/acct_1/test_inv");
	});
});
