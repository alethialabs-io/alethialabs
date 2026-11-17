// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6756: sign-in keeps the destination. `signInHref` is the one place a "go and sign in" link is
// built from the address the person was on.

import { describe, expect, it } from "vitest";
import { signInHref } from "@/lib/auth/sign-in-href";

describe("signInHref", () => {
	it("carries the path and its query as one encoded `next`", () => {
		expect(signInHref("/acme/~/jobs?status=failed&range=7d")).toBe(
			"/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed%26range%3D7d",
		);
		// The login page reads it back as the same address.
		const next = new URL(signInHref("/acme/web/settings/general"), "https://console.test").searchParams.get("next");
		expect(next).toBe("/acme/web/settings/general");
	});

	it.each([
		["nothing", undefined],
		["null", null],
		["an empty string", ""],
		["the root", "/"],
		["the sign-in page", "/login"],
		["the sign-in page with a query", "/login?next=%2Facme"],
		["another origin", "https://elsewhere.test/acme"],
		["a protocol-relative address", "//elsewhere.test/acme"],
		["a path that is not rooted", "acme/~/jobs"],
		["a backslash", "/\\elsewhere.test"],
	])("is plain sign-in for %s", (_, next) => {
		expect(signInHref(next)).toBe("/login");
	});

	it("does not mistake a path that merely starts with the same letters for the sign-in page", () => {
		expect(signInHref("/login-audit/~/jobs")).toBe("/login?next=%2Flogin-audit%2F~%2Fjobs");
	});
});
