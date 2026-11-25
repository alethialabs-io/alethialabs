// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the approvals routes (app/api/approvals/**) share: the actor a CLI bearer is, and how an
// approval refusal is answered.

import { NextResponse } from "next/server";
import type { CliAuthorization } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { ApprovalError } from "./refusal";

/**
 * The actor a verified CLI bearer is, labelled with its credential kind. `authorizeCli` binds a device
 * login as `session`; for an approval that is the wrong kind, because an approval is bound to the
 * credential that requested it and `POST /api/jobs` sees the same login as `cli_session`.
 */
export function cliApprovalActor(auth: CliAuthorization): Actor {
	switch (auth.credential) {
		case "session":
			return { ...auth.actor, credential: "cli_session" };
		case "service_token":
			return { ...auth.actor, credential: "service_token", credentialRef: auth.serviceTokenId };
	}
}

/** The response for an {@link ApprovalError}, or null for anything else (which the route rethrows). */
export function approvalErrorResponse(err: unknown): NextResponse | null {
	if (!(err instanceof ApprovalError)) return null;
	return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
}

/** The console path a person opens to decide approval `id`. The client joins it to its own API origin. */
export function approvePath(id: string): string {
	return `/approvals/${id}`;
}
