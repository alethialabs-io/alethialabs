// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console refuses to be shown inside a frame (#7848), except the invoice PDF, which only the
// console itself frames.
//
// The headers are resolved the way Next resolves them, not by reading the config's array: every
// rule whose `source` matches applies, in order, and a later rule replaces an earlier rule's value
// for the same key. The matcher is Next's own `getPathMatch`, with the options Next builds custom
// routes with, so a `source` that does not match what it looks like it matches fails here.

import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";

import config, { type NextConfigInput } from "../../next.config";

interface HeaderRule {
	source: string;
	headers: { key: string; value: string }[];
}

/** True when a resolved config declares a `headers()` function. */
function hasHeaders(value: unknown): value is { headers: () => Promise<unknown> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"headers" in value &&
		typeof value.headers === "function"
	);
}

/** True when a value has the `{ source, headers }` shape of one `headers()` rule. */
function isHeaderRule(value: unknown): value is HeaderRule {
	return (
		typeof value === "object" &&
		value !== null &&
		"source" in value &&
		typeof value.source === "string" &&
		"headers" in value &&
		Array.isArray(value.headers)
	);
}

/** Resolves a config the way Next does: invoke it if it is a function, else use it as-is. */
async function resolveLikeNext(input: NextConfigInput): Promise<unknown> {
	return typeof input === "function"
		? await input("phase-production-build", { defaultConfig: {} })
		: input;
}

/** The `headers()` rules the resolved console config declares, in order. */
async function headerRules(): Promise<HeaderRule[]> {
	const resolved = await resolveLikeNext(config);
	if (!hasHeaders(resolved)) throw new Error("the console config declares no headers()");
	const rules = await resolved.headers();
	if (!Array.isArray(rules) || !rules.every(isHeaderRule)) {
		throw new Error("headers() did not return a list of { source, headers } rules");
	}
	return rules;
}

/** The response headers Next would set from the config for `pathname`, last match winning. */
async function headersFor(pathname: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const rule of await headerRules()) {
		const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
		if (match(pathname) === false) continue;
		for (const { key, value } of rule.headers) out[key] = value;
	}
	return out;
}

const DENIED = {
	"Content-Security-Policy": "frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
};

describe("console frame headers", () => {
	it.each([
		"/",
		"/login",
		"/dashboard",
		"/acme/~/settings/billing",
		"/acme/~/settings/billing/invoices",
		"/api/auth/get-session",
	])("refuses every frame on %s", async (pathname) => {
		expect(await headersFor(pathname)).toMatchObject(DENIED);
	});

	it("refuses every frame on the OAuth consent page", async () => {
		expect(await headersFor("/auth/oauth/consent")).toMatchObject(DENIED);
	});

	it("lets only the console frame the invoice PDF its preview dialog shows", async () => {
		expect(await headersFor("/acme/~/settings/billing/invoices/in_123/pdf")).toMatchObject({
			"Content-Security-Policy": "frame-ancestors 'self'",
			"X-Frame-Options": "SAMEORIGIN",
		});
	});

	it("scopes the exemption to the PDF route alone", async () => {
		for (const pathname of [
			"/acme/~/settings/billing/invoices/in_123",
			"/acme/~/settings/billing/invoices/in_123/pdf/extra",
			"/acme/~/settings/billing/invoices/pdf",
		]) {
			expect(await headersFor(pathname)).toMatchObject(DENIED);
		}
	});

	it("declares one Content-Security-Policy per rule, never a second competing one", async () => {
		for (const rule of await headerRules()) {
			const csp = rule.headers.filter((h) => h.key.toLowerCase() === "content-security-policy");
			expect(csp.length).toBeLessThanOrEqual(1);
		}
	});
});
