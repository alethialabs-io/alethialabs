// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// REL-L10 (#6911): the temporary-inbox list and its matcher.

import { describe, expect, it } from "vitest";
import {
	DISPOSABLE_EMAIL_DOMAINS,
	emailDomain,
	isDisposableEmail,
} from "@/lib/auth/signup-guard/disposable-domains";

/** Long-lived inboxes people really use. None may ever be on the list. */
const REAL_PROVIDERS = [
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"yahoo.com",
	"icloud.com",
	"me.com",
	"proton.me",
	"protonmail.com",
	"fastmail.com",
	"gmx.de",
	"web.de",
	"abv.bg",
	"zoho.com",
	"hey.com",
];

describe("the list", () => {
	it("has no duplicates, and every entry is a bare lower-case domain", () => {
		expect(new Set(DISPOSABLE_EMAIL_DOMAINS).size).toBe(DISPOSABLE_EMAIL_DOMAINS.length);
		const malformed = DISPOSABLE_EMAIL_DOMAINS.filter((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
		expect(malformed).toEqual([]);
	});

	it("never lists a real mail provider", () => {
		expect(DISPOSABLE_EMAIL_DOMAINS.filter((d) => REAL_PROVIDERS.includes(d))).toEqual([]);
		expect(REAL_PROVIDERS.filter((d) => isDisposableEmail(`someone@${d}`))).toEqual([]);
	});
});

describe("isDisposableEmail", () => {
	it.each(["a@mailinator.com", "b@guerrillamail.com"])("matches a listed domain (%s)", (email) => {
		expect(isDisposableEmail(email)).toBe(true);
	});

	it.each(["a@MAILINATOR.COM", "b@Yopmail.Com."])("ignores case and a trailing dot (%s)", (email) => {
		expect(isDisposableEmail(email)).toBe(true);
	});

	it.each(["a@team.mailinator.com", "b@x.y.yopmail.com"])("matches a subdomain of a listed domain (%s)", (email) => {
		expect(isDisposableEmail(email)).toBe(true);
	});

	it.each(["a@notmailinator.com", "b@mailinator.com.example.org"])(
		"does not match a domain that merely contains a listed one (%s)",
		(email) => {
			expect(isDisposableEmail(email)).toBe(false);
		},
	);

	it.each(["no-at-sign", "trailing@"])("is false for an address with no domain (%s)", (email) => {
		expect(emailDomain(email)).toBeNull();
		expect(isDisposableEmail(email)).toBe(false);
	});
});
