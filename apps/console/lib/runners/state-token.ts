// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { hkdfSync } from "node:crypto";
import * as jose from "jose";

// Per-job bearer for the console tofu-state proxy (E0). The runner puts this in TF_HTTP_PASSWORD so
// the (eventually untrusted) tofu process can read it — therefore it must grant ONLY this job's own
// state object: it carries `sub = jobId` + `key = <state key>`, and the state route re-derives the key
// server-side and cross-checks it, so a stolen/forged token can never escape its object.
//
// It is signed HS256 with a subkey HKDF-derived from BETTER_AUTH_SECRET (always present) — deliberately
// NOT the OIDC issuer key, which is only configured when managed cloud connectors exist, whereas state
// proxying is needed for every provider (incl. token clouds like Hetzner/Talos). The HKDF `info` label
// domain-separates it from session signing.

const AUDIENCE = "alethia-state";
/** Long enough to outlive an apply (job timeout is 2h) — the http backend never re-auths mid-apply. */
const DEFAULT_TTL_SECONDS = 3 * 60 * 60;

/** Whether state tokens can be minted/verified on this instance. */
export function stateTokenConfigured(): boolean {
	return !!process.env.BETTER_AUTH_SECRET;
}

/** HKDF-SHA256 subkey of BETTER_AUTH_SECRET, domain-separated for state tokens. */
function signingKey(): Uint8Array {
	const base = process.env.BETTER_AUTH_SECRET;
	if (!base) {
		throw new Error("BETTER_AUTH_SECRET is required to sign tofu-state tokens.");
	}
	return new Uint8Array(
		hkdfSync("sha256", base, "", "alethia-tofu-state-token", 32),
	);
}

/** Mints a per-job, key-scoped state bearer. */
export async function mintStateToken(opts: {
	jobId: string;
	stateKey: string;
	ttlSeconds?: number;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	return await new jose.SignJWT({ key: opts.stateKey })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(opts.jobId)
		.setAudience(AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(signingKey());
}

/** Verifies a state bearer; returns its `{ jobId, key }` claims or null when invalid/expired. */
export async function verifyStateToken(
	token: string,
): Promise<{ jobId: string; key: string } | null> {
	try {
		const { payload } = await jose.jwtVerify(token, signingKey(), {
			audience: AUDIENCE,
		});
		if (typeof payload.sub !== "string" || typeof payload.key !== "string") {
			return null;
		}
		return { jobId: payload.sub, key: payload.key };
	} catch {
		return null;
	}
}
