// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app calls the console's provisioning routes (create an org + owner invite, set a plan)
// rather than reaching into the console's authz/slug/billing internals — so all that logic stays in
// the console (single source of truth) and the operator plane holds only the sales/contract/audit
// layer. Authenticated with the DEDICATED PLATFORM_PROVISION_SECRET bearer.

import { env } from "next-runtime-env";

/** The console's own origin, reachable from the admin container. Defaults to the shared prod URL. */
function consoleOrigin(): string {
	return (
		env("NEXT_PUBLIC_CONSOLE_URL")?.replace(/\/$/, "") ?? "http://console:3000"
	);
}

function provisionSecret(): string {
	const s = env("PLATFORM_PROVISION_SECRET");
	if (!s) throw new Error("PLATFORM_PROVISION_SECRET is not configured.");
	return s;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${consoleOrigin()}/api/internal/platform${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${provisionSecret()}`,
		},
		body: JSON.stringify(body),
		cache: "no-store",
	});
	const text = await res.text();
	if (!res.ok) {
		let message = text || `console ${path} failed (HTTP ${res.status})`;
		try {
			const parsed: unknown = JSON.parse(text);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"error" in parsed &&
				typeof parsed.error === "string"
			) {
				message = parsed.error;
			}
		} catch {
			// non-JSON — keep the raw text
		}
		throw new Error(message);
	}
	return (text ? JSON.parse(text) : {}) as T;
}

/** Create an org shell + invite its owner (Flow B). Returns the new org id + invitation id. */
export function provisionOrg(input: {
	name: string;
	slug: string;
	ownerEmail: string;
}): Promise<{ orgId: string; invitationId: string }> {
	return post("/provision-org", input);
}

/** Set an org's plan via the console's single billing writer (the off-Stripe path). */
export function setOrgPlan(input: {
	orgId: string;
	plan: string;
	status: string;
	seats?: number | null;
	periodEnd?: string | null;
}): Promise<{ ok: true }> {
	return post("/set-plan", input);
}
