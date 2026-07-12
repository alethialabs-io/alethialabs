// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Break-glass sessions — every action happens inside a short-lived, audited session. Opening one is
// itself an audited event; an expired or closed session can no longer authorize any action, so a
// stale session id is fail-closed at dispatch time.

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { breakglassSession } from "@/lib/db/schema";
import type { BreakglassSession } from "@/lib/db/schema/breakglass";
import { BREAKGLASS_SESSION_TTL_MS } from "./config";
import { writeAttemptAudit, writeResultAudit } from "./audit";
import type { BreakglassOperator } from "./auth";

/** Opens a time-boxed break-glass session for an operator, recording an audit trail. */
export async function openBreakglassSession(
	operator: BreakglassOperator,
	reason: string,
	provenance: { ip?: string | null; userAgent?: string | null },
): Promise<BreakglassSession> {
	// Audit the intent to open first (attempt), so even a failed open is on the record.
	const auditBase = {
		sessionId: null,
		actorEmail: operator.email,
		action: "open_session" as const,
		blastRadius: "none" as const,
		resourceType: "session",
		resourceId: null,
		reason,
	};
	await writeAttemptAudit(auditBase);

	const expiresAt = new Date(Date.now() + BREAKGLASS_SESSION_TTL_MS);
	const [session] = await getServiceDb()
		.insert(breakglassSession)
		.values({
			operator_email: operator.email,
			reason,
			expires_at: expiresAt,
			ip: provenance.ip ?? null,
			user_agent: provenance.userAgent ?? null,
		})
		.returning();

	await writeResultAudit(
		{ ...auditBase, sessionId: session.id },
		"ok",
		`session opened, expires ${expiresAt.toISOString()}`,
	);
	return session;
}

/**
 * Returns the LIVE session for an id owned by this operator, or null if it does not exist, is
 * closed, is expired, or belongs to a different operator. The operator check prevents one operator
 * riding another's open session.
 */
export async function getLiveSession(
	sessionId: string,
	operatorEmail: string,
): Promise<BreakglassSession | null> {
	const [session] = await getServiceDb()
		.select()
		.from(breakglassSession)
		.where(
			and(
				eq(breakglassSession.id, sessionId),
				eq(breakglassSession.operator_email, operatorEmail),
				isNull(breakglassSession.closed_at),
				gt(breakglassSession.expires_at, sql`now()`),
			),
		)
		.limit(1);
	return session ?? null;
}

/** Closes a session (operator-initiated end). Idempotent — a re-close is a no-op. */
export async function closeBreakglassSession(
	sessionId: string,
	operatorEmail: string,
): Promise<void> {
	await getServiceDb()
		.update(breakglassSession)
		.set({ closed_at: new Date() })
		.where(
			and(
				eq(breakglassSession.id, sessionId),
				eq(breakglassSession.operator_email, operatorEmail),
				isNull(breakglassSession.closed_at),
			),
		);
}
