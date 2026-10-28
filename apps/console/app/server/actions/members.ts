"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WRITES ONLY (ADR 0005 D1/D4, #6129). The members reads moved to `lib/rpc/procedures/members.ts`
// and are served over GET; the export here is a `defineAction` returning `ActionResult<T>`, called
// from the client through `useActionMutation`. The row types stay here because `lib/queries/*`
// shapes its answers with them.

import type { Money } from "@repo/format";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { authorize } from "@/lib/authz/guard";
import { toPdpRole } from "@/lib/authz/org-access-control";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import { invitation, member } from "@/lib/db/schema";
import type { InviteRoleOption } from "@/lib/members/roles";

export interface MemberRow {
	/** member-row id (or the user id when synthesizing the personal owner). */
	id: string;
	userId: string;
	name: string | null;
	username: string | null;
	email: string;
	image: string | null;
	role: string;
	joinedAt: string;
	/** Names of the teams this member belongs to in the active org. */
	teams: string[];
	/** 'active' | 'suspended'. */
	status: string;
	/** ISO timestamp of the member's most recent session, or null if never. */
	lastActiveAt: string | null;
}

/** A pending invitation to the active org. */
export interface InvitationRow {
	id: string;
	email: string;
	role: string;
	inviterName: string;
	createdAt: string;
}

/** What a suspend / reactivate request carries. */
const setMemberSuspendedInput = z.object({
	memberId: z.string().uuid(),
	suspended: z.boolean(),
});

/**
 * Suspends or reactivates a member. Suspending keeps the member row + role but revokes
 * their PDP grant (no access) and cancels the invitations they sent that are still pending;
 * reactivating restores the grant. Owner-gated; refuses on
 * members from a different org, and refuses to SUSPEND any owner.
 *
 * "Owner" is read the way the PDP reads it (`toPdpRole`): any comma-joined part that is
 * `owner` makes the member an owner (#5465). The old `role === "owner"` let `owner,admin` be
 * suspended, which could leave the org with no active owner. Refusing every owner means a
 * suspension never lowers the org's count of active owners. Reactivating is not refused: it
 * can only add an active owner back.
 */
export async function setMemberSuspended(
	raw: z.input<typeof setMemberSuspendedInput>,
): Promise<ActionResult<{ memberId: string; suspended: boolean }>> {
	return defineAction({
		input: setMemberSuspendedInput,
		run: async ({ input }) => {
			await suspendOrReactivate(input.memberId, input.suspended);
			return input;
		},
	})(raw);
}

/** The body of {@link setMemberSuspended}, on validated input. */
async function suspendOrReactivate(memberId: string, suspended: boolean): Promise<void> {
	const actor = await authorize("manage_members", { type: "member" });
	const db = getServiceDb();

	const [m] = await db
		.select({
			orgId: member.organizationId,
			userId: member.userId,
			role: member.role,
		})
		.from(member)
		.where(eq(member.id, memberId))
		.limit(1);
	// A member of another org reads exactly like one that does not exist.
	if (!m || m.orgId !== actor.orgId) throw new ActionRefusal("not-found", "Member not found.");
	if (suspended && toPdpRole(m.role) === "owner") {
		throw new ActionRefusal("conflict", "The owner can't be suspended.");
	}

	await db
		.update(member)
		.set({ status: suspended ? "suspended" : "active" })
		.where(and(eq(member.id, memberId), eq(member.organizationId, actor.orgId)));

	if (suspended) {
		await revokeMemberGrant(m.orgId, m.userId);
		// The member's pending invitations into this org are cancelled with them (#5472): an
		// admin who invited a second account they control should not see that account get in after
		// the suspension. `beforeAcceptInvitation` refuses such an invitation at acceptance anyway;
		// this takes it off the pending list, and reactivating does not bring it back.
		await db
			.update(invitation)
			.set({ status: "canceled" })
			.where(
				and(
					eq(invitation.organizationId, m.orgId),
					eq(invitation.inviterId, m.userId),
					eq(invitation.status, "pending"),
				),
			);
	} else {
		await ensureMemberGrant(m.orgId, m.userId, m.role);
	}
}

/** Everything the invite dialog needs in one round-trip: gate, plan/seat context, the
 * role choices, and the emails already in the org (for client-side dedupe). */
export interface InviteContext {
	/** The org may invite (card-backed/paid). When false the UI shows the upsell. */
	canInvite: boolean;
	/** Stripe is wired (hosted) — drives whether the seat-cost banner is meaningful. */
	hosted: boolean;
	plan: BillingPlan;
	/** Members currently occupying a seat (the seat banner's "in use"). */
	memberCount: number;
	/** Per-seat (or flat) monthly amount WITH its currency, MINOR units, for the seat-cost
	 *  banner. null = unknown/custom. Mirrored straight from {@link BillingSummary.unitAmount};
	 *  the banner used to read a `*Usd` number and write its own `$` in front of it (#4176). */
	unitAmount: Money | null;
	roles: InviteRoleOption[];
	/** Lowercased emails of existing members (already in the org). */
	existingEmails: string[];
	/** Lowercased emails with a pending invitation. */
	pendingEmails: string[];
}
