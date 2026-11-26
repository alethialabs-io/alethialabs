// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What every platform privacy route (#7222) shares: the operator-plane gate, the acting staff
// member, and the one shape a case is answered in.
//
// THE AUTHORITY. These routes are the controller-level half `app/server/actions/privacy/cases.ts`
// names as missing: a request that belongs to no organization — the one that arrives by email — has
// no console authority that may decide it. The decision about WHO may act is taken in the staff app
// before it calls here: Cloudflare Access authenticates the operator, `PLATFORM_ADMIN_EMAILS`
// authorizes them (`assertPlatformAdmin`), and `withPlatformAudit` commits an attempt row before the
// act. This side holds the other half: the call must carry `PLATFORM_PROVISION_SECRET`, which only
// the staff app has. Fail-closed: unset → 503, wrong or missing bearer → 401, and in neither case is
// a case read.
//
// The acting staff member's user id travels in the body and becomes the ledger actor and, for a
// decision, `decided_by_user_id`. It is trusted because the bearer is; it is still required to name
// a real account, because the ledger's actor column is a foreign key and a step that updated the
// case and then failed to write its ledger line would leave a change with no record of who made it.

import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { type PrivacyCaseRow, userExists } from "@/lib/privacy/case-steps";

/**
 * The operator-plane gate. Answers the refusal to return, or null when the caller is the staff app.
 */
export function refusePlatformCaller(req: Request): NextResponse | null {
	if (!process.env.PLATFORM_PROVISION_SECRET) {
		return NextResponse.json(
			{ error: "platform provisioning not configured (PLATFORM_PROVISION_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isPlatformProvisionAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	return null;
}

/** The acting staff member, as every mutation's body names them. */
export const actorBody = z.object({ actorUserId: z.string().uuid() });

/** Refuses an actor id that names no account; null when it names one. */
export async function refuseUnknownActor(actorUserId: string): Promise<NextResponse | null> {
	if (await userExists(actorUserId)) return null;
	return NextResponse.json({ error: "the acting staff member has no account" }, { status: 400 });
}

/** A case as the staff app reads it. The subject's address hash is not part of it. */
export function serializeCase(c: PrivacyCaseRow) {
	return {
		reference: c.reference,
		kind: c.kind,
		state: c.state,
		receivedAt: c.receivedAt.toISOString(),
		dueAt: c.dueAt.toISOString(),
		extendedAt: c.extendedAt?.toISOString() ?? null,
		extensionReason: c.extensionReason,
		identityVerifiedAt: c.identityVerifiedAt?.toISOString() ?? null,
		legalHoldReason: c.legalHoldReason,
		decidedAt: c.decidedAt?.toISOString() ?? null,
		refusalReason: c.refusalReason,
		organizationId: c.organizationId,
		subjectUserId: c.subjectUserId,
	};
}

/**
 * Turns a step's refusal into a response. The steps throw plain `Error`s whose messages are written
 * for the operator ("Identity is not verified…", "only one extension is available"), so those are
 * a 409 carrying the message; a malformed argument is a 400. Anything else propagates and is a 500.
 */
export function stepRefusal(err: unknown): NextResponse {
	if (err instanceof ZodError) {
		return NextResponse.json(
			{ error: err.issues[0]?.message ?? "invalid request" },
			{ status: 400 },
		);
	}
	if (err instanceof Error) {
		return NextResponse.json({ error: err.message }, { status: 409 });
	}
	throw err;
}

/** The JSON answer every read uses: never cached, because a case changes under every step. */
export function fresh(body: unknown, status = 200): NextResponse {
	return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
