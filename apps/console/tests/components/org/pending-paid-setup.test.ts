// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the pending paid-setup record when the tab's storage is unavailable.
//
// A private window or blocked site data makes sessionStorage throw. The record is then held in a
// module-level copy, so closing (and unmounting) the create-a-team sheet still does not lose the
// charge it refers to; a reload does, which the file header and the close confirmation both state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
	resolveNewOrgSetup: vi.fn(),
	linkSubscriptionToNewOrg: vi.fn(),
	saveNewOrgSetupDetails: vi.fn(),
	setCustomerBillingAddress: vi.fn(),
	attachTaxIdToCustomer: vi.fn(),
	declarePayer: vi.fn(),
	createOrg: vi.fn(),
	toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: (...a: unknown[]) => actions.attachTaxIdToCustomer(...a),
	findUnfinishedNewOrgSetup: vi.fn(),
	linkSubscriptionToNewOrg: (...a: unknown[]) => actions.linkSubscriptionToNewOrg(...a),
	resolveNewOrgSetup: (...a: unknown[]) => actions.resolveNewOrgSetup(...a),
	saveNewOrgSetupDetails: (...a: unknown[]) => actions.saveNewOrgSetupDetails(...a),
	setCustomerBillingAddress: (...a: unknown[]) => actions.setCustomerBillingAddress(...a),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: (...a: unknown[]) => actions.declarePayer(...a),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({
	authClient: { organization: { create: (...a: unknown[]) => actions.createOrg(...a) } },
}));
vi.mock("sonner", () => ({ toast: actions.toast }));

import {
	finishPaidSetup,
	type PaidSetupOutcome,
	type PendingPaidSetup,
	pendingPaidSetupKey,
	pendingPaidSetupInPageOnly,
	pollSettlingPlanState,
	readPendingPaidSetup,
	readStoredPaidSetup,
	UNATTENDED_FAILURE,
	UNATTENDED_SLUG_REFUSAL,
	watchPaidSetup,
	writePendingPaidSetup,
} from "@/components/org/pending-paid-setup";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";
import type { OpenPaymentHoldState } from "@/lib/db/schema/payment-holds";

const record: PendingPaidSetup = {
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
	createdOrgId: "org-1",
	createdSlug: "acme-cloud",
	linked: true,
	slugRefusal: null,
};

afterEach(() => {
	vi.restoreAllMocks();
	window.sessionStorage.clear();
});

describe("pending paid setup — storage", () => {
	it("round-trips through sessionStorage, attestation included", () => {
		writePendingPaidSetup("user-1", record);
		expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-1"))).toContain("CTO");
		expect(readPendingPaidSetup("user-1")).toEqual(record);
		expect(readPendingPaidSetup("user-2")).toBeNull();
	});

	it("keeps the record in the page when storage throws", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		writePendingPaidSetup("user-3", record);
		expect(readPendingPaidSetup("user-3")).toEqual(record);
	});

	it("prefers the NEWER in-page copy over an older sessionStorage copy (a later write that threw)", () => {
		const older = { ...record, createdOrgId: null, linked: false };
		writePendingPaidSetup("user-4", older);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		writePendingPaidSetup("user-4", record);
		// sessionStorage still holds the older copy, without the org; the read must not return it.
		expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-4"))).toContain('"createdOrgId":null');
		expect(readPendingPaidSetup("user-4")).toEqual(record);
		expect(pendingPaidSetupInPageOnly("user-4")).toBe(true);
	});

	it("a record that no longer parses still gives up the ids of the charge, for the server to resume", () => {
		window.sessionStorage.setItem(
			pendingPaidSetupKey("user-5"),
			JSON.stringify({ subscriptionId: "sub_5", customerId: "cus_5", schemaFrom: "the future" }),
		);
		expect(readStoredPaidSetup("user-5")).toEqual({
			kind: "unreadable",
			ids: { subscriptionId: "sub_5", customerId: "cus_5" },
		});
		window.sessionStorage.setItem(pendingPaidSetupKey("user-6"), "{not json");
		expect(readStoredPaidSetup("user-6")).toEqual({ kind: "unreadable", ids: null });
	});

	it("writes and reads nothing without a user id", () => {
		expect(writePendingPaidSetup("", record)).toBe(false);
		expect(window.sessionStorage.length).toBe(0);
		expect(readPendingPaidSetup("")).toBeNull();
	});
});

// ADR 0002 §5.6, the sheet (S10). Each case runs the real `finishPaidSetup` with the server actions
// mocked, as the ADR's S† column states.

const RUN_USER = "user-run";

/** A paid setup this tab holds: no org yet unless `orgId` is given, and not linked. */
function runRecord(subscriptionId: string, orgId: string | null = null): PendingPaidSetup {
	return {
		...record,
		subscriptionId,
		customerDetailsSaved: false,
		createdOrgId: orgId,
		createdSlug: orgId ? "acme-cloud" : "",
		linked: false,
	};
}

/** What the resume lookup answers: an org or none, not linked, and the open hold it reports. */
function lookup(
	subscriptionId: string,
	opts: { org?: boolean; hold?: OpenPaymentHoldState | null; notice?: string } = {},
): NewOrgSetupState {
	return {
		subscriptionId,
		customerId: "cus_1",
		paid: true,
		planState: "confirming",
		paymentUrl: null,
		hold: opts.hold ? { state: opts.hold, notice: opts.notice ?? `notice for ${opts.hold}` } : null,
		org: opts.org ? { id: "org-1", slug: "acme-cloud" } : null,
		linked: false,
		declared: false,
		name: "Acme Cloud",
		slug: "acme-cloud",
		billing: null,
		currency: "eur",
	};
}

const runHooks = { onProgress: vi.fn(), fetchWorkspace: vi.fn(async () => undefined) };

/** True when the server was asked to write anything, or the org was created: what a stop must not do. */
function wroteAnything(): boolean {
	return [
		actions.createOrg,
		actions.linkSubscriptionToNewOrg,
		actions.saveNewOrgSetupDetails,
		actions.setCustomerBillingAddress,
		actions.attachTaxIdToCustomer,
		actions.declarePayer,
	].some((fn) => fn.mock.calls.length > 0);
}

/** Every sentence a run's outcome or its toasts carried — what C32 reads. */
function saidBy(outcome: PaidSetupOutcome): string[] {
	const toasts = Object.values(actions.toast).flatMap((fn) =>
		fn.mock.calls.map((c: unknown[]) => String(c[0])),
	);
	return outcome.kind === "done" ? toasts : [outcome.message, ...toasts];
}

const REFUSING: OpenPaymentHoldState[] = [
	"payment_in_flight",
	"invoice_payable",
	"refund_due",
	"refund_pending",
	"needs_operator",
];

describe("the sheet stops where the link would refuse (ADR 0002 S10)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.sessionStorage.clear();
		actions.saveNewOrgSetupDetails.mockResolvedValue({ ok: true });
		actions.setCustomerBillingAddress.mockResolvedValue(undefined);
		actions.attachTaxIdToCustomer.mockResolvedValue(undefined);
		actions.declarePayer.mockResolvedValue(undefined);
		actions.createOrg.mockResolvedValue({ data: { id: "org-1", slug: "acme-cloud" }, error: null });
		actions.linkSubscriptionToNewOrg.mockResolvedValue({
			kind: "linked",
			planState: "active",
			paymentUrl: null,
		});
	});

	// C78: a `refund_due` hold, before the org exists.
	it("C78: a refund_due hold stops the run before the org is created, writes nothing, and clears the record", async () => {
		const sub = "sub_c78";
		actions.resolveNewOrgSetup.mockResolvedValue(
			lookup(sub, { hold: "refund_due", notice: "Its refund has not gone through yet." }),
		);

		const outcome = await finishPaidSetup(RUN_USER, runRecord(sub), runHooks);

		expect(outcome).toMatchObject({
			kind: "failed",
			retryable: false,
			recordCleared: true,
			message: "Its refund has not gone through yet.",
		});
		expect(actions.createOrg).not.toHaveBeenCalled();
		expect(wroteAnything()).toBe(false);
		expect(readStoredPaidSetup(RUN_USER)).toEqual({ kind: "none" });
	});

	// C78, rule 1 on a resume: the org already exists, and the stop still writes nothing.
	for (const state of REFUSING) {
		it(`C78: a ${state} hold stops a resume whose org exists, before the link, writing nothing`, async () => {
			const sub = `sub_resume_${state}`;
			actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub, { org: true, hold: state }));

			const outcome = await finishPaidSetup(RUN_USER, runRecord(sub, "org-1"), runHooks);

			expect(outcome).toMatchObject({
				kind: "failed",
				retryable: false,
				recordCleared: true,
				message: `notice for ${state}`,
			});
			expect(wroteAnything()).toBe(false);
			expect(readStoredPaidSetup(RUN_USER)).toEqual({ kind: "none" });
		});
	}

	// C78, the other half: a hold the link advances itself does not stop the run.
	const advancedByTheLink: OpenPaymentHoldState[] = ["closing", "cancel_unproven"];
	for (const state of advancedByTheLink) {
		it(`C78: a ${state} hold does not stop the run, which goes on to the link`, async () => {
			const sub = `sub_${state}`;
			actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub, { hold: state }));

			const outcome = await finishPaidSetup(RUN_USER, runRecord(sub), runHooks);

			expect(actions.createOrg).toHaveBeenCalledTimes(1);
			expect(actions.linkSubscriptionToNewOrg).toHaveBeenCalledTimes(1);
			expect(outcome).toMatchObject({ kind: "done", planState: "active" });
		});
	}

	// C57, the S half: the link's typed refusal.
	it("C57: a refused link ends failed, not retryable, with its clause, and clears the record", async () => {
		const sub = "sub_c57";
		const clause = "An earlier payment went through after that checkout was cancelled.";
		actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub));
		actions.linkSubscriptionToNewOrg.mockResolvedValue({ kind: "refused", clause });

		const outcome = await finishPaidSetup(RUN_USER, runRecord(sub), runHooks);

		expect(outcome).toMatchObject({ kind: "failed", retryable: false, recordCleared: true, message: clause });
		expect(readStoredPaidSetup(RUN_USER)).toEqual({ kind: "none" });
		expect(actions.declarePayer).not.toHaveBeenCalled();
		expect(actions.toast.success).not.toHaveBeenCalled();
		expect(saidBy(outcome).join(" ")).not.toMatch(/Subscription active/);
	});

	it("C57: a run attached to a refused one returns that refusal and does not write the record back", async () => {
		const sub = "sub_c57_attached";
		actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub, { hold: "needs_operator" }));

		const first = finishPaidSetup(RUN_USER, runRecord(sub), runHooks);
		const second = finishPaidSetup(RUN_USER, runRecord(sub), runHooks);

		expect(await first).toMatchObject({ kind: "failed", recordCleared: true });
		expect(await second).toEqual(await first);
		expect(actions.resolveNewOrgSetup).toHaveBeenCalledTimes(1);
		expect(readStoredPaidSetup(RUN_USER)).toEqual({ kind: "none" });
	});

	// C79: only a thrown error is retryable, and its text promises nothing about charges.
	it("C79: a thrown link error is retryable, keeps the record, and does not say 'charged again'", async () => {
		const sub = "sub_c79";
		actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub));
		actions.linkSubscriptionToNewOrg.mockRejectedValue(new Error("fetch failed"));

		const outcome = await finishPaidSetup(RUN_USER, runRecord(sub), runHooks);

		expect(outcome).toMatchObject({ kind: "failed", retryable: true, recordCleared: false });
		expect(outcome.kind === "failed" && outcome.message).toMatch(/Retry to complete setup/);
		expect(saidBy(outcome).join(" ")).not.toMatch(/charged again/);
		expect(readStoredPaidSetup(RUN_USER).kind).toBe("ok");
	});

	// C32, the S half: no sheet outcome, watched or not, promises the customer will not be charged again.
	it("C32: no outcome or toast of the run says 'charged twice' or 'charged again'", async () => {
		const runs: Array<{ setup: NewOrgSetupState | null; link?: () => Promise<unknown> }> = [
			{ setup: lookup("sub_c32_a", { hold: "refund_pending" }) },
			{ setup: lookup("sub_c32_b"), link: async () => ({ kind: "refused", clause: "Refused." }) },
			{ setup: lookup("sub_c32_c"), link: async () => Promise.reject(new Error("outage")) },
			{ setup: null },
		];
		const said: string[] = [UNATTENDED_FAILURE, UNATTENDED_SLUG_REFUSAL];
		for (const [i, run] of runs.entries()) {
			vi.clearAllMocks();
			actions.saveNewOrgSetupDetails.mockResolvedValue({ ok: true });
			actions.createOrg.mockResolvedValue({ data: { id: "org-1", slug: "acme-cloud" }, error: null });
			actions.resolveNewOrgSetup.mockResolvedValue(run.setup);
			if (run.link) actions.linkSubscriptionToNewOrg.mockImplementation(run.link);
			// Unwatched, so the unattended toast is the one the customer reads.
			said.push(...saidBy(await finishPaidSetup(RUN_USER, runRecord(`sub_c32_${i}`), runHooks)));
		}
		expect(said.join(" ")).not.toMatch(/charged (twice|again)/i);
	});

	// The S1 review follow-up: a stale tab links an X whose setup the closer already closed. The link
	// answers with its report (the closer's `closed` is not a refusal), and the run finishes.
	it("a stale tab whose setup the server already closed finishes on the link's linked answer", async () => {
		const sub = "sub_stale";
		actions.resolveNewOrgSetup.mockResolvedValue(lookup(sub, { org: true }));
		actions.linkSubscriptionToNewOrg.mockResolvedValue({
			kind: "linked",
			planState: "processing",
			paymentUrl: null,
		});
		const unwatch = watchPaidSetup(sub);

		const outcome = await finishPaidSetup(RUN_USER, runRecord(sub, "org-1"), runHooks);
		unwatch();

		expect(outcome).toMatchObject({ kind: "done", orgId: "org-1", planState: "processing" });
		expect(actions.toast.error).not.toHaveBeenCalled();
	});
});

describe("the settling re-read stops on a reported hold (ADR 0002 §5.6)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops asking once the lookup reports an open hold, though the plan state still reads settling", async () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		actions.resolveNewOrgSetup.mockResolvedValue(lookup("sub_poll_hold", { org: true, hold: "closing" }));

		pollSettlingPlanState({ subscriptionId: "sub_poll_hold", customerId: "cus_1" }, "confirming", vi.fn(), {
			intervalMs: 3_000,
			timeoutMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(30_000);

		expect(actions.resolveNewOrgSetup).toHaveBeenCalledTimes(1);
	});
});
