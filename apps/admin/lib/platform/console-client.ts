// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app calls the console's provisioning routes (create an org + owner invite, set a plan)
// rather than reaching into the console's authz/slug/billing internals — so all that logic stays in
// the console and the operator plane holds only the sales/contract/audit layer. (The slug's SHAPE is
// the one exception: it is @repo/org-slug, a shared package both apps read, not a console internal.) Authenticated with the DEDICATED PLATFORM_PROVISION_SECRET bearer.

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

/** Reads a console response: the parsed JSON body on 2xx, else throws the route's `error` text. */
async function readResponse(path: string, res: Response): Promise<unknown> {
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
	return text ? JSON.parse(text) : {};
}

/** POSTs a JSON body to a console platform route with the provisioning bearer. */
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
	return (await readResponse(path, res)) as T;
}

/**
 * GETs a console platform route with the provisioning bearer. Answers `unknown` on purpose: a read
 * crosses a service boundary, so the caller validates the body (zod) instead of trusting a type.
 */
async function get(path: string): Promise<unknown> {
	const res = await fetch(`${consoleOrigin()}/api/internal/platform${path}`, {
		method: "GET",
		headers: { authorization: `Bearer ${provisionSecret()}` },
		cache: "no-store",
	});
	return readResponse(path, res);
}

/**
 * The Postgres-derived funnel for the last `days` UTC days (REL-L12) — aggregate counts only. The
 * body is unvalidated here; app/funnel/report.ts parses it.
 */
export function getFunnelReport(days: number): Promise<unknown> {
	return get(`/funnel?days=${encodeURIComponent(String(days))}`);
}

/** Create an org shell + invite its owner (Flow B). Returns the new org id + invitation id. */
export function provisionOrg(input: {
	name: string;
	slug: string;
	ownerEmail: string;
}): Promise<{ orgId: string; invitationId: string }> {
	return post("/provision-org", input);
}

/**
 * Set an org's plan and/or standalone AI tier via the console's single billing writer (the off-Stripe
 * path). `plan`+`status` and `aiTier`+`aiStatus` each travel together; at least one pair is given.
 * `earlyAccessGrant` marks a complimentary Early Access grant (EA-3): the console then sends the
 * complimentary-terms email instead of the plan-welcome email.
 */
export function setOrgPlan(input: {
	orgId: string;
	plan?: string;
	status?: string;
	seats?: number | null;
	periodEnd?: string | null;
	aiTier?: "ai_free" | "ai_plus" | "ai_max";
	aiStatus?: string;
	earlyAccessGrant?: "team" | "ai_plus" | "ai_max";
}): Promise<{ ok: true }> {
	return post("/set-plan", input);
}
