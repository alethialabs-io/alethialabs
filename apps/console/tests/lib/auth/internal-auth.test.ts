// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The shared platform-internal auth primitives: timingSafeStrEqual (constant-time string equality),
// bearerMatches (constant-time `Authorization: Bearer ${secret}` against an arbitrary secret), and
// isInternalAuthorized (bearerMatches bound to ALETHIA_CRON_SECRET). All fail-closed on an unset
// secret, exact-match, no false-positive on prefixes/whitespace.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bearerMatches,
	isInternalAuthorized,
	isPlatformProvisionAuthorized,
	timingSafeStrEqual,
} from "@/lib/auth/internal-auth";

const saved = process.env.ALETHIA_CRON_SECRET;
const savedProvision = process.env.PLATFORM_PROVISION_SECRET;
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

	// The `if (!secret) return false` guard in bearerMatches is LOAD-BEARING and is NOT
	// backed up by timingSafeStrEqual's own `!b` guard: with the secret unset, the template
	// `Bearer ${secret}` interpolates to the literal — and TRUTHY — string "Bearer undefined",
	// which timingSafeStrEqual would happily compare as a real expected value. Drop the guard
	// and `Authorization: Bearer undefined` AUTHORIZES every cron/cloud-events route. The
	// generic "Bearer anything" cases above do NOT catch that (the mutant survives them), so
	// pin the exact interpolation.
	it("fail-closed: the literal interpolation of an unset secret must not authorize", () => {
		delete process.env.ALETHIA_CRON_SECRET;
		expect(isInternalAuthorized(reqWith("Bearer undefined"))).toBe(false);
		expect(bearerMatches(reqWith("Bearer undefined"), undefined)).toBe(false);
		expect(bearerMatches(reqWith("Bearer null"), null)).toBe(false);
		expect(bearerMatches(reqWith("Bearer "), "")).toBe(false);
	});
});

describe("isPlatformProvisionAuthorized", () => {
	afterEach(() => {
		if (savedProvision === undefined) delete process.env.PLATFORM_PROVISION_SECRET;
		else process.env.PLATFORM_PROVISION_SECRET = savedProvision;
	});

	it("binds to its OWN secret, independent of the cron secret", () => {
		process.env.PLATFORM_PROVISION_SECRET = "provision-only";
		process.env.ALETHIA_CRON_SECRET = SECRET;
		expect(isPlatformProvisionAuthorized(reqWith("Bearer provision-only"))).toBe(true);
		// The broadly-shared cron secret must NOT authorize the provisioning routes.
		expect(isPlatformProvisionAuthorized(reqWith(`Bearer ${SECRET}`))).toBe(false);
	});

	it("fail-closed when its secret is unset (operator plane inert)", () => {
		delete process.env.PLATFORM_PROVISION_SECRET;
		expect(isPlatformProvisionAuthorized(reqWith("Bearer anything"))).toBe(false);
		expect(isPlatformProvisionAuthorized(reqWith("Bearer undefined"))).toBe(false);
	});
});

describe("timingSafeStrEqual", () => {
	it("true only for an exact match", () => {
		expect(timingSafeStrEqual("abc123", "abc123")).toBe(true);
		expect(timingSafeStrEqual("abc123", "abc124")).toBe(false);
	});

	it("false on any length mismatch (never throws)", () => {
		expect(timingSafeStrEqual("abc", "abcd")).toBe(false);
		expect(timingSafeStrEqual("abcd", "abc")).toBe(false);
		expect(timingSafeStrEqual("", "abc")).toBe(false);
	});

	it("fail-closed: an unset/empty expected value is never equal", () => {
		expect(timingSafeStrEqual("abc", undefined)).toBe(false);
		expect(timingSafeStrEqual("abc", null)).toBe(false);
		expect(timingSafeStrEqual("abc", "")).toBe(false);
		// even an empty presented token must not match an unset expected value
		expect(timingSafeStrEqual("", undefined)).toBe(false);
	});
});

describe("bearerMatches (arbitrary secret)", () => {
	const OTHER = "release-api-secret-xyz";

	it("true for the exact Bearer secret", () => {
		expect(bearerMatches(reqWith(`Bearer ${OTHER}`), OTHER)).toBe(true);
	});

	it("false for a wrong / prefixed / unprefixed token", () => {
		expect(bearerMatches(reqWith("Bearer wrong"), OTHER)).toBe(false);
		expect(bearerMatches(reqWith(`Bearer ${OTHER}x`), OTHER)).toBe(false);
		expect(bearerMatches(reqWith(OTHER), OTHER)).toBe(false);
		expect(bearerMatches(reqWith(), OTHER)).toBe(false);
	});

	it("fail-closed when the expected secret is unset", () => {
		expect(bearerMatches(reqWith("Bearer anything"), undefined)).toBe(false);
		expect(bearerMatches(reqWith("Bearer anything"), "")).toBe(false);
	});
});
