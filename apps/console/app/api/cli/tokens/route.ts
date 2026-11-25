// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import { authorizeCli } from "@/lib/authz/guard";
import type { ScopeCeiling } from "@/lib/authz/types";
import { mintServiceToken } from "@/lib/cli/service-token";
import { getServiceDb } from "@/lib/db";
import { cliServiceTokens } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { createTokenSchema } from "@/lib/validations/cli-request-bodies";

/**
 * Service-account tokens for the active organization.
 *
 * `GET` lists them — NAMES, PREFIXES AND TIMESTAMPS ONLY. There is no route, here or anywhere, that
 * reads a token back: the plaintext exists once, in the POST response, and the database holds only a
 * SHA-256. A "show me the token again" endpoint is the single change that would undo the whole
 * design, so it is worth stating that its absence is deliberate.
 *
 * `POST` mints one and returns the plaintext, once. A token carries the scopes and the project list
 * the request names, or every scope over every project when it names neither. Every route that acts
 * for a service token holds it to that limit, `POST /api/jobs` included.
 *
 * Both are gated on `manage` over `org` rather than `view`: minting a credential that can act as you
 * is an administrative act, and listing them tells an attacker which pipelines exist and when each
 * was last used, which is reconnaissance rather than trivia.
 */

/** Lists the active org's service tokens: names, prefixes, limits and timestamps, never a secret. */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "manage_tokens", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const db = getServiceDb();
	const rows = await db
		.select({
			id: cliServiceTokens.id,
			name: cliServiceTokens.name,
			token_prefix: cliServiceTokens.token_prefix,
			created_at: cliServiceTokens.created_at,
			expires_at: cliServiceTokens.expires_at,
			last_used_at: cliServiceTokens.last_used_at,
			revoked_at: cliServiceTokens.revoked_at,
			scopes: cliServiceTokens.scopes,
			project_ids: cliServiceTokens.project_ids,
		})
		.from(cliServiceTokens)
		.where(eq(cliServiceTokens.organization_id, actor.orgId))
		.orderBy(desc(cliServiceTokens.created_at));

	// Revoked rows are RETURNED, not filtered out. A revoked token that disappears takes its audit
	// trail with it, and "this one was revoked on the 3rd" is the fact an incident actually needs.
	return NextResponse.json({ tokens: rows });
}

/** Mints a service token for the active org and returns its plaintext, once. */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "manage_tokens", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const parsed = createTokenSchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid request" },
			{ status: 400 },
		);
	}

	const ceiling: ScopeCeiling = {
		scopes: parsed.data.scopes ?? AGENT_SCOPES,
		projectIds: parsed.data.project_ids ?? null,
	};
	const expiresAt = parsed.data.expires_in_days
		? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
		: null;

	const minted = await mintServiceToken({
		organizationId: actor.orgId,
		name: parsed.data.name,
		createdBy: actor.userId,
		expiresAt,
		ceiling,
	});

	return NextResponse.json(
		{
			id: minted.id,
			name: parsed.data.name,
			token_prefix: minted.token_prefix,
			expires_at: expiresAt,
			scopes: [...ceiling.scopes],
			project_ids: ceiling.projectIds,
			// THE ONLY TIME THIS VALUE EXISTS. Say so in the payload, so a client that stores the
			// response somewhere is at least storing something that told it not to.
			token: minted.token,
			warning: "Copy this token now — it is not stored and cannot be shown again.",
		},
		{ status: 201 },
	);
}
