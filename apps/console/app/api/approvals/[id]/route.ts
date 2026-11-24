// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/approvals/:id — one approval's effective status, for the CLI waiting on it (a bearer) or
// the console (a session). Answered only within the caller's org, to a caller who may view the
// project; anything else reads as not found.

import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError } from "@/lib/auth/errors";
import { approvalErrorResponse, approvePath, cliApprovalActor } from "@/lib/approvals/http";
import { readApproval } from "@/lib/approvals/read";
import { authorizeCli, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";

/** The caller: a CLI bearer when the request carries one, else the console session. */
async function callerOf(req: Request): Promise<{ actor: Actor } | { error: Response }> {
	if (req.headers.get("authorization")) {
		const auth = await authorizeCli(req, "view", { type: "project" });
		return "error" in auth ? auth : { actor: cliApprovalActor(auth) };
	}
	try {
		return { actor: await currentActor() };
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return { error: NextResponse.json({ error: "Sign in to read this approval." }, { status: 401 }) };
		}
		throw err;
	}
}

/** Answers approval `id` as the approvals API shows it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!z.uuid().safeParse(id).success) {
		return NextResponse.json({ error: "Approval not found", code: "not_found" }, { status: 404 });
	}
	const caller = await callerOf(req);
	if ("error" in caller) return caller.error;
	try {
		const view = await withActorScope(caller.actor, (tx) => readApproval(tx, caller.actor, id));
		return NextResponse.json({ approval: view, approve_path: approvePath(view.id) });
	} catch (err) {
		const refused = approvalErrorResponse(err);
		if (refused) return refused;
		throw err;
	}
}
