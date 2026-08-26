// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { cliServiceTokens } from "@/lib/db/schema";

/**
 * Minting and verification for CLI service-account tokens — the non-interactive half of `alethia`
 * authentication. See `lib/db/schema/cli-service-tokens.ts` for why the token is opaque rather than
 * a JWT (revocation), and why its org is fixed at mint time (isolation).
 */

/**
 * The token's identifying prefix.
 *
 * A FIXED, DISTINCTIVE PREFIX IS A SECURITY FEATURE, not decoration. It is what lets a secret
 * scanner — gitleaks in this repo's own CI, GitHub's push protection, a customer's — recognise the
 * string as a live Alethia credential and stop it before it lands in a public repo. A credential
 * that looks like random base64 is one nothing can pattern-match, so it leaks silently. Never
 * shorten or vary this.
 */
export const SERVICE_TOKEN_PREFIX = "alethia_sat_";

/** Bytes of entropy behind the prefix. 32 bytes = 256 bits, the same budget as the runner tokens. */
const TOKEN_BYTES = 32;

/** Characters of the random part kept in `token_prefix`, for display and for matching a leak. */
const DISPLAY_CHARS = 8;

/** SHA-256, hex. Fast is CORRECT here and would be wrong for a password: this input is 256 bits of
 * CSPRNG output, so there is no dictionary to slow an attacker down against, and the verification
 * runs on every authenticated request. */
function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A freshly minted token. `token` is the ONLY time the plaintext exists — it is never stored. */
export interface MintedServiceToken {
	id: string;
	token: string;
	token_prefix: string;
}

/**
 * Mint a service token for an organization. Returns the plaintext exactly once; the caller must show
 * it to the user in that response and never persist it.
 */
export async function mintServiceToken(params: {
	organizationId: string;
	name: string;
	createdBy: string | null;
	expiresAt?: Date | null;
}): Promise<MintedServiceToken> {
	const random = randomBytes(TOKEN_BYTES).toString("base64url");
	const token = SERVICE_TOKEN_PREFIX + random;
	const db = getServiceDb();
	const [row] = await db
		.insert(cliServiceTokens)
		.values({
			organization_id: params.organizationId,
			name: params.name,
			token_hash: hashToken(token),
			token_prefix: SERVICE_TOKEN_PREFIX + random.slice(0, DISPLAY_CHARS),
			created_by: params.createdBy,
			expires_at: params.expiresAt ?? null,
		})
		.returning({ id: cliServiceTokens.id, token_prefix: cliServiceTokens.token_prefix });
	return { id: row.id, token, token_prefix: row.token_prefix };
}

/** Whether a bearer value is shaped like a service token at all — used to pick the auth branch. */
export function isServiceToken(bearer: string): boolean {
	return bearer.startsWith(SERVICE_TOKEN_PREFIX);
}

/** A verified service token's identity. Deliberately minimal: an org and the row that granted it. */
export interface ServiceTokenIdentity {
	tokenId: string;
	organizationId: string;
	name: string;
	/**
	 * The profile that minted it. The token ACTS AS this user, inside its fixed org.
	 *
	 * Reusing the human's identity is deliberate: the alternative is a machine principal the ReBAC
	 * PDP has never seen, which means a second authorization path, and a second authorization path is
	 * a second place for an authorization hole. A token that resolves to an existing Actor inherits
	 * every rule that already governs that Actor, including ones written after this file.
	 *
	 * The cost is that a token could outlive its creator's access, so the caller re-checks membership
	 * on every request rather than trusting the mint-time grant. NULL — the creating profile was
	 * deleted — fails closed.
	 */
	createdBy: string | null;
}

/**
 * Resolve a bearer token to its identity, or null.
 *
 * FAIL-CLOSED IN EVERY ARM. Not found, revoked, expired, and malformed all return null — there is no
 * branch that returns an identity on a token this function could not fully verify.
 *
 * The expiry and revocation checks are done IN THE QUERY rather than in JavaScript afterwards. That
 * is not a micro-optimisation: a check written after the fetch is one a later refactor can reorder
 * or short-circuit past, and the failure mode of that mistake is a revoked token that still works.
 */
export async function resolveServiceToken(bearer: string): Promise<ServiceTokenIdentity | null> {
	if (!isServiceToken(bearer)) return null;
	// A token whose random part is empty ("alethia_sat_") must never reach the database as a lookup
	// that could match a malformed stored row.
	if (bearer.length <= SERVICE_TOKEN_PREFIX.length) return null;

	const db = getServiceDb();
	const [row] = await db
		.select({
			id: cliServiceTokens.id,
			organization_id: cliServiceTokens.organization_id,
			name: cliServiceTokens.name,
			created_by: cliServiceTokens.created_by,
			token_hash: cliServiceTokens.token_hash,
		})
		.from(cliServiceTokens)
		.where(
			and(
				eq(cliServiceTokens.token_hash, hashToken(bearer)),
				isNull(cliServiceTokens.revoked_at),
				or(isNull(cliServiceTokens.expires_at), gt(cliServiceTokens.expires_at, new Date())),
			),
		)
		.limit(1);

	if (!row) return null;

	// The `eq` above already matched the hash, so this is belt-and-braces — but it is the one
	// comparison an attacker could otherwise time, and it costs a microsecond.
	const a = Buffer.from(row.token_hash, "utf8");
	const b = Buffer.from(hashToken(bearer), "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	// Best-effort, and deliberately NOT awaited into the request's critical path: a token that works
	// must not stop working because a bookkeeping write was slow. A dropped stamp costs a slightly
	// stale `last_used_at`; a failed request costs a customer's pipeline.
	void db
		.update(cliServiceTokens)
		.set({ last_used_at: new Date() })
		.where(eq(cliServiceTokens.id, row.id))
		.catch(() => {});

	return {
		tokenId: row.id,
		organizationId: row.organization_id,
		name: row.name,
		createdBy: row.created_by,
	};
}

/** Revoke a token. Idempotent: revoking an already-revoked token keeps the ORIGINAL timestamp, since
 * when it stopped being valid is the fact an incident needs. */
export async function revokeServiceToken(params: { id: string; organizationId: string }): Promise<boolean> {
	const db = getServiceDb();
	const rows = await db
		.update(cliServiceTokens)
		.set({ revoked_at: new Date() })
		.where(
			and(
				eq(cliServiceTokens.id, params.id),
				// Scoped to the org, so a token id learned from elsewhere cannot be revoked across a
				// tenant boundary — a denial-of-service on somebody else's pipeline.
				eq(cliServiceTokens.organization_id, params.organizationId),
				isNull(cliServiceTokens.revoked_at),
			),
		)
		.returning({ id: cliServiceTokens.id });
	return rows.length > 0;
}
