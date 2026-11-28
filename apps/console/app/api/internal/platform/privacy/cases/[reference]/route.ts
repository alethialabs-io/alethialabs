// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal (#7222): one privacy case and its ledger, for the staff app's case page. Gate
// and authority: ../../shared.ts.

import { NextResponse } from "next/server";
import {
	caseByReference,
	caseEventsWithActors,
	referenceSchema,
} from "@/lib/privacy/case-steps";
import { actingStaff, fresh, refusePlatformCaller, serializeCase } from "../../shared";

export const dynamic = "force-dynamic";

/** The case and its ledger, oldest event first. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ reference: string }> },
): Promise<NextResponse> {
	const refused = refusePlatformCaller(req);
	if (refused) return refused;
	const acting = await actingStaff(req);
	if (acting.refused) return acting.refused;

	const reference = referenceSchema.safeParse((await params).reference);
	if (!reference.success) {
		return NextResponse.json({ error: "Not a privacy request reference." }, { status: 400 });
	}
	const c = await caseByReference(reference.data);
	if (!c) return NextResponse.json({ error: "no such privacy request" }, { status: 404 });
	const events = await caseEventsWithActors(c);
	return fresh({
		case: serializeCase(c),
		events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
	});
}
