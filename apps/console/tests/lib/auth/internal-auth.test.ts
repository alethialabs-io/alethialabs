// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// isInternalAuthorized: the shared `Authorization: Bearer ${ALETHIA_CRON_SECRET}` gate. Fail-closed
// (unset secret ⇒ never authorized), exact-match, and no false-positive on prefixes/whitespace.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";

const saved = process.env.ALETHIA_CRON_SECRET;
const SECRET = "s3cr3t-token-value";

function reqWith(auth?: string): Request {
	return new Request("http://local/x", auth ? { headers: { authorization: auth } } : undefined);
}

beforeEach(() => {
	process.env.ALETHIA_CRON_SECRET = SECRET;
});
afterEach(() => {
	if (saved === undefined) delete process.env.ALETHIA_CRON_SECRET;
	else process.env.ALETHIA_CRON_SECRET = saved;
});

describe("isInternalAuthorized", () => {
	it("true for the exact Bearer secret", () => {
		expect(isInternalAuthorized(reqWith(`Bearer ${SECRET}`))).toBe(true);
	});

	it("false when the header is missing", () => {
		expect(isInternalAuthorized(reqWith())).toBe(false);
	});

	it("false for a wrong secret", () => {
		expect(isInternalAuthorized(reqWith("Bearer wrong"))).toBe(false);
	});

	it("false without the Bearer prefix", () => {
		expect(isInternalAuthorized(reqWith(SECRET))).toBe(false);
	});

	it("false for a prefix / length mismatch (no partial match)", () => {
		expect(isInternalAuthorized(reqWith(`Bearer ${SECRET}x`))).toBe(false);
		expect(isInternalAuthorized(reqWith(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false);
	});

	it("fail-closed: never authorized when the secret is unset", () => {
		delete process.env.ALETHIA_CRON_SECRET;
		expect(isInternalAuthorized(reqWith("Bearer anything"))).toBe(false);
		expect(isInternalAuthorized(reqWith("Bearer "))).toBe(false);
		expect(isInternalAuthorized(reqWith())).toBe(false);
	});
});
