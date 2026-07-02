// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Token-cloud health (DigitalOcean / Hetzner / Civo) — the simplest server-side probe: decrypt the
// stored API token and hit a cheap authenticated endpoint (200 = ok, 401/403 = bad). No SDK, works
// everywhere including local dev. Self-managed token clouds store no token in Alethia, so they have no
// server-side path (the dispatcher returns null and the legacy runner path is kept).

import { decryptSecret } from "@/lib/crypto/secrets";
import type { CloudIdentity } from "@/lib/db/schema";
import { type HealthResult, errorMessage } from "./types";

/** A cheap authenticated endpoint per token cloud (mirrors the runner's VerifyTokenCloud). */
const PROBE_URL: Record<string, string> = {
	digitalocean: "https://api.digitalocean.com/v2/account",
	hetzner: "https://api.hetzner.cloud/v1/datacenters",
	civo: "https://api.civo.com/v2/regions",
};

const TIMEOUT_MS = 10_000;

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/** Probes a token-cloud connection by calling its API with the stored token. Never throws. */
export async function probeTokenCloudHealth(
	identity: Pick<CloudIdentity, "provider" | "credentials">,
): Promise<HealthResult> {
	const url = PROBE_URL[identity.provider];
	if (!url) return disconnected(`Unsupported token cloud: ${identity.provider}`);

	const enc = identity.credentials.token;
	if (!enc) return disconnected("No API token is stored for this connection.");

	let token: string;
	try {
		const decoded = decryptSecret(enc);
		token = decoded.api_token ?? decoded.token ?? Object.values(decoded)[0] ?? "";
	} catch {
		return disconnected("Could not read the stored API token.");
	}
	if (!token) return disconnected("The stored API token is empty.");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (res.ok) {
			return { status: "connected", accountId: null, error: null, missingPermissions: [] };
		}
		if (res.status === 401 || res.status === 403) {
			return disconnected(`Token rejected by ${identity.provider} (HTTP ${res.status}).`);
		}
		return disconnected(`${identity.provider} API returned HTTP ${res.status}.`);
	} catch (e) {
		return disconnected(errorMessage(e));
	} finally {
		clearTimeout(timer);
	}
}
