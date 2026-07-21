// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Lightweight credential verifiers for pluggable connector providers — a cheap
// API ping that confirms the supplied credential works before we mark it verified.
// Server-only — called exclusively from server actions.
//
// SSRF policy (hard requirement): the console is the control plane and must NEVER
// make an outbound request to a user-supplied host. timedFetch fails closed unless
// the target is HTTPS and its host is in ALLOWED_HOSTS — a fixed set of global SaaS
// endpoints. Connectors whose endpoint is customer-internal (e.g. Vault) are NOT
// verified here; their credential is validated on the runner (inside the customer
// network) at provision time, like grafana.

export interface VerifyResult {
	ok: boolean;
	message?: string;
}

type Verifier = (fields: Record<string, string>) => Promise<VerifyResult>;

const TIMEOUT_MS = 8000;

// Datadog regional API sites (host = `api.<site>`). Allowlisted so the site field
// can never steer the request to an arbitrary host.
const DATADOG_SITES = new Set([
	"datadoghq.com",
	"us3.datadoghq.com",
	"us5.datadoghq.com",
	"datadoghq.eu",
	"ap1.datadoghq.com",
	"ap2.datadoghq.com",
	"ddog-gov.com",
]);

// The ONLY hosts the console may call. Anything else fails closed in timedFetch.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set<string>([
	"api.cloudflare.com",
	"hub.docker.com",
	...Array.from(DATADOG_SITES, (s) => `api.${s}`),
]);

/**
 * fetch with an abort timeout AND an SSRF guard: rejects anything that isn't HTTPS
 * to an allowlisted host. This is the single sink — no verifier can reach a
 * user-controlled host even if one is added later.
 */
async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid request URL.");
	}
	if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
		throw new Error(`Refusing to call non-allowlisted host: ${parsed.hostname}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(parsed, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

const VERIFIERS: Record<string, Verifier> = {
	/** Cloudflare token verification endpoint (fixed host). */
	cloudflare: async (f) => {
		const res = await timedFetch(
			"https://api.cloudflare.com/client/v4/user/tokens/verify",
			{ headers: { Authorization: `Bearer ${f.api_token ?? ""}` } },
		);
		if (res.ok) return { ok: true };
		return { ok: false, message: `Cloudflare rejected the token (HTTP ${res.status}).` };
	},

	/** Docker Hub login exchange (fixed host). */
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

	/** Datadog API key validation — site is allowlisted so the host stays fixed. */
	datadog: async (f) => {
		const site = (f.site || "datadoghq.com").trim().toLowerCase();
		if (!DATADOG_SITES.has(site)) {
			return { ok: false, message: "Unsupported Datadog site." };
		}
		const res = await timedFetch(`https://api.${site}/api/v1/validate`, {
			headers: { "DD-API-KEY": f.api_key ?? "" },
		});
		if (res.ok) return { ok: true };
		return { ok: false, message: `Datadog rejected the API key (HTTP ${res.status}).` };
	},

	// vault: intentionally NOT verified here — its address is a customer-internal
	// host the control plane must not call (SSRF + usually unreachable). The token
	// is validated on the runner at provision time.
};

/**
 * Verifies a credential for a connector slug. Providers with no registered
 * verifier (vault, grafana) are accepted optimistically — a bad
 * credential surfaces at provision time instead.
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

// Exported for unit tests — confirms the SSRF guard rejects non-allowlisted hosts.
export const __test = { timedFetch, ALLOWED_HOSTS };
