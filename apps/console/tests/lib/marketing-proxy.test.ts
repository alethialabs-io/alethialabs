// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../../../marketing/proxy";

const SESSION = "better-auth.session_token=test-session";

/** Build a marketing-zone request with an optional Better Auth cookie. */
function request(path: "/" | "/home", authenticated = false): NextRequest {
	return new NextRequest(`https://alethialabs.io${path}`, {
		headers: authenticated ? { cookie: SESSION } : undefined,
	});
}

describe("marketing proxy", () => {
	it("keeps the anonymous root on the public homepage", () => {
		const response = proxy(request("/"));
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("sends the authenticated root to the active-org resolver", () => {
		const response = proxy(request("/", true));
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://alethialabs.io/dashboard",
		);
	});

	it("returns anonymous /home visitors to the canonical root", () => {
		const response = proxy(request("/home"));
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("https://alethialabs.io/");
	});

	it("serves /home when a session cookie is present", () => {
		const response = proxy(request("/home", true));
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});
});
