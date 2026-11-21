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

/** What the console answered for one staff privacy decision. */
export interface StaffPrivacyResult {
	ok: boolean;
	message: string;
	reference?: string;
}

/** Reads a staff privacy result off an unknown response body, or throws on a shape it does not know. */
function readPrivacyResult(body: unknown): StaffPrivacyResult {
	if (
		typeof body === "object" &&
		body !== null &&
		"ok" in body &&
		typeof body.ok === "boolean" &&
		"message" in body &&
		typeof body.message === "string"
	) {
		const reference = "reference" in body && typeof body.reference === "string" ? body.reference : undefined;
		return { ok: body.ok, message: body.message, reference };
	}
	throw new Error("The console answered the privacy action with an unexpected body.");
}

/**
 * One staff privacy-queue decision, carried out by the console (`/api/internal/platform/privacy`)
 * so it runs the same steps a console decision does and lands in the case's own ledger.
 */
export async function privacyAction(
	input:
		| { action: "verify" | "fulfil"; reference: string; staffUserId: string }
		| { action: "extend" | "hold" | "refuse"; reference: string; reason: string; staffUserId: string }
		| { action: "open"; kind: string; email: string; staffUserId: string },
): Promise<StaffPrivacyResult> {
	const res = await fetch(`${consoleOrigin()}/api/internal/platform/privacy`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${provisionSecret()}`,
		},
		body: JSON.stringify(input),
		cache: "no-store",
	});
	return readPrivacyResult(await readResponse("/privacy", res));
}
