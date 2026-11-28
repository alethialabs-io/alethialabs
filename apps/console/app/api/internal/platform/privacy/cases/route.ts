// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal (#7222): the staff app's privacy register. GET lists every open case, the
// overdue ones (`queryOverdueCases` with NO scope — the deployment-wide answer `overduePrivacyCases`
// deliberately does not give a console caller) and the recently decided; POST records a request
// that arrived by email. Gate and authority: ../shared.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
	accountIdForEmail,
	insertPrivacyCase,
	PRIVACY_CASE_KINDS,
	queryControllerCaseList,
	queryOverdueCases,
} from "@/lib/privacy/case-steps";
import { actingStaff, fresh, refuseCallerNamedActor, refusePlatformCaller } from "../shared";

export const dynamic = "force-dynamic";

/** How far ahead of this server's clock a receipt time may be: clock skew, not a future request. */
const RECEIPT_SKEW_MS = 5 * 60_000;

const openBody = z.object({
	kind: z.enum(PRIVACY_CASE_KINDS),
	/** The address the request came from. Hashed on the way in; never stored in the clear. */
	email: z.string().trim().email(),
	/** When the email ARRIVED. The statutory clock starts here, not when staff typed it in. */
	receivedAt: z.string().datetime(),
});

/** A list row, with its timestamps as ISO strings. */
function listRow(r: Awaited<ReturnType<typeof queryControllerCaseList>>["open"][number]) {
	return {
		...r,
		receivedAt: r.receivedAt.toISOString(),
		dueAt: r.dueAt.toISOString(),
		extendedAt: r.extendedAt?.toISOString() ?? null,
		identityVerifiedAt: r.identityVerifiedAt?.toISOString() ?? null,
		decidedAt: r.decidedAt?.toISOString() ?? null,
	};
}

/** Every open case, the overdue ones, and the most recently decided. */
export async function GET(req: Request): Promise<NextResponse> {
	const refused = refusePlatformCaller(req);
	if (refused) return refused;
	const acting = await actingStaff(req);
	if (acting.refused) return acting.refused;

	const now = new Date();
	const [{ open, decided }, overdue] = await Promise.all([
		queryControllerCaseList(),
		queryOverdueCases(now, undefined),
	]);
	return fresh({
		open: open.map(listRow),
		decided: decided.map(listRow),
		overdue: overdue.map((o) => ({ ...o, dueAt: o.dueAt.toISOString() })),
	});
}

/**
 * Records a request that arrived by email and starts its clock at the time it arrived.
 *
 * The case is linked to the account the address belongs to, when there is one, so an erasure has
 * rows to match — and is NOT marked verified: an address in a From header is exactly the evidence
 * the separate identity step exists to weigh. A controller-level request has no organization. The
 * recording staff member is the one the forwarded Access token names (../shared.ts).
 */
export async function POST(req: Request): Promise<NextResponse> {
	const refused = refusePlatformCaller(req);
	if (refused) return refused;
	const acting = await actingStaff(req);
	if (acting.refused) return acting.refused;

	const raw: unknown = await req.json().catch(() => null);
	const namedActor = refuseCallerNamedActor(raw);
	if (namedActor) return namedActor;
	const parsed = openBody.safeParse(raw);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: parsed.error.issues[0]?.message ?? "invalid request body" },
			{ status: 400 },
		);
	}
	const receivedAt = new Date(parsed.data.receivedAt);
	if (receivedAt.getTime() > Date.now() + RECEIPT_SKEW_MS) {
		return NextResponse.json(
			{ error: "A request cannot have been received in the future." },
			{ status: 400 },
		);
	}
	const subjectUserId = await accountIdForEmail(parsed.data.email);
	const { reference } = await insertPrivacyCase({
		kind: parsed.data.kind,
		email: parsed.data.email,
		subjectUserId,
		organizationId: null,
		receivedAt,
		receivedHow: "Request received by email and recorded by staff",
		actorUserId: acting.staff.userId,
	});
	return fresh({ reference, linkedAccount: subjectUserId !== null }, 201);
}
