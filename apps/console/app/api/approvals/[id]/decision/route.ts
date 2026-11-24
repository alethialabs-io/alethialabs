// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/approvals/:id/decision — a person approves or rejects an approval request (agent surface
// §4.3). ONLY a console browser session decides: a request that carries a bearer token (a CLI login,
// a service token, an agent's OAuth token) is refused before anything is read, and decideApproval
// refuses any actor that is not a `session` again. The session must be a recent sign-in, and the
// person must hold the deploy or destroy verb on the project.

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/auth/errors";
import { decideApproval } from "@/lib/approvals/decide";
import { approvalErrorResponse } from "@/lib/approvals/http";
import { viewOf } from "@/lib/approvals/read";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

const decisionBody = z.object({
	decision: z.enum(["approve", "reject"]),
	/** For a destroy: the environment's name, typed by the person. */
	confirm_environment_name: z.string().max(200).nullish(),
});

/** The refusal every non-session caller gets. */
function notAPerson(): NextResponse {
	return NextResponse.json(
		{ error: "An approval is decided by a person signed in to the console.", code: "not_a_person" },
		{ status: 403 },
	);
}

/** Records the signed-in person's decision on approval `id`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	if (req.headers.get("authorization")) return notAPerson();
	const { id } = await params;
	if (!z.uuid().safeParse(id).success) {
		return NextResponse.json({ error: "Approval not found", code: "not_found" }, { status: 404 });
	}
	const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);
	if (!session?.user) {
		return NextResponse.json({ error: "Sign in to decide this approval." }, { status: 401 });
	}
	const actor = await currentActor().catch((err: unknown) => {
		if (err instanceof UnauthorizedError) return null;
		throw err;
	});
	// The actor must be this session's own person, as a `session` credential.
	if (!actor || actor.userId !== session.user.id || actor.credential !== "session") return notAPerson();

	const parsed = decisionBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Send decision: approve or reject." }, { status: 400 });
	}
	try {
		const result = await withActorScope(actor, async (tx) => {
			const decided = await decideApproval(
				tx,
				{ actor, sessionId: session.session.id, sessionCreatedAt: new Date(session.session.createdAt) },
				id,
				{ decision: parsed.data.decision, confirmEnvironmentName: parsed.data.confirm_environment_name },
			);
			return decided.ok ? { ok: true as const, view: await viewOf(tx, decided.approval) } : decided;
		});
		if (!result.ok) {
			return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: result.error.status });
		}
		return NextResponse.json({ approval: result.view });
	} catch (err) {
		const refused = approvalErrorResponse(err);
		if (refused) return refused;
		throw err;
	}
}
