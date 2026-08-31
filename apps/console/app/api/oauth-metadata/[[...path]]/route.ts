// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { auth, mcpResourceUrl } from "@/lib/auth";
import {
	PROTECTED_RESOURCE_METADATA_PREFIX,
	authorizationServerMetadataPath,
	protectedResourceMetadataPath,
} from "@/lib/auth/mcp-resource";

// Node runtime: this delegates into the same Better Auth instance the rest of the app uses.
export const runtime = "nodejs";

/**
 * The root `.well-known` OAuth discovery documents (#3318, #3511).
 *
 * WHY A ROUTE RATHER THAN THE PLUGINS ALONE. Better Auth serves both documents from plugin
 * `onRequest` hooks that match the request's ABSOLUTE pathname. It is mounted at
 * `/api/auth/[...all]`, so Next never routes a root `.well-known` request to it: the request fell
 * through to the console's `/{org}` wildcard and the discovery document answered **200 text/html**
 * — the most misleading of the possible failures, since a client checking only the status code
 * sees success.
 *
 * BOTH DOCUMENTS, because discovery is a chain and it breaks at its weakest link:
 *
 *   401 → `resource_metadata` → **protected-resource** document → `authorization_servers`
 *       → RFC 8414 §3 **authorization-server** document → token endpoint
 *
 * #3318 fixed the first hop only. RFC 8414 §3 defines exactly one discovery form —
 * `/.well-known/oauth-authorization-server<issuer path>` — and that is a root path too, so a
 * spec-following client still hit the HTML shell one step later. The `<issuer>/.well-known/...`
 * form Better Auth also answers lives inside the auth route and always worked, which is precisely
 * what made this look finished.
 *
 * next.config.ts rewrites both prefixes here (`beforeFiles`, ahead of every page route), and this
 * handler replays the canonical pathname into `auth.handler`. better-call runs the router's
 * `onRequest` hook before it matches a route or applies its basePath 404, so the plugins answer
 * the synthesized request even though the path is outside `/api/auth` — the library stays the
 * single source of both documents' CONTENTS.
 *
 * Anything else under either prefix gets a JSON 404. A metadata path must never answer HTML: that
 * is the bug, not a detail of it.
 */
type RouteContext = { params: Promise<{ path?: string[] }> };

/**
 * Discovery documents are read cross-origin by browser-hosted clients, so they need CORS.
 *
 * RFC 9728 §3 says the protected-resource metadata endpoint must support CORS, and 8414's
 * document is fetched from the same page context. Better Auth's `metadataResponse` sets only
 * `Content-Type` and `Cache-Control`, so without this a browser client's fetch is discarded by
 * the browser after a completely successful request — `curl` sees 200 and the client sees nothing.
 */
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, HEAD, OPTIONS",
	"access-control-allow-headers": "*",
	"access-control-max-age": "86400",
};

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function notFound(): Response {
	return withCors(
		new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		}),
	);
}

/** The `.well-known` paths this deployment actually serves, in their canonical form. */
function servedPaths(): string[] {
	const paths = [authorizationServerMetadataPath()];
	// The protected-resource document describes the MCP endpoint; without a resource, mcp() was
	// never registered and there is nothing to describe.
	if (mcpResourceUrl !== null) {
		paths.push(PROTECTED_RESOURCE_METADATA_PREFIX, protectedResourceMetadataPath(mcpResourceUrl));
	}
	return paths;
}

async function serveMetadata(request: Request, context: RouteContext): Promise<Response> {
	const { path } = await context.params;
	const segments = path ?? [];
	// The rewrite hands us `<prefix-without-.well-known>/<rest>`; the first segment names which
	// document was asked for. Rebuilt rather than read from `request.url` because a Next rewrite
	// is free to hand the handler its own internal path.
	const [document, ...rest] = segments;
	if (document !== "oauth-protected-resource" && document !== "oauth-authorization-server") {
		return notFound();
	}
	const requestedPath = `/.well-known/${document}${rest.length > 0 ? `/${rest.join("/")}` : ""}`;
	if (!servedPaths().includes(requestedPath)) return notFound();

	const replayed = new URL(requestedPath, new URL(request.url).origin);
	const response = await auth.handler(
		new Request(replayed, { method: request.method, headers: request.headers }),
	);
	return withCors(response);
}

export const GET = serveMetadata;
export const HEAD = serveMetadata;

/** The CORS preflight a browser sends before a cross-origin fetch with custom headers. */
export function OPTIONS(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}
