// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 stress test R13): the proxy must run for every org address, including slugs that
// merely START with an excluded word. The matcher is compiled exactly as written in `proxy.ts`.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { config } from "@/proxy";

/** The matcher as a whole-path regex (Next anchors it the same way). */
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe("which paths the proxy runs for", () => {
	it.each(["/docsy/~/jobs", "/docs-team/~/rpc/jobs/page", "/acme/~/jobs", "/~/~/rpc/jobs/page"])(
		"runs for the org address %s",
		(path) => {
			expect(matcher.test(path)).toBe(true);
		},
	);

	it.each(["/docs", "/docs/getting-started", "/_next/static/chunk.js", "/logo.svg", "/favicon.ico"])(
		"skips %s",
		(path) => {
			expect(matcher.test(path)).toBe(false);
		},
	);
});
