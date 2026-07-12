// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The break-glass AUTH BOUNDARY — deliberately SEPARATE from both the read-only support-staff gate
// (apps/admin, SUPPORT_STAFF_EMAILS behind Cloudflare Access) and every product route. Being able
// to READ cross-tenant is not being able to ACT; this is its own gate with its own allowlist.
//
// A caller is an authorized operator iff ALL of these hold (fail-closed on any doubt):
//   1. ALETHIA_BREAKGLASS_ENABLED === "true"         (master switch; else the surface 404s)
//   2. an identity can be established, from ONE of:
//        a. a valid CLI bearer token (terminal operators; cryptographically verified against
//           CLI_JWT_SECRET), whose subject resolves to an account email — the PRIMARY path, or
//        b. the Cloudflare-Access header (a DEDICATED break-glass Access app fronts the operator UI),
//           BUT ONLY when the request also carries the shared proxy secret proving it transited that
//           trusted proxy (see below), or
//        c. the BREAKGLASS_DEV_EMAIL local-dev fallback (only when neither of the above is present).
//   3. that email is on the BREAKGLASS_OPERATORS allowlist.
//
// Why the proxy secret (spoofing defense): apps/admin can trust the CF-Access email header because
// it lives on its own subdomain BEHIND Cloudflare Access, which strips any client-supplied
// cf-access-* header. This console origin is NOT behind CF Access, so a raw header could be spoofed.
// We therefore refuse to trust the CF-Access email UNLESS the dedicated break-glass Access
// app/proxy also injects a secret header (BREAKGLASS_ACCESS_PROXY_SECRET) that a direct-to-console
// attacker cannot know. If that secret is unset, the header path is DISABLED entirely and only the
// cryptographic bearer path works — fail-closed, and independent of how the deployment is wired.

import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import {
	breakglassDevEmail,
	isBreakglassEnabled,
	isBreakglassOperator,
} from "./config";

/** An authenticated, authorized break-glass operator. */
export interface BreakglassOperator {
	email: string;
	/** The operator's Alethia account id, when known (CLI-bearer path always; CF-Access via lookup). */
	userId: string | null;
}

/** The header a dedicated break-glass Cloudflare Access app sets with the verified caller's email. */
const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";
/** The secret header the dedicated break-glass proxy injects to prove a request transited it. */
const ACCESS_PROXY_SECRET_HEADER = "x-breakglass-proxy-secret";

/**
 * Resolves the caller to an authorized break-glass operator, or null when the feature is off, no
 * identity can be established, or the identity isn't allowlisted. NON-throwing — routes translate a
 * null into a 404 (feature off) or 403 (not an operator) so the surface never leaks its shape.
 */
export async function resolveBreakglassOperator(
	req: Request,
): Promise<BreakglassOperator | null> {
	// (1) Master switch — default-off, the whole surface refuses.
	if (!isBreakglassEnabled()) return null;

	// (2a) CLI bearer token (terminal operators) — the PRIMARY, cryptographically-verified path.
	// Verify the JWT first, then map the subject to an account email; the allowlist is the wall.
	if (req.headers.get("Authorization")?.startsWith("Bearer ")) {
		const { payload } = await verifyCliToken(req);
		const sub = typeof payload?.sub === "string" ? payload.sub : null;
		if (sub) {
			const email = await emailForUserId(sub);
			if (email && isBreakglassOperator(email)) return { email, userId: sub };
		}
		return null;
	}

	// (2b) Cloudflare-Access header — trusted ONLY when the request also carries the shared proxy
	// secret (so a spoofed header sent straight to the console origin is rejected). Disabled unless
	// the secret is configured — fail-closed.
	const accessEmail = req.headers.get(ACCESS_EMAIL_HEADER)?.trim().toLowerCase();
	if (accessEmail && accessProxyTrusted(req)) {
		if (!isBreakglassOperator(accessEmail)) return null;
		return { email: accessEmail, userId: await userIdForEmail(accessEmail) };
	}

	// (2c) Local-dev fallback identity (no bearer / no trusted proxy). Must also be allowlisted.
	const dev = breakglassDevEmail();
	if (dev && isBreakglassOperator(dev)) {
		return { email: dev, userId: await userIdForEmail(dev) };
	}

	return null;
}

/**
 * Whether the request proves it transited the dedicated break-glass Cloudflare-Access proxy, via a
 * constant-time match of the injected secret header against BREAKGLASS_ACCESS_PROXY_SECRET. Returns
 * false when the secret is unset (the header path is then disabled entirely) — fail-closed.
 */
function accessProxyTrusted(req: Request): boolean {
	const expected = process.env.BREAKGLASS_ACCESS_PROXY_SECRET;
	if (!expected) return false;
	const provided = req.headers.get(ACCESS_PROXY_SECRET_HEADER);
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Looks up an account id by email (service role); null when the email has no Alethia account. */
async function userIdForEmail(email: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	return row?.id ?? null;
}

/** Looks up an account email by id (service role); null when no such account. */
async function emailForUserId(userId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return row?.email ? row.email.trim().toLowerCase() : null;
}
