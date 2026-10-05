// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org-slug rule (#5509): which slugs it accepts, and the reason it names for each it refuses.

import { describe, expect, it } from "vitest";

import {
	ORG_SLUG_INVALID_FORMAT_CODE,
	ORG_SLUG_MAX_LENGTH,
	ORG_SLUG_TOO_LONG_CODE,
	ORG_SLUG_TOO_LONG_MESSAGE,
	isOrgSlug,
	orgSlugShapeRefusal,
} from "../src/index";

const ACCEPTED = ["acme", "acme-cloud", "a1-b2-c3", "7", "a".repeat(ORG_SLUG_MAX_LENGTH)];
const BAD_CHARACTERS = ["-acme", "acme-", "acme--cloud", "-", "", "Acme", "acme cloud", "acme_cloud", " acme"];

describe("isOrgSlug", () => {
	it.each(ACCEPTED)("accepts %j", (slug) => {
		expect(isOrgSlug(slug)).toBe(true);
	});

	it.each([...BAD_CHARACTERS, "a".repeat(ORG_SLUG_MAX_LENGTH + 1)])("refuses %j", (slug) => {
		expect(isOrgSlug(slug)).toBe(false);
	});

	it("is the DNS-1123 label length", () => {
		expect(ORG_SLUG_MAX_LENGTH).toBe(63);
	});
});

describe("orgSlugShapeRefusal — the reason", () => {
	it.each(ACCEPTED)("has none for %j", (slug) => {
		expect(orgSlugShapeRefusal(slug)).toBeNull();
	});

	it("names the length for a slug one over the cap", () => {
		expect(orgSlugShapeRefusal("a".repeat(ORG_SLUG_MAX_LENGTH + 1))).toEqual({
			code: ORG_SLUG_TOO_LONG_CODE,
			message: "Use at most 63 characters.",
		});
		expect(ORG_SLUG_TOO_LONG_MESSAGE).toBe("Use at most 63 characters.");
	});

	// A slug that is too long AND badly formed is told the length first: fixing the characters alone
	// would still leave it refused.
	it("names the length before the characters when both are wrong", () => {
		expect(orgSlugShapeRefusal(`-${"a".repeat(ORG_SLUG_MAX_LENGTH)}`)?.code).toBe(ORG_SLUG_TOO_LONG_CODE);
	});

	it.each(BAD_CHARACTERS)("names the characters for %j", (slug) => {
		expect(orgSlugShapeRefusal(slug)).toEqual({
			code: ORG_SLUG_INVALID_FORMAT_CODE,
			message: "Use lowercase letters, numbers and hyphens.",
		});
	});
});
