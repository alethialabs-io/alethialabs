// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal (#7222): one handling step on a privacy case, taken by a platform admin from
// the staff app — verify identity, extend, apply a legal hold, fulfil an erasure, refuse. Each runs
// the SAME step the console's server action runs (lib/privacy/case-steps.ts); only the authority
// differs. Gate, authority and the acting staff member (from the forwarded Access token):
// ../../../shared.ts.
//
// A DECIDED case takes no further step here. The console's actions do not check this, and they do
// not need to: nothing in the console offers a step on a decided case. This route is reached by a
// form, and a refusal recorded after an erasure, or an extension on a refused case, would put a
// second decision on a case the subject has already been answered on.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
	caseByReference,
	extendCase,
	holdCase,
	markIdentityVerified,
	performErasure,
	referenceSchema,
	refuseCase,
} from "@/lib/privacy/case-steps";
import {
	actingStaff,
	fresh,
	refuseCallerNamedActor,
	refusePlatformCaller,
	stepRefusal,
} from "../../../shared";

export const dynamic = "force-dynamic";

/** The steps this route takes, by the path segment that names each. */
const STEPS = ["verify", "extend", "hold", "fulfil-erasure", "refuse"] as const;

const stepBody = z.object({
	/** The extension's reason, the hold's basis or the refusal's grounds; unused by the others. */
	reason: z.string().max(2000).default(""),
});

/** Takes one step on the case; answers what it did. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ reference: string; step: string }> },
): Promise<NextResponse> {
	const refused = refusePlatformCaller(req);
	if (refused) return refused;
	const acting = await actingStaff(req);
	if (acting.refused) return acting.refused;

	const raw = await params;
	const step = z.enum(STEPS).safeParse(raw.step);
	if (!step.success) {
		return NextResponse.json({ error: "unknown privacy step" }, { status: 404 });
	}
	const reference = referenceSchema.safeParse(raw.reference);
	if (!reference.success) {
		return NextResponse.json({ error: "Not a privacy request reference." }, { status: 400 });
	}
	const rawBody: unknown = await req.json().catch(() => null);
	const namedActor = refuseCallerNamedActor(rawBody);
	if (namedActor) return namedActor;
	const body = stepBody.safeParse(rawBody);
	if (!body.success) {
		return NextResponse.json(
			{ error: body.error.issues[0]?.message ?? "invalid request body" },
			{ status: 400 },
		);
	}
	const c = await caseByReference(reference.data);
	if (!c) return NextResponse.json({ error: "no such privacy request" }, { status: 404 });
	if (c.decidedAt) {
		return NextResponse.json(
			{ error: `Request ${c.reference} is already ${c.state}; it takes no further step.` },
			{ status: 409 },
		);
	}

	// Separation of duty, as the console's `authorizeCase` has it: the subject is never the second
	// party to their own request. A platform admin who is also the subject — their own erasure
	// request — has it decided by a different admin.
	if (c.subjectUserId && c.subjectUserId === acting.staff.userId) {
		return NextResponse.json(
			{ error: "This request is about your own account; another platform admin has to decide it." },
			{ status: 403 },
		);
	}

	const actor = acting.staff.userId;
	const { reason } = body.data;
	const now = new Date();
	try {
		switch (step.data) {
			case "verify":
				if (c.identityVerifiedAt) {
					return NextResponse.json(
						{ error: "Identity is already verified on this request." },
						{ status: 409 },
					);
				}
				await markIdentityVerified(c, actor, now);
				return fresh({ outcome: "verified" });
			case "extend": {
				const { dueAt } = await extendCase(c, actor, reason, now);
				return fresh({ outcome: "extended", dueAt: dueAt.toISOString() });
			}
			case "hold":
				await holdCase(c, actor, reason, now);
				return fresh({ outcome: "held" });
			case "fulfil-erasure":
				return fresh(await performErasure(c, actor, now));
			case "refuse":
				await refuseCase(c, actor, reason, now);
				return fresh({ outcome: "refused" });
		}
	} catch (err) {
		return stepRefusal(err);
	}
}
