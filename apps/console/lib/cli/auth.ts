// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as jose from "jose";
import { env } from "next-runtime-env";
import { isServiceToken, resolveServiceToken } from "@/lib/cli/service-token";

/**
 * What a verified CLI credential resolves to.
 *
 * `service_token_org_id` is set ONLY by a service token, and it is what pins that token to the org
 * it was minted for. An interactive session picks its org with an `X-Alethia-Org` header, which is
 * safe because a human's memberships bound it; a machine credential has no human behind it, so
 * honouring that header would let a token minted for one tenant act on another. See
 * `authorizeCli` — the token's org WINS, and a mismatched header is REFUSED rather than ignored.
 */
export interface CliTokenPayload extends jose.JWTPayload {
	service_token_org_id?: string;
	service_token_id?: string;
	service_token_name?: string;
}

/** 401, in the one shape every arm here answers with. */
function unauthorized(message: string) {
	return new Response(JSON.stringify({ error: message }), { status: 401 });
}

export async function verifyCliToken(
	req: Request,
): Promise<{ payload: CliTokenPayload; error: null } | { payload: null; error: Response }> {
	const authHeader = req.headers.get("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return {
			error: new Response(
				JSON.stringify({ error: "Unauthorized: Missing token" }),
				{ status: 401 },
			),
			payload: null,
		};
	}

	const token = authHeader.substring(7);

	// ── SERVICE-ACCOUNT TOKENS ──
	//
	// Checked FIRST and by PREFIX, so the two credential kinds never contend. A service token is
	// opaque, not a JWT, so feeding it to jwtVerify would fail with "Invalid token" and tell a
	// customer in a pipeline nothing about what is actually wrong.
	if (isServiceToken(token)) {
		const identity = await resolveServiceToken(token);
		if (!identity) {
			// One message for not-found, revoked and expired, deliberately: distinguishing them for
			// an UNAUTHENTICATED caller is an oracle that tells an attacker holding a leaked token
			// whether it was ever real. The console's token list is where an owner sees which.
			return { payload: null, error: unauthorized("Unauthorized: Invalid or revoked service token") };
		}
		if (!identity.createdBy) {
			// The minting profile was deleted. The token acts AS that user, so there is no identity
			// left to act as — fail closed rather than fall back to anything.
			return { payload: null, error: unauthorized("Unauthorized: the profile that minted this token no longer exists") };
		}
		// THE PIN, ENFORCED AT THE CHOKEPOINT rather than in one caller.
		//
		// Not every route goes through `authorizeCli`. `/api/jobs` — PLAN, DEPLOY and DESTROY, the
		// routes that provision real cloud infrastructure — resolves its own scope from this header,
		// and `resolveCliProvider` resolves one with no header at all. Enforcing the pin only in the
		// guard would leave it unenforced on the most powerful surface in the product, which is a
		// promise the schema comment makes and the code would not keep.
		//
		// A CONFLICTING header is REFUSED, never ignored. Ignoring it would let a pipeline believe it
		// is acting on org B while every write lands in org A — a wrong answer that looks like a
		// right one, which is worse than an error.
		const headerOrg = req.headers.get("X-Alethia-Org")?.trim();
		if (headerOrg && headerOrg !== identity.organizationId) {
			return {
				payload: null,
				error: new Response(
					JSON.stringify({
						error: "Forbidden: this service token is scoped to a different organization",
					}),
					{ status: 403 },
				),
			};
		}

		return {
			payload: {
				sub: identity.createdBy,
				type: "access",
				service_token_org_id: identity.organizationId,
				service_token_id: identity.tokenId,
				service_token_name: identity.name,
			},
			error: null,
		};
	}

	const jwtSecret = env("CLI_JWT_SECRET");
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set.");
		return {
			error: new Response(
				JSON.stringify({
					error: "Internal server configuration error",
				}),
				{ status: 500 },
			),
			payload: null,
		};
	}

	try {
		const secret = new TextEncoder().encode(jwtSecret);
		const { payload } = await jose.jwtVerify(token, secret, {
			issuer: "urn:example:issuer",
			audience: "urn:example:audience",
		});

		if (payload.type !== "access") {
			return {
				error: new Response(
					JSON.stringify({
						error: "Unauthorized: Invalid token type",
					}),
					{ status: 401 },
				),
				payload: null,
			};
		}

		return { payload, error: null };
	} catch {
		return {
			error: new Response(
				JSON.stringify({ error: "Unauthorized: Invalid token" }),
				{ status: 401 },
			),
			payload: null,
		};
	}
}
