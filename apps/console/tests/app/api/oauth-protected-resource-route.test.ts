// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// RFC 9728 protected-resource metadata route (#3318).
//
// The failing case in production returned **200 text/html**, so a test that asserted only a
// non-404 status would have passed against the console's HTML shell. Every assertion here is
// about the content type and the parsed body, or about the exact path handed to Better Auth.

import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn(
	async (_request: Request) =>
		new Response(
			JSON.stringify({
				resource: "https://alethialabs.io/api/mcp",
				authorization_servers: ["https://alethialabs.io/api/auth"],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		),
);

vi.mock("@/lib/auth", () => ({
	auth: { handler: (request: Request) => handler(request) },
	mcpResourceUrl: "https://alethialabs.io/api/mcp",
}));

import { GET, HEAD } from "@/app/api/oauth-protected-resource/[[...path]]/route";

/** The route's params arrive as a promise in the App Router. */
function ctx(path?: string[]) {
	return { params: Promise.resolve({ path }) };
}

function get(pathname: string): Request {
	return new Request(`https://alethialabs.io${pathname}`);
}

beforeEach(() => {
	handler.mockClear();
});

describe("GET /.well-known/oauth-protected-resource/api/mcp", () => {
	it("serves the document for the MCP resource as JSON", async () => {
		const res = await GET(
			get("/.well-known/oauth-protected-resource/api/mcp"),
			ctx(["api", "mcp"]),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = await res.json();
		expect(body.resource).toBe("https://alethialabs.io/api/mcp");
		expect(body.authorization_servers).not.toHaveLength(0);
	});

	it("replays the canonical well-known path into Better Auth", async () => {
		// The plugin serves the document from an onRequest hook that matches the ABSOLUTE
		// pathname, so the path we hand it is the whole mechanism. Written as a literal: this is
		// the URL the 401 challenge advertises, and the two must not drift together.
		await GET(get("/.well-known/oauth-protected-resource/api/mcp"), ctx(["api", "mcp"]));

		expect(handler).toHaveBeenCalledTimes(1);
		const replayed = new URL(handler.mock.calls[0][0].url);
		expect(replayed.pathname).toBe("/.well-known/oauth-protected-resource/api/mcp");
		expect(replayed.origin).toBe("https://alethialabs.io");
	});

	it("replays the well-known path even though the rewrite delivered an /api path", async () => {
		// This is what the handler actually receives in production: next.config.ts rewrites the
		// well-known path onto /api/oauth-protected-resource, so forwarding the incoming request
		// unchanged would hand the plugin a path its onRequest hook does not match — and the
		// route would 404 through Better Auth's basePath check with nothing naming the cause.
		await GET(get("/api/oauth-protected-resource/api/mcp"), ctx(["api", "mcp"]));

		expect(new URL(handler.mock.calls[0][0].url).pathname).toBe(
			"/.well-known/oauth-protected-resource/api/mcp",
		);
	});

	it("serves the bare well-known path too", async () => {
		const res = await GET(get("/.well-known/oauth-protected-resource"), ctx(undefined));

		expect(res.status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(new URL(handler.mock.calls[0][0].url).pathname).toBe(
			"/.well-known/oauth-protected-resource",
		);
	});

	it("answers HEAD through the same path", async () => {
		const res = await HEAD(
			new Request("https://alethialabs.io/.well-known/oauth-protected-resource/api/mcp", {
				method: "HEAD",
			}),
			ctx(["api", "mcp"]),
		);

		expect(res.status).toBe(200);
		expect(handler.mock.calls[0][0].method).toBe("HEAD");
	});
});

describe("a metadata path this deployment does not serve", () => {
	it("404s as JSON rather than rendering the console shell", async () => {
		// `/api/auth` is the path the broken 401 advertised. It must fail LOUDLY — the whole
		// defect was a discovery URL that answered 200 with an HTML page.
		const res = await GET(
			get("/.well-known/oauth-protected-resource/api/auth"),
			ctx(["api", "auth"]),
		);

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(handler).not.toHaveBeenCalled();
	});

	it("404s for an unrelated resource", async () => {
		const res = await GET(
			get("/.well-known/oauth-protected-resource/some/other/api"),
			ctx(["some", "other", "api"]),
		);

		expect(res.status).toBe(404);
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("a deployment that cannot form an MCP resource", () => {
	it("404s instead of delegating", async () => {
		// mcp() is not registered at all in this state, so there is no protected resource to
		// describe. Re-mocked through a fresh module graph: the file-level mock is hoisted and
		// cannot vary per test.
		vi.resetModules();
		const unusedHandler = vi.fn();
		vi.doMock("@/lib/auth", () => ({
			auth: { handler: unusedHandler },
			mcpResourceUrl: null,
		}));

		const route = await import("@/app/api/oauth-protected-resource/[[...path]]/route");
		const res = await route.GET(
			get("/.well-known/oauth-protected-resource/api/mcp"),
			ctx(["api", "mcp"]),
		);

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(unusedHandler).not.toHaveBeenCalled();
		vi.doUnmock("@/lib/auth");
		vi.resetModules();
	});
});
