// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloudflare Access application-token verification, shared by the staff app and the console.
//
// Access signs a JWT for every request it lets through to the staff app and delivers it in the
// `Cf-Access-Jwt-Assertion` header (and the `CF_Authorization` cookie). The staff identity is the
// `email` claim of THAT token, and only once the token verifies: RS256 signature against the team's
// published keys (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, cached by jose's
// remote key set), `iss` equal to the team URL, `aud` containing the staff app's Access AUD tag,
// and `exp`/`nbf` honoured. Nothing else on the request is read as identity.
//
// Fail-closed in production: no configuration, no token or a token that does not verify all mean
// "no staff identity". The SUPPORT_ADMIN_DEV_EMAIL stand-in exists for local development only and
// is never consulted when NODE_ENV=production.
//
// Two callers, one rule. apps/admin/lib/auth/staff.ts verifies the token Access delivered to it.
// The console's platform privacy routes (apps/console/lib/auth/staff-access.ts) verify the same
// token again when the staff app forwards it in {@link STAFF_ACCESS_TOKEN_HEADER}: the acting staff
// member a privacy step records is the one the token names, not one the caller states.
//
// This module is pure (no next/headers) so the decision can be unit-tested; each caller feeds it
// the request's token and the environment.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The request header Cloudflare Access sets with the signed application token. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** The cookie Cloudflare Access sets with the same signed application token. */
export const ACCESS_JWT_COOKIE = "CF_Authorization";

/**
 * The request header the staff app forwards the staff member's Access token in, on its calls to
 * the console's platform privacy routes. Deliberately not `Cf-Access-Jwt-Assertion`: that name is
 * Cloudflare's, and this hop is a service call the staff app makes, not a request Access admitted.
 */
export const STAFF_ACCESS_TOKEN_HEADER = "x-alethia-staff-access-token";

/** A validated Access configuration: the token issuer (team URL) and the application AUD tag. */
export interface AccessConfig {
	/** `https://<team>.cloudflareaccess.com` — the expected `iss`, and the base of the certs URL. */
	issuer: string;
	/** The Access application's AUD tag — must appear in the token's `aud`. */
	audience: string;
}

/** Everything the staff-identity decision depends on, gathered by the caller. */
export interface StaffIdentityInput {
	/** The Access token from the request header or cookie, if any. */
	token: string | null | undefined;
	/** CF_ACCESS_TEAM_DOMAIN — `<team>.cloudflareaccess.com`, with or without `https://`. */
	teamDomain: string | null | undefined;
	/** CF_ACCESS_AUD — the Access application AUD tag. */
	audience: string | null | undefined;
	/** SUPPORT_ADMIN_DEV_EMAIL — the local-development stand-in identity. */
	devEmail: string | null | undefined;
	/** Whether this process runs in production (NODE_ENV=production). */
	production: boolean;
}

/**
 * Builds an {@link AccessConfig} from the two settings, or null when either is missing or the team
 * domain is not a bare https host (a path, query, credentials or a non-https scheme are refused so
 * the issuer can only ever be an origin).
 */
export function accessConfigFrom(
	teamDomain: string | null | undefined,
	audience: string | null | undefined,
): AccessConfig | null {
	const domain = teamDomain?.trim();
	const aud = audience?.trim();
	if (!domain || !aud) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(domain)
		? domain
		: `https://${domain}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	return { issuer: url.origin, audience: aud };
}

/** Remote key sets, one per issuer, so jose's key cache survives across requests. */
const keySets = new Map<string, JWTVerifyGetKey>();

/** The cached remote key set for an issuer's `/cdn-cgi/access/certs` endpoint. */
function keySetFor(issuer: string): JWTVerifyGetKey {
	let keys = keySets.get(issuer);
	if (!keys) {
		keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
		keySets.set(issuer, keys);
	}
	return keys;
}

/** Drops the cached key sets. Test-only: lets each test observe its own key fetch. */
export function resetAccessKeyCache(): void {
	keySets.clear();
}

/**
 * Verifies an Access application token and returns its lowercased `email` claim, or null when the
 * signature, issuer, audience or validity window does not check out, or the token carries no email
 * (an Access service token, for instance). Never throws.
 */
export async function verifyAccessToken(
	token: string,
	config: AccessConfig,
): Promise<string | null> {
	try {
		const { payload } = await jwtVerify(token, keySetFor(config.issuer), {
			issuer: config.issuer,
			audience: config.audience,
			algorithms: ["RS256"],
		});
		const email = payload["email"];
		if (typeof email !== "string") return null;
		const normalized = email.trim().toLowerCase();
		return normalized || null;
	} catch {
		return null;
	}
}

/**
 * Decides the caller's staff email. A configured Access setup with a token present is the only
 * way to an identity, and a token that fails verification yields none. In production that is the
 * whole rule; outside production, when Access is unconfigured or sent no token, the dev stand-in
 * email is used instead.
 */
export async function resolveStaffEmail(
	input: StaffIdentityInput,
): Promise<string | null> {
	const config = accessConfigFrom(input.teamDomain, input.audience);
	const token = input.token?.trim();
	if (config && token) return verifyAccessToken(token, config);
	if (input.production) return null;
	const dev = input.devEmail?.trim().toLowerCase();
	return dev || null;
}
