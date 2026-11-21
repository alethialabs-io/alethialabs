// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read models for the staff privacy queue. Cross-tenant and read-only, via the service connection;
// the staff allowlist behind Cloudflare Access is the wall. Every DECISION goes through the console
// (lib/platform/console-client.ts `privacyAction`), never a write from here.

import { and, asc, desc, eq, isNull, notInArray } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { privacyCase, privacyCaseEvent, user } from "@/lib/db-schema";

/** The states in which a case is finished. */
const CLOSED = ["fulfilled", "refused", "withdrawn"];

/** One row of the queue. */
export interface PrivacyQueueRow {
	reference: string;
	kind: string;
	state: string;
	receivedAt: Date;
	dueAt: Date;
	scheduledFor: Date | null;
	identityVerified: boolean;
	legalHold: boolean;
	/** The subject's current address, when the case names an account that still has one. */
	subjectEmail: string | null;
	/** True when an organization raised it (its admins decide it in the console). */
	tenantCase: boolean;
	/** Past its stored deadline and undecided — the same rule as the console's `overduePrivacyCases`. */
	overdue: boolean;
}

/** Whether a case is overdue at `now`: past its stored `dueAt` (which includes any extension) and undecided. */
export function isOverdue(c: { dueAt: Date; decidedAt: Date | null }, now: Date): boolean {
	return c.decidedAt === null && c.dueAt.getTime() < now.getTime();
}

/** The queue: open cases (or every case), the most urgent first. */
export async function listPrivacyCases(scope: "open" | "all", now: Date = new Date()): Promise<PrivacyQueueRow[]> {
	const rows = await getServiceDb()
		.select({
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			receivedAt: privacyCase.receivedAt,
			dueAt: privacyCase.dueAt,
			decidedAt: privacyCase.decidedAt,
			scheduledFor: privacyCase.scheduledFor,
			identityVerifiedAt: privacyCase.identityVerifiedAt,
			legalHoldReason: privacyCase.legalHoldReason,
			organizationId: privacyCase.organizationId,
			subjectEmail: user.email,
		})
		.from(privacyCase)
		.leftJoin(user, eq(user.id, privacyCase.subjectUserId))
		.where(scope === "open" ? and(isNull(privacyCase.decidedAt), notInArray(privacyCase.state, CLOSED)) : undefined)
		.orderBy(scope === "open" ? asc(privacyCase.dueAt) : desc(privacyCase.receivedAt))
		.limit(200);
	return rows.map((r) => ({
		reference: r.reference,
		kind: r.kind,
		state: r.state,
		receivedAt: r.receivedAt,
		dueAt: r.dueAt,
		scheduledFor: r.scheduledFor,
		identityVerified: r.identityVerifiedAt !== null,
		legalHold: r.legalHoldReason !== null,
		subjectEmail: r.subjectEmail,
		tenantCase: r.organizationId !== null,
		overdue: isOverdue(r, now),
	}));
}

/** One case with its ledger, oldest event first, or null. */
export async function privacyCaseDetail(reference: string) {
	const db = getServiceDb();
	const [c] = await db
		.select({
			id: privacyCase.id,
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			receivedAt: privacyCase.receivedAt,
			dueAt: privacyCase.dueAt,
			extendedAt: privacyCase.extendedAt,
			decidedAt: privacyCase.decidedAt,
			identityVerifiedAt: privacyCase.identityVerifiedAt,
			legalHoldReason: privacyCase.legalHoldReason,
			refusalReason: privacyCase.refusalReason,
			scheduledFor: privacyCase.scheduledFor,
			exportExpiresAt: privacyCase.exportExpiresAt,
			organizationId: privacyCase.organizationId,
			subjectEmail: user.email,
		})
		.from(privacyCase)
		.leftJoin(user, eq(user.id, privacyCase.subjectUserId))
		.where(eq(privacyCase.reference, reference))
		.limit(1);
	if (!c) return null;
	const events = await db
		.select({
			id: privacyCaseEvent.id,
			kind: privacyCaseEvent.kind,
			at: privacyCaseEvent.at,
			summary: privacyCaseEvent.detail,
			actorEmail: user.email,
		})
		.from(privacyCaseEvent)
		.leftJoin(user, eq(user.id, privacyCaseEvent.actorUserId))
		.where(eq(privacyCaseEvent.caseId, c.id))
		.orderBy(asc(privacyCaseEvent.at));
	return {
		...c,
		events: events.map((e) => ({ ...e, summary: e.summary.summary })),
	};
}
