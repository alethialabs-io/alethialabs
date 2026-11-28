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
// THE ACTOR. The acting staff member is not something the caller states. The staff app forwards the
// staff member's Cloudflare Access token, and this side verifies it with the same verifier and
// settings the staff app uses (lib/auth/staff-access.ts); the verified email, mapped to its account,
// becomes the ledger actor and, for a decision, `decided_by_user_id`. A body that still names an
// `actorUserId` is IGNORED (the body schemas strip it), never read: the token's staff member acts.
// It is ignored rather than refused for one release only — the staff app deploys from
// alethialabs-io/web on its own schedule, and the console before this one REQUIRES that field, so the
// staff app sends it until this console is live everywhere. Restoring the 400 is the last step of
// that transition, once the staff app stops sending it (#7964).
// In production a missing or unverifiable token is a 401; outside production the staff app's dev
// stand-in (SUPPORT_ADMIN_DEV_EMAIL) applies. The email must name a real account, because the
// ledger's actor column is a foreign key and a step that updated the case and then failed to write
// its ledger line would leave a change with no record of who made it.

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { verifiedStaffEmail } from "@/lib/auth/staff-access";
import { log } from "@/lib/observability/log";
import {
	accountIdForEmail,
	type PrivacyCaseRow,
	PrivacyStepRefusal,
} from "@/lib/privacy/case-steps";

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

/** The staff member a platform privacy call acts as, established from the verified Access token. */
export interface ActingStaff {
	userId: string;
	email: string;
}

/**
 * Establishes the acting staff member from the forwarded, verified Access token and its account.
 * Answers the staff member, or the refusal to return: 401 when no identity can be established, 403
 * when the verified email has no account.
 */
export async function actingStaff(
	req: Request,
): Promise<{ staff: ActingStaff; refused?: never } | { staff?: never; refused: NextResponse }> {
	const email = await verifiedStaffEmail(req);
	if (!email) {
		return {
			refused: NextResponse.json(
				{ error: "the staff member's Access token is missing or did not verify" },
				{ status: 401 },
			),
		};
	}
	const userId = await accountIdForEmail(email);
	if (!userId) {
		return {
			refused: NextResponse.json(
				{ error: "the acting staff member has no account" },
				{ status: 403 },
			),
		};
	}
	return { staff: { userId, email } };
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

/** What an unexpected failure is answered with: its own text was written for no reader. */
export const STEP_FAILED = "The step could not be completed; the console log has the cause. Reload the case before trying again.";

/**
 * Turns a step's failure into a response. A {@link PrivacyStepRefusal} carries a sentence written
 * for the operator ("Identity is not verified…", "only one extension is available") and keeps it; a
 * malformed argument is a 400. ANYTHING ELSE — a database error, a bug — is logged here and answered
 * with {@link STEP_FAILED}, because its message was written for nobody and may describe internals.
 */
export function stepRefusal(err: unknown): NextResponse {
	if (err instanceof PrivacyStepRefusal) {
		return NextResponse.json({ error: err.message }, { status: 409 });
	}
	if (err instanceof ZodError) {
		return NextResponse.json(
			{ error: err.issues[0]?.message ?? "invalid request" },
			{ status: 400 },
		);
	}
	log.error("[privacy] a platform privacy step failed", { err });
	return NextResponse.json({ error: STEP_FAILED }, { status: 409 });
}

/** The JSON answer every read uses: never cached, because a case changes under every step. */
export function fresh(body: unknown, status = 200): NextResponse {
	return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
