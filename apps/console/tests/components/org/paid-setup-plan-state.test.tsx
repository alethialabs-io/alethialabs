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
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { finishPaidSetup, type PendingPaidSetup } from "@/components/org/pending-paid-setup";
import {
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
function serverSays(subscriptionId: string, linked: boolean, planState: NewOrgPlanState): NewOrgSetupState {
	return {
		subscriptionId,
		customerId: "cus_1",
		paid: planState === "active",
		planState,
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

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
});

describe("a finished paid setup reports the plan state the link read (#5522)", () => {
	for (const state of NEW_ORG_PLAN_STATES) {
		it(`${state}: the outcome carries it, and the toast says it`, async () => {
			const sub = `sub_${state}`;
			resolveNewOrgSetup.mockResolvedValue(serverSays(sub, false, "processing"));
			linkSubscriptionToNewOrg.mockResolvedValue({ planState: state });

			const outcome = await finishPaidSetup("user-1", record(sub), hooks);

			expect(linkSubscriptionToNewOrg).toHaveBeenCalledTimes(1);
			expect(outcome).toMatchObject({ kind: "done", planState: state });
			expect(toasted()).toEqual([NEW_ORG_PLAN_COPY[state].toast]);
			if (state === "active") {
				expect(toast.success).toHaveBeenCalledWith(NEW_ORG_PLAN_COPY.active.toast);
			} else {
				expect(toast.success).not.toHaveBeenCalled();
				expect(toasted().join(" ")).not.toMatch(/Subscription active/);
			}
		});
	}

	it("an already-linked setup reports the state from the resume lookup, without linking again", async () => {
		resolveNewOrgSetup.mockResolvedValue(serverSays("sub_relinked", true, "processing"));

		const outcome = await finishPaidSetup("user-1", record("sub_relinked", true), hooks);

		expect(linkSubscriptionToNewOrg).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ kind: "done", planState: "processing" });
		expect(toasted().join(" ")).not.toMatch(/Subscription active/);
	});
});

describe("the final view shows the reported plan state (#5522)", () => {
	/** Renders the post-purchase view for a paid setup in `state` (or a trial, for null). */
	function renderView(state: NewOrgPlanState | null, isTrialOrg = false) {
		render(
			<InviteView
				isTrialOrg={isTrialOrg}
				paidPlanState={state}
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

	it("a trial shows no paid plan state", () => {
		renderView(null, true);
		expect(screen.queryByRole("status")).toBeNull();
	});
});
