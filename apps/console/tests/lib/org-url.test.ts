// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org URL's host is the instance's own (#7417, after EDN-H7 #6904). A self-managed instance
// shows its configured origin, and with no origin configured it shows a path on itself, never the
// hosted service's domain.

import { afterEach, describe, expect, it } from "vitest";
import { orgHost, orgUrl } from "@/lib/org-url";

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
	else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

/** The hosted service's domain, as a host or a host suffix. */
const HOSTED_DOMAIN = /alethialabs\.(io|com)/i;

describe("orgHost", () => {
	it("derives the bare host from NEXT_PUBLIC_APP_URL", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://app.alethialabs.io";
		expect(orgHost()).toBe("app.alethialabs.io");
	});

	it("keeps the port for a localhost origin", () => {
		process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
		expect(orgHost()).toBe("localhost:3000");
	});

	it("strips a bare host out of a value `new URL` cannot parse", () => {
		// Not hypothetical: a self-host deployment that sets NEXT_PUBLIC_APP_URL to a bare host
		// (no scheme) throws in `new URL`, and the answer must still be a host rather than a crash
		// in every page that shows the org's URL.
		process.env.NEXT_PUBLIC_APP_URL = "console.internal.example/";
		expect(orgHost()).toBe("console.internal.example");
	});
});

describe("orgHost on a self-managed instance", () => {
	it("shows the instance's own configured host", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://alethia.example.com/";
		expect(orgHost()).toBe("alethia.example.com");
		expect(orgUrl("acme")).toBe("alethia.example.com/acme");
	});

	it.each([
		["unset", undefined],
		["empty", ""],
		["whitespace", "   "],
		["a scheme with no host", "https://"],
	])("names no hosted domain when the origin is %s", (_label, value) => {
		if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
		else process.env.NEXT_PUBLIC_APP_URL = value;
		expect(orgHost()).toBe("");
		expect(orgUrl("acme")).toBe("/acme");
		expect(orgUrl("acme")).not.toMatch(HOSTED_DOMAIN);
	});
});

describe("orgUrl", () => {
	it("joins the host and slug", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
		expect(orgUrl("acme")).toBe("alethialabs.io/acme");
	});
});
