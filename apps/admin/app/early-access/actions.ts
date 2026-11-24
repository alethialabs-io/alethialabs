"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff decisions on complimentary Early Access requests (EA-3, #7325): Grant, Decline, Converted.
//
// Every act: assertPlatformAdmin() → withPlatformAudit (a committed attempt row with the required
// reason, then a result row) → the act. The request row is written through the service connection
// (the app role cannot UPDATE it); the plan is set through the console's `set-plan` route, never
// written here, so organization_billing stays single-writer.
//
// A GRANT IS FREE AND TIME-LIMITED. It is a plan set with a term end and no Stripe object of any
// kind: no customer, no subscription, no invoice, no price. The console lapses it on its own when the
// term ends (isManualGrantExpired for Team, billingAiTier for an AI tier), so a forgotten grant does
// not run forever. The customer is told, in the console's grant email, that nothing is owed and no
// part of the period is ever charged (decisions-2026-11-23-early-access.md §2).
//
// The request is claimed BEFORE the plan is set (`status = 'open'` in the UPDATE's WHERE), so two
// staff granting at once cannot both act; if `set-plan` then fails the claim is undone and the
// request is open again.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPlatformAdmin } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import { organizationBilling } from "@/lib/db-schema";
import { withPlatformAudit } from "@/lib/platform/audit";
import { setOrgPlan } from "@/lib/platform/console-client";
import { MAX_GRANT_DAYS } from "./constants";
import { type EarlyAccessPlan, type EarlyAccessStatus, earlyAccessRequest } from "./data";

const reason = z.string().trim().min(1, "A reason is required").max(2000);

const grantSchema = z.object({
	requestId: z.string().uuid(),
	termDays: z.coerce
		.number()
		.int()
		.min(1, "The grant must last at least a day")
		.max(MAX_GRANT_DAYS, `A grant lasts at most ${MAX_GRANT_DAYS} days; grant again to extend it`),
	reason,
});

const decideSchema = z.object({ requestId: z.string().uuid(), reason });

export interface EarlyAccessActionResult {
	ok: boolean;
	error?: string;
}

/** The request's organization and plan, or null when there is no such request. */
async function readRequest(
	requestId: string,
): Promise<{ organizationId: string; planWanted: EarlyAccessPlan; status: EarlyAccessStatus } | null> {
	const [row] = await getServiceDb()
		.select({
			organizationId: earlyAccessRequest.organizationId,
			planWanted: earlyAccessRequest.planWanted,
			status: earlyAccessRequest.status,
		})
		.from(earlyAccessRequest)
		.where(eq(earlyAccessRequest.id, requestId))
		.limit(1);
	return row ?? null;
}

/**
 * Moves a request from `from` to `to`, recording who decided and why. Resolves false when the request
 * was not in `from` any more (someone else acted first).
 */
async function transition(
	requestId: string,
	from: EarlyAccessStatus,
	to: Exclude<EarlyAccessStatus, "open">,
	actor: string,
	why: string,
): Promise<boolean> {
	const now = new Date();
	const rows = await getServiceDb()
		.update(earlyAccessRequest)
		.set({ status: to, decidedByEmail: actor, decidedAt: now, decisionReason: why, updatedAt: now })
		.where(and(eq(earlyAccessRequest.id, requestId), eq(earlyAccessRequest.status, from)))
		.returning({ id: earlyAccessRequest.id });
	return rows.length > 0;
}

/** Puts a claimed grant back to `open` after `set-plan` failed (the decision columns go with it). */
async function unclaim(requestId: string): Promise<void> {
	await getServiceDb()
		.update(earlyAccessRequest)
		.set({
			status: "open",
			decidedByEmail: null,
			decidedAt: null,
			decisionReason: null,
			updatedAt: new Date(),
		})
		.where(and(eq(earlyAccessRequest.id, requestId), eq(earlyAccessRequest.status, "granted")));
}

/** The audit reason: the staff member's words, tagged with the request so the trail finds it. */
function auditReason(requestId: string, why: string): string {
	return `[early-access ${requestId}] ${why}`;
}

/** What a grant sends to `set-plan`. */
interface GrantWrite {
	plan?: string;
	status?: string;
	seats?: number | null;
	aiTier?: "ai_plus" | "ai_max";
	aiStatus?: string;
	periodEnd: string;
}

/**
 * The `set-plan` write for a grant. Team goes on the plan columns. An AI tier goes on the AI columns —
 * and one billing row holds ONE term end, shared by an off-Stripe plan grant and an off-Stripe AI
 * grant. So when the organization already holds a live off-Stripe paid plan (an earlier Team grant),
 * the AI grant re-sends that plan with the LATER of the two end dates, rather than moving the plan's
 * end silently (the console refuses that). An open-ended plan grant is refused here: attaching a
 * term end to it would time-limit a grant nobody asked to limit.
 */
async function grantWrite(orgId: string, plan: EarlyAccessPlan, end: Date): Promise<GrantWrite> {
	if (plan === "team") return { plan: "team", status: "active", periodEnd: end.toISOString() };
	const [row] = await getServiceDb()
		.select({
			plan: organizationBilling.plan,
			status: organizationBilling.status,
			seats: organizationBilling.seats,
			stripeSubscriptionId: organizationBilling.stripeSubscriptionId,
			paddleSubscriptionId: organizationBilling.paddleSubscriptionId,
			currentPeriodEnd: organizationBilling.currentPeriodEnd,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	const ai = { aiTier: plan, aiStatus: "active" };
	// "No plan subscription at any provider" — mirrors hasPlanSubscription in the console's
	// lib/billing/plan.ts, which this app cannot import (the console owns organization_billing).
	const liveOffStripePlan =
		row &&
		!row.stripeSubscriptionId &&
		!row.paddleSubscriptionId &&
		row.plan !== "community" &&
		(row.status === "active" || row.status === "trialing");
	if (!row || !liveOffStripePlan) return { ...ai, periodEnd: end.toISOString() };
	if (!row.currentPeriodEnd) {
		throw new Error(
			"This organization holds an open-ended off-Stripe plan grant; an AI grant would give it an end date. Grant the AI tier from the org page instead.",
		);
	}
	const later = row.currentPeriodEnd > end ? row.currentPeriodEnd : end;
	return {
		...ai,
		plan: row.plan,
		status: row.status,
		seats: row.seats,
		periodEnd: later.toISOString(),
	};
}

/** Grants an open request: the plan it asked for, free, for `termDays` days. */
export async function grantEarlyAccess(form: unknown): Promise<EarlyAccessActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = grantSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
	const { requestId, termDays } = parsed.data;
	const why = parsed.data.reason;

	const request = await readRequest(requestId);
	if (!request) return { ok: false, error: "No such request." };
	if (request.status !== "open") return { ok: false, error: `This request is already ${request.status}.` };

	const periodEnd = new Date(Date.now() + termDays * 86_400_000);
	try {
		await withPlatformAudit(
			staff.email,
			"grant_early_access",
			request.organizationId,
			auditReason(requestId, why),
			{ plan: request.planWanted },
			async () => {
				if (!(await transition(requestId, "open", "granted", staff.email, why))) {
					throw new Error("This request was decided by someone else just now.");
				}
				try {
					await setOrgPlan({
						orgId: request.organizationId,
						...(await grantWrite(request.organizationId, request.planWanted, periodEnd)),
						earlyAccessGrant: request.planWanted,
					});
				} catch (err) {
					await unclaim(requestId);
					throw err;
				}
			},
		);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Grant failed" };
	}
	revalidatePath("/early-access");
	return { ok: true };
}

/** Declines an open request. Nothing about the organization's plan changes. */
export async function declineEarlyAccess(form: unknown): Promise<EarlyAccessActionResult> {
	return decide(form, "open", "declined", "decline_early_access");
}

/**
 * Marks a granted request converted: the organization became a paying customer. Billing is not
 * touched — the paid subscription's webhook replaces the off-Stripe grant (a paid subscription may
 * always supersede a row with no subscription id); this records the outcome.
 */
export async function markEarlyAccessConverted(form: unknown): Promise<EarlyAccessActionResult> {
	return decide(form, "granted", "converted", "convert_early_access");
}

/** A decision that moves the request only, under the audit. */
async function decide(
	form: unknown,
	from: EarlyAccessStatus,
	to: "declined" | "converted",
	action: string,
): Promise<EarlyAccessActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = decideSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
	const { requestId } = parsed.data;
	const why = parsed.data.reason;

	const request = await readRequest(requestId);
	if (!request) return { ok: false, error: "No such request." };
	if (request.status !== from) return { ok: false, error: `This request is ${request.status}, not ${from}.` };

	try {
		await withPlatformAudit(
			staff.email,
			action,
			request.organizationId,
			auditReason(requestId, why),
			{ plan: request.planWanted },
			async () => {
				if (!(await transition(requestId, from, to, staff.email, why))) {
					throw new Error("This request was decided by someone else just now.");
				}
			},
		);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Decision failed" };
	}
	revalidatePath("/early-access");
	return { ok: true };
}
