// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5522 — a finished paid create-a-team setup says what the SERVER reported about the plan.
//
// `runSteps` ended every paid setup with `toast.success("Subscription active — your organization is
// ready.")`, and the final view showed no plan state at all, whatever the subscription was: still
// settling, waiting on the bank, or closed before it was paid. Each state below is run through the real
// `finishPaidSetup` with the server actions mocked, and rendered through the real `InviteView`. On dev
// every non-active state got the "Subscription active" toast, the outcome carried no state, and the
// view showed none — so each case fails there.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveNewOrgSetup, linkSubscriptionToNewOrg, toast } = vi.hoisted(() => ({
	resolveNewOrgSetup: vi.fn(),
	linkSubscriptionToNewOrg: vi.fn(),
	toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: vi.fn(),
	findUnfinishedNewOrgSetup: vi.fn(),
	linkSubscriptionToNewOrg: (...a: unknown[]) => linkSubscriptionToNewOrg(...a),
	resolveNewOrgSetup: (...a: unknown[]) => resolveNewOrgSetup(...a),
	saveNewOrgSetupDetails: vi.fn(async () => ({ ok: true })),
	setCustomerBillingAddress: vi.fn(),
}));
vi.mock("@/app/server/actions/legal", () => ({ declarePayer: vi.fn(async () => undefined) }));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: { create: vi.fn() } } }));
vi.mock("sonner", () => ({ toast }));

import { InviteView } from "@/components/org/org-purchase-ui";
import {
	finishPaidSetup,
	type PendingPaidSetup,
	pollSettlingPlanState,
} from "@/components/org/pending-paid-setup";
import {
	actionNeededNextStep,
	NEW_ORG_PLAN_COPY,
	NEW_ORG_PLAN_STATES,
	type NewOrgPlanState,
} from "@/lib/billing/new-org-plan-state";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";

/** A paid setup whose org already exists and whose link has not landed yet. */
function record(subscriptionId: string, linked = false): PendingPaidSetup {
	return {
		subscriptionId,
		customerId: "cus_1",
		name: "Acme Cloud",
		slug: "acme-cloud",
		currency: "eur",
		declaration: { capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
		billing: null,
		customerDetailsSaved: true,
		createdOrgId: "org-1",
		createdSlug: "acme-cloud",
		linked,
		slugRefusal: null,
	};
}

/** What the server says about the setup: the org exists; linked or not; the plan state it read. */
function serverSays(
	subscriptionId: string,
	linked: boolean,
	planState: NewOrgPlanState,
	paymentUrl: string | null = null,
): NewOrgSetupState {
	return {
		subscriptionId,
		customerId: "cus_1",
		paid: planState === "active",
		planState,
		paymentUrl,
		org: { id: "org-1", slug: "acme-cloud" },
		linked,
		declared: false,
		name: "Acme Cloud",
		slug: "acme-cloud",
		billing: null,
		currency: "eur",
	};
}

const hooks = { onProgress: vi.fn(), fetchWorkspace: vi.fn(async () => undefined) };

/** Every toast text the run produced, of any kind. */
function toasted(): string[] {
	return [toast.success, toast.info, toast.warning, toast.error].flatMap((fn) =>
		fn.mock.calls.map((c: unknown[]) => String(c[0])),
	);
}

/** The toast a finished run shows for `state` — the copy, plus the next step for `action_needed`. */
function expectedToast(state: NewOrgPlanState, paymentUrl: string | null = null): string {
	const copy = NEW_ORG_PLAN_COPY[state].toast;
	return state === "action_needed" ? `${copy} ${actionNeededNextStep(paymentUrl)}` : copy;
}

const PAY_URL = "https://invoice.stripe.com/i/acct_1/test_inv";

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a finished paid setup reports the plan state the LINK read (#5522)", () => {
	for (const state of NEW_ORG_PLAN_STATES) {
		it(`${state}: the outcome carries it, and the toast is that state's copy`, async () => {
			const sub = `sub_${state}`;
			// The resume lookup says something else, so only the link's answer can produce this.
			const other: NewOrgPlanState = state === "not_active" ? "active" : "not_active";
			resolveNewOrgSetup.mockResolvedValue(serverSays(sub, false, other));
			const paymentUrl = state === "action_needed" ? PAY_URL : null;
			linkSubscriptionToNewOrg.mockResolvedValue({ planState: state, paymentUrl });

			const outcome = await finishPaidSetup("user-1", record(sub), hooks);

			expect(linkSubscriptionToNewOrg).toHaveBeenCalledTimes(1);
			expect(outcome).toMatchObject({ kind: "done", planState: state, paymentUrl });
			expect(toasted()).toEqual([expectedToast(state, paymentUrl)]);
			// Only an active plan is announced as a success, and only it says "Subscription active".
			expect(toast.success.mock.calls.length > 0).toBe(state === "active");
			expect(/Subscription active/.test(toasted().join(" "))).toBe(state === "active");
		});
	}
});

describe("an already-linked setup reports the state from the RESUME lookup (#5522)", () => {
	// Every state but `unconfirmed`, the run's fallback when the server never answered: each of these
	// is produced ONLY by `report = { planState: server.planState, … }` in runSteps, so removing that
	// line turns each case red.
	const fromServer = NEW_ORG_PLAN_STATES.filter((s) => s !== "unconfirmed");
	for (const state of fromServer) {
		it(`${state}: shown exactly as the server said, without linking again`, async () => {
			const sub = `sub_resumed_${state}`;
			const paymentUrl = state === "action_needed" ? PAY_URL : null;
			resolveNewOrgSetup.mockResolvedValue(serverSays(sub, true, state, paymentUrl));

			const outcome = await finishPaidSetup("user-1", record(sub, true), hooks);

			expect(linkSubscriptionToNewOrg).not.toHaveBeenCalled();
			expect(outcome).toMatchObject({ kind: "done", planState: state, paymentUrl });
			expect(toasted()).toEqual([expectedToast(state, paymentUrl)]);
		});
	}
});

describe("a settling state is re-read from the server for a bounded time (#5522)", () => {
	const ids = { subscriptionId: "sub_poll", customerId: "cus_1" };

	it("flips to active when the server says so, then stops asking", async () => {
		vi.useFakeTimers();
		resolveNewOrgSetup
			.mockResolvedValueOnce(serverSays("sub_poll", true, "processing"))
			.mockResolvedValueOnce(serverSays("sub_poll", true, "active"));
		const onReport = vi.fn();

		const stop = pollSettlingPlanState(ids, "processing", onReport, { intervalMs: 3_000, timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(onReport).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(onReport).toHaveBeenCalledWith({ planState: "active", paymentUrl: null });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(resolveNewOrgSetup).toHaveBeenCalledTimes(2);
		stop();
	});

	it("gives up after the bound and keeps the last true state", async () => {
		vi.useFakeTimers();
		resolveNewOrgSetup.mockResolvedValue(serverSays("sub_poll", true, "processing"));
		const onReport = vi.fn();

		pollSettlingPlanState(ids, "processing", onReport, { intervalMs: 3_000, timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(120_000);
		const asked = resolveNewOrgSetup.mock.calls.length;
		expect(asked).toBeLessThanOrEqual(20);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(resolveNewOrgSetup).toHaveBeenCalledTimes(asked);
		expect(onReport).not.toHaveBeenCalled();
	});

	it("a failed read is skipped, and the next one is still made", async () => {
		vi.useFakeTimers();
		resolveNewOrgSetup
			.mockRejectedValueOnce(new Error("Failed to fetch"))
			.mockResolvedValueOnce(serverSays("sub_poll", true, "active"));
		const onReport = vi.fn();

		pollSettlingPlanState(ids, "unconfirmed", onReport, { intervalMs: 3_000, timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(6_000);
		expect(onReport).toHaveBeenCalledWith({ planState: "active", paymentUrl: null });
	});

	it("a state that is not settling is never polled", async () => {
		vi.useFakeTimers();
		pollSettlingPlanState(ids, "action_needed", vi.fn());
		await vi.advanceTimersByTimeAsync(120_000);
		expect(resolveNewOrgSetup).not.toHaveBeenCalled();
	});
});

describe("the final view shows the reported plan state (#5522)", () => {
	/** Renders the post-purchase view for a paid setup in `state` (or a trial, for null). */
	function renderView(state: NewOrgPlanState | null, paymentUrl: string | null = null, isTrialOrg = false) {
		render(
			<InviteView
				isTrialOrg={isTrialOrg}
				paidPlan={state ? { planState: state, paymentUrl } : null}
				ownerEmail="owner@example.com"
				inviteEmail=""
				setInviteEmail={vi.fn()}
				inviteRole="viewer"
				setInviteRole={vi.fn()}
				sent={[]}
				onAdd={vi.fn()}
				onFinish={vi.fn()}
				onAddPayment={vi.fn()}
			/>,
		);
	}

	for (const state of NEW_ORG_PLAN_STATES) {
		it(`${state}: a status badge with its label and its sentence, and no new page title`, () => {
			renderView(state);
			const status = screen.getByRole("status");
			expect(status).toHaveTextContent(NEW_ORG_PLAN_COPY[state].label);
			expect(status).toHaveTextContent(NEW_ORG_PLAN_COPY[state].sentence);
			expect(status.querySelector(".vx-status")).not.toBeNull();
			expect(status.querySelector("h1")).toBeNull();
			expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		});
	}

	it("action needed links to Stripe's payment page when the server returned one", () => {
		renderView("action_needed", PAY_URL);
		const link = screen.getByRole("link", { name: actionNeededNextStep(PAY_URL) });
		expect(link).toHaveAttribute("href", PAY_URL);
		expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
	});

	it("action needed with no payment page sends the customer to support, not to Billing", () => {
		renderView("action_needed", null);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(actionNeededNextStep(null));
		expect(screen.getByRole("status")).not.toHaveTextContent(/Billing/);
	});

	it("a trial shows no paid plan state", () => {
		renderView(null, null, true);
		expect(screen.queryByRole("status")).toBeNull();
	});
});
