// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { revokeServiceToken } from "@/lib/cli/service-token";
import { NextResponse } from "next/server";

/**
 * Revoke one service-account token.
 *
 * REVOCATION IS THE REASON THE TOKEN IS OPAQUE RATHER THAN A JWT. A signed token is valid until it
 * expires and cannot be withdrawn without a server-side denylist — at which point the signature has
 * bought nothing. Here it is a single UPDATE, and it takes effect on the very next request because
 * `resolveServiceToken` filters on `revoked_at` inside the lookup query itself.
 *
 * The row is kept, never deleted: see the GET handler on the collection route.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const auth = await authorizeCli(req, "manage_tokens", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { id } = await ctx.params;

	const revoked = await revokeServiceToken({ id, organizationId: actor.orgId });
	if (!revoked) {
		// ONE ANSWER for "no such token", "belongs to another org" and "already revoked".
		//
		// The first two must not be distinguishable: a 404-vs-403 split would tell a caller whether
		// a token id they guessed exists in somebody else's org. The third is folded in because it
		// is not an error worth a different status — the token is not valid either way, which is
		// what the caller wanted.
		return NextResponse.json({ error: "No such active token" }, { status: 404 });
	}
	return NextResponse.json({ revoked: true, id });
}
