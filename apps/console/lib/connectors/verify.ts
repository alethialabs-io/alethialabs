// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Lightweight credential verifiers for pluggable connector providers — a cheap
// API ping that confirms the supplied credential actually works before we mark it
// verified (mirrors the CONNECTION_TEST job for cloud identities). Keyed by
// connector slug; providers without a cheap validation endpoint default to OK.
// Server-only — called exclusively from server actions.

export interface VerifyResult {
	ok: boolean;
	message?: string;
}

type Verifier = (fields: Record<string, string>) => Promise<VerifyResult>;

const TIMEOUT_MS = 8000;

/** fetch with an abort timeout — never hang the server action on a slow provider. */
async function timedFetch(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

const VERIFIERS: Record<string, Verifier> = {
	/** Cloudflare token verification endpoint. */
	cloudflare: async (f) => {
		const res = await timedFetch(
			"https://api.cloudflare.com/client/v4/user/tokens/verify",
			{ headers: { Authorization: `Bearer ${f.api_token ?? ""}` } },
		);
		if (res.ok) return { ok: true };
		return { ok: false, message: `Cloudflare rejected the token (HTTP ${res.status}).` };
	},

	/** Vault health endpoint (unauthenticated) + token lookup-self. */
	vault: async (f) => {
		const addr = (f.address ?? "").replace(/\/+$/, "");
		if (!addr) return { ok: false, message: "Vault address is required." };
		const res = await timedFetch(`${addr}/v1/auth/token/lookup-self`, {
			headers: { "X-Vault-Token": f.token ?? "" },
		});
		if (res.ok) return { ok: true };
		return { ok: false, message: `Vault rejected the token (HTTP ${res.status}).` };
	},

	/** Docker Hub login exchange. */
	dockerhub: async (f) => {
		const res = await timedFetch("https://hub.docker.com/v2/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: f.username ?? "",
				password: f.access_token ?? "",
			}),
		});
		if (res.ok) return { ok: true };
		return { ok: false, message: `Docker Hub rejected the credentials (HTTP ${res.status}).` };
	},

	/** Datadog API key validation. */
	datadog: async (f) => {
		const site = f.site || "datadoghq.com";
		const res = await timedFetch(`https://api.${site}/api/v1/validate`, {
			headers: { "DD-API-KEY": f.api_key ?? "" },
		});
		if (res.ok) return { ok: true };
		return { ok: false, message: `Datadog rejected the API key (HTTP ${res.status}).` };
	},
};

/**
 * Verifies a credential for a connector slug. Providers with no registered
 * verifier (e.g. grafana/prometheus remote-write) are accepted optimistically —
 * a bad credential surfaces at provision time instead.
 */
export async function verifyConnectorCredential(
	slug: string,
	fields: Record<string, string>,
): Promise<VerifyResult> {
	const verifier = VERIFIERS[slug];
	if (!verifier) return { ok: true };
	try {
		return await verifier(fields);
	} catch (err) {
		return {
			ok: false,
			message:
				err instanceof Error
					? `Verification failed: ${err.message}`
					: "Verification failed.",
		};
	}
}
