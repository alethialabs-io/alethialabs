// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deleting your own account, with a grace period.
//
// The maintainer's decision: a person who deletes their account from the console is not asked to
// wait for somebody to review it. The deletion is SCHEDULED, and runs by itself when the grace
// period ends — unless the person changes their mind first. The flow, and what enforces each step:
//
//   1. PRE-CHECKS (`deletionBlockers`). Refused, with a reason the person can act on, while
//      deleting the account would strand something: a project, an environment not destroyed or a
//      connected cloud account in an organization only they can reach (the same count the erasure
//      itself refuses on, `findLiveResidency`); a team they are the only owner of that has other
//      members; or an organization they own with a paid subscription.
//   2. SCHEDULE (`scheduleMyErasure`). An erasure case is opened (identity: the signed-in session
//      that confirmed, recorded in the ledger), with `scheduledFor` 14 days out and a link token
//      whose hash is stored on the case. The confirmation email with the cancel link is sent INSIDE
//      the transaction, so a failed send opens no case. Then every session of the account is
//      revoked — which is what makes "sign in to cancel" mean something.
//   3. CANCEL (`cancelScheduledErasure`). Signing in (the session-create hook in lib/auth) or
//      the emailed link withdraws the case, and the person is told.
//   4. REMIND and RUN (`sweepScheduledErasures`, on the reconcile loop). Seven days before, a
//      reminder; when `scheduledFor` passes, `performErasure` — the same steps a person's decision
//      runs. Each case is CLAIMED with a conditional update first, so two app instances never run
//      the same erasure or send the same reminder twice.
//
// Every step writes to the case's append-only ledger.

import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, ne, notInArray } from "drizzle-orm";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	organizationBilling,
	type PrivacyCase,
	privacyCase,
	session,
	user,
} from "@/lib/db/schema";
import type { PrivacyCaseState } from "@/lib/db/schema/enums";
import { log } from "@/lib/observability/log";
import { newReference, recordEvent, subjectHash } from "@/app/server/actions/privacy/ledger";
import { PRIVACY_RESPONSE_DAYS } from "@/app/server/actions/privacy/response-period";
import { describeResidency, findLiveResidency, residencyIsClear } from "./erasure-executor";
import { performErasure } from "./erasure";
import { sendAccountDeletionEmail } from "./emails";
import { hashLinkToken, mintLinkToken } from "./link-token";

const plog = log.child({ component: "privacy" });

/** Days between confirming a self-serve deletion and the deletion running. */
export const ERASURE_GRACE_DAYS = 14;

/** The reminder goes out this many days before the deletion runs. */
export const ERASURE_REMINDER_DAYS_BEFORE = 7;

const DAY_MS = 86_400_000;

/** States in which a case is finished. */
const CLOSED_STATES: PrivacyCaseState[] = ["fulfilled", "refused", "withdrawn"];

/**
 * Subscription states that mean the organization is being charged. A card-less trial is not: it
 * reverts to the free tier by itself, and deleting the personal organization's Stripe customer
 * (lib/privacy/erasure.ts) cancels any subscription that customer still holds.
 */
const PAID_STATUSES = ["active", "past_due"] as const;

/** One reason a self-serve deletion cannot be scheduled. The message is shown to the person verbatim. */
export interface DeletionBlocker {
	code: "live_resources" | "shared_org_owner" | "paid_subscription";
	message: string;
}

/** A comma list of quoted names, e.g. `"Acme", "Beta"`. */
function names(list: string[]): string {
	return list.map((n) => `"${n}"`).join(", ");
}

/**
 * Everything that stops this account being deleted now, or an empty list.
 *
 * Asked at scheduling so the person hears it while they can act on it. It is asked AGAIN, in its
 * live-resources half, by `performErasure` on the day — a project created during the grace period
 * still refuses the erasure.
 */
export async function deletionBlockers(userId: string): Promise<DeletionBlocker[]> {
	const db = getServiceDb();
	const blockers: DeletionBlocker[] = [];

	const residency = await db.transaction((tx) =>
		findLiveResidency(tx, { userId, personalOrgId: userId }),
	);
	if (!residencyIsClear(residency)) {
		blockers.push({ code: "live_resources", message: describeResidency(residency) });
	}

	const mine = await db
		.select({ orgId: member.organizationId, role: member.role })
		.from(member)
		.where(and(eq(member.userId, userId), eq(member.status, "active")));
	const owned = mine.filter((m) => toPdpRole(m.role) === "owner").map((m) => m.orgId);
	const teamOrgs = owned.filter((id) => id !== userId);

	if (teamOrgs.length > 0) {
		const others = await db
			.select({ orgId: member.organizationId, userId: member.userId, role: member.role })
			.from(member)
			.where(and(inArray(member.organizationId, teamOrgs), eq(member.status, "active")));
		const shared: string[] = [];
		for (const orgId of teamOrgs) {
			const rest = others.filter((m) => m.orgId === orgId && m.userId !== userId);
			const anotherOwner = rest.some((m) => toPdpRole(m.role) === "owner");
			if (rest.length > 0 && !anotherOwner) shared.push(orgId);
		}
		if (shared.length > 0) {
			const orgs = await db
				.select({ name: organization.name })
				.from(organization)
				.where(inArray(organization.id, shared));
			blockers.push({
				code: "shared_org_owner",
				message:
					`You are the only owner of ${names(orgs.map((o) => o.name))}, which ` +
					`${orgs.length === 1 ? "has" : "have"} other members. Make another member an owner, ` +
					"or delete the team, before deleting your account.",
			});
		}
	}

	const billed = await db
		.select({ orgId: organizationBilling.organizationId, name: organization.name })
		.from(organizationBilling)
		.innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
		.where(
			and(
				inArray(organizationBilling.organizationId, [userId, ...teamOrgs]),
				inArray(organizationBilling.status, [...PAID_STATUSES]),
				ne(organizationBilling.plan, "community"),
			),
		);
	if (billed.length > 0) {
		blockers.push({
			code: "paid_subscription",
			message:
				`${names(billed.map((b) => b.name))} ${billed.length === 1 ? "has" : "have"} a paid ` +
				"subscription. Cancel it from the team's billing settings before deleting your account.",
		});
	}
	return blockers;
}

/** What confirming "Delete account" did. */
export type ScheduleErasureResult =
	| { outcome: "scheduled"; reference: string; scheduledFor: Date }
	| { outcome: "already_scheduled"; reference: string; scheduledFor: Date }
	| { outcome: "blocked"; blockers: DeletionBlocker[] };

/** The open erasure case of an account, if it has one. */
async function openErasureCase(userId: string): Promise<PrivacyCase | null> {
	const [open] = await getServiceDb()
		.select()
		.from(privacyCase)
		.where(
			and(
				eq(privacyCase.subjectUserId, userId),
				eq(privacyCase.kind, "erasure"),
				notInArray(privacyCase.state, CLOSED_STATES),
			),
		)
		.limit(1);
	return open ?? null;
}

/**
 * Schedules the deletion of the account `subject` names — which the CALLER has established is the
 * signed-in person confirming it from their own session. See the module header for the flow.
 *
 * An erasure case of theirs that is already open is scheduled rather than duplicated; one that is
 * already scheduled is reported, and its date is not moved.
 */
export async function scheduleSelfErasure(
	subject: { userId: string; email: string },
	now: Date,
): Promise<ScheduleErasureResult> {
	const open = await openErasureCase(subject.userId);
	if (open?.scheduledFor) {
		return { outcome: "already_scheduled", reference: open.reference, scheduledFor: open.scheduledFor };
	}
	const blockers = await deletionBlockers(subject.userId);
	if (blockers.length > 0) return { outcome: "blocked", blockers };

	const scheduledFor = new Date(now.getTime() + ERASURE_GRACE_DAYS * DAY_MS);
	const link = mintLinkToken();
	const db = getServiceDb();
	const reference = open?.reference ?? newReference();

	await db.transaction(async (tx) => {
		let caseId: string;
		if (open) {
			await tx
				.update(privacyCase)
				.set({
					scheduledFor,
					reminderSentAt: null,
					linkTokenSha256: link.sha256,
					identityVerifiedAt: open.identityVerifiedAt ?? now,
					state: "in_review",
					updatedAt: now,
				})
				.where(eq(privacyCase.id, open.id));
			caseId = open.id;
		} else {
			const [row] = await tx
				.insert(privacyCase)
				.values({
					reference,
					kind: "erasure",
					state: "in_review",
					subjectUserId: subject.userId,
					subjectEmailSha256: subjectHash(subject.email),
					organizationId: null,
					receivedAt: now,
					dueAt: new Date(now.getTime() + PRIVACY_RESPONSE_DAYS * DAY_MS),
					identityVerifiedAt: now,
					scheduledFor,
					linkTokenSha256: link.sha256,
				})
				.returning({ id: privacyCase.id });
			if (!row) throw new Error("Could not open the request.");
			caseId = row.id;
			await recordEvent(
				caseId,
				"received",
				{
					summary:
						"Request received (erasure), confirmed by the subject from the console's account settings.",
				},
				subject.userId,
				tx,
			);
		}
		await recordEvent(
			caseId,
			"identity_verified",
			{
				summary:
					"Identity verified by the subject's own authenticated console session: the requester and " +
					"the subject are the same signed-in account, and they typed the account's address to confirm.",
			},
			subject.userId,
			tx,
		);
		await recordEvent(
			caseId,
			"note",
			{
				summary:
					`Erasure scheduled for ${scheduledFor.toISOString()} (${ERASURE_GRACE_DAYS}-day grace period). ` +
					"The subject was emailed a cancel link and signed out everywhere; signing in again or the " +
					"link withdraws the request.",
			},
			subject.userId,
			tx,
		);
		await sendAccountDeletionEmail({
			to: subject.email,
			stage: "scheduled",
			reference,
			at: scheduledFor,
			cancelToken: link.token,
		});
	});

	// After the commit: a revoke inside the transaction would sign the person out of a deletion that
	// then rolled back.
	await db.delete(session).where(eq(session.userId, subject.userId));
	return { outcome: "scheduled", reference, scheduledFor };
}

/** How a scheduled deletion was cancelled, for the ledger. */
export type CancelVia = "sign_in" | "link";

/** What a cancel did. */
export type CancelErasureResult =
	| { outcome: "cancelled"; reference: string }
	| { outcome: "nothing_scheduled" };

/**
 * Withdraws a scheduled self-serve deletion, found by the account or by the emailed link token.
 *
 * A conditional update is the claim, so a cancel racing the sweep's own claim either wins (the
 * case is withdrawn and the sweep finds nothing) or loses (the erasure is already running, and
 * this answers `nothing_scheduled`).
 */
export async function cancelScheduledErasure(
	by: { userId: string } | { token: string },
	via: CancelVia,
	now: Date,
): Promise<CancelErasureResult> {
	const db = getServiceDb();
	const match =
		"userId" in by
			? eq(privacyCase.subjectUserId, by.userId)
			: eq(privacyCase.linkTokenSha256, hashLinkToken(by.token));
	const [c] = await db
		.update(privacyCase)
		.set({
			state: "withdrawn",
			scheduledFor: null,
			linkTokenSha256: null,
			decidedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				match,
				eq(privacyCase.kind, "erasure"),
				isNotNull(privacyCase.scheduledFor),
				notInArray(privacyCase.state, CLOSED_STATES),
			),
		)
		.returning({
			id: privacyCase.id,
			reference: privacyCase.reference,
			subjectUserId: privacyCase.subjectUserId,
		});
	if (!c) return { outcome: "nothing_scheduled" };

	await recordEvent(
		c.id,
		"withdrawn",
		{
			summary:
				via === "sign_in"
					? "Withdrawn: the subject signed in during the grace period, which cancels a scheduled erasure."
					: "Withdrawn: the subject used the cancel link from the confirmation email.",
		},
		c.subjectUserId,
	);
	if (c.subjectUserId) {
		const [u] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, c.subjectUserId))
			.limit(1);
		if (u) {
			await sendAccountDeletionEmail({
				to: u.email,
				stage: "cancelled",
				reference: c.reference,
				at: now,
			}).catch((err) => plog.error("deletion-cancelled email failed", { err }));
		}
	}
	return { outcome: "cancelled", reference: c.reference };
}

/** The scheduled deletion a link token points at, for the cancel page. Null when there is none. */
export async function scheduledErasureByToken(
	token: string,
): Promise<{ reference: string; scheduledFor: Date } | null> {
	const [c] = await getServiceDb()
		.select({ reference: privacyCase.reference, scheduledFor: privacyCase.scheduledFor })
		.from(privacyCase)
		.where(
			and(
				eq(privacyCase.linkTokenSha256, hashLinkToken(token)),
				eq(privacyCase.kind, "erasure"),
				notInArray(privacyCase.state, CLOSED_STATES),
			),
		)
		.limit(1);
	if (!c?.scheduledFor) return null;
	return { reference: c.reference, scheduledFor: c.scheduledFor };
}

/** What one sweep pass did. A type alias so it is assignable to the heartbeat's result shape. */
export type ErasureSweepResult = {
	reminded: number;
	erased: number;
	refused: number;
	failed: number;
};

/** The current address of an account, or null when it has none any more. */
async function addressOf(userId: string | null): Promise<string | null> {
	if (!userId) return null;
	const [u] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return u?.email ?? null;
}

/**
 * Sends the reminders that are due and runs the deletions whose grace period has ended.
 *
 * Bounded per pass so one tick cannot run long; a backlog drains over later passes.
 */
export async function sweepScheduledErasures(now: Date, batch = 20): Promise<ErasureSweepResult> {
	const db = getServiceDb();
	const result: ErasureSweepResult = { reminded: 0, erased: 0, refused: 0, failed: 0 };

	// Reminders: scheduled, not yet reminded, and within the reminder window.
	const remindBefore = new Date(now.getTime() + ERASURE_REMINDER_DAYS_BEFORE * DAY_MS);
	const toRemind = await db
		.select({ id: privacyCase.id })
		.from(privacyCase)
		.where(
			and(
				eq(privacyCase.kind, "erasure"),
				eq(privacyCase.state, "in_review"),
				isNull(privacyCase.reminderSentAt),
				lte(privacyCase.scheduledFor, remindBefore),
			),
		)
		.limit(batch);
	for (const { id } of toRemind) {
		const [claimed] = await db
			.update(privacyCase)
			.set({ reminderSentAt: now, updatedAt: now })
			.where(and(eq(privacyCase.id, id), isNull(privacyCase.reminderSentAt)))
			.returning();
		if (!claimed?.scheduledFor || claimed.scheduledFor <= now) continue;
		const to = await addressOf(claimed.subjectUserId);
		if (!to) continue;
		// The reminder carries no cancel link: the link token is stored hashed, so it cannot be
		// re-sent, and minting a second one would leave two working links. Signing in cancels.
		try {
			await sendAccountDeletionEmail({
				to,
				stage: "reminder",
				reference: claimed.reference,
				at: claimed.scheduledFor,
			});
			await recordEvent(
				claimed.id,
				"note",
				{ summary: "Reminder sent: the scheduled erasure runs in 7 days or less." },
				null,
			);
			result.reminded += 1;
		} catch (err) {
			plog.error("deletion reminder failed", { err });
			await db
				.update(privacyCase)
				.set({ reminderSentAt: null })
				.where(eq(privacyCase.id, claimed.id));
		}
	}

	// Due: the grace period has ended.
	const due = await db
		.select({ id: privacyCase.id, scheduledFor: privacyCase.scheduledFor })
		.from(privacyCase)
		.where(
			and(
				eq(privacyCase.kind, "erasure"),
				eq(privacyCase.state, "in_review"),
				lte(privacyCase.scheduledFor, now),
			),
		)
		.limit(batch);
	for (const { id, scheduledFor } of due) {
		if (!scheduledFor) continue;
		// The claim: clearing `scheduledFor` on the row only one instance can match.
		const [c] = await db
			.update(privacyCase)
			.set({ scheduledFor: null, updatedAt: now })
			.where(and(eq(privacyCase.id, id), eq(privacyCase.scheduledFor, scheduledFor)))
			.returning();
		if (!c) continue;
		const to = await addressOf(c.subjectUserId);
		try {
			const outcome = await performErasure(c, null, now);
			if (outcome.outcome === "erased") {
				result.erased += 1;
				if (to) {
					await sendAccountDeletionEmail({ to, stage: "deleted", reference: c.reference, at: now }).catch(
						(err) => plog.error("deletion-complete email failed", { err }),
					);
				}
			} else {
				result.refused += 1;
				await recordEvent(
					c.id,
					"note",
					{
						summary:
							"The scheduled erasure did not run (see the entry above). The case stays open for " +
							"the privacy team; it is no longer scheduled.",
					},
					null,
				);
			}
		} catch (err) {
			result.failed += 1;
			plog.error("scheduled erasure failed", { err });
			await recordEvent(
				c.id,
				"note",
				{
					summary:
						"The scheduled erasure failed with an error and nothing was erased. The case stays open " +
						"for the privacy team; it is no longer scheduled.",
				},
				null,
			).catch(() => undefined);
		}
	}
	return result;
}
