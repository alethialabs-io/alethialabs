// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { auth, mcpResourceUrl } from "@/lib/auth";
import {
	PROTECTED_RESOURCE_METADATA_PREFIX,
	protectedResourceMetadataPath,
} from "@/lib/auth/mcp-resource";

// Node runtime: this delegates into the same Better Auth instance the rest of the app uses.
export const runtime = "nodejs";

/**
 * RFC 9728 protected-resource metadata for the MCP endpoint (#3318).
 *
 * WHY A ROUTE RATHER THAN THE PLUGIN ALONE. `mcp()` does serve this document, from a plugin
 * `onRequest` hook that matches the request's ABSOLUTE pathname against
 * `/.well-known/oauth-protected-resource` (plus the resource's own path). Better Auth is mounted
 * at `/api/auth/[...all]`, so Next never routes a root `.well-known` request to it: the request
 * fell through to the catch-all page render and the discovery document answered **200 text/html**
 * — the most misleading of the possible failures, since a client checking only the status code
 * sees success.
 *
 * So next.config.ts rewrites the well-known paths here (`beforeFiles`, ahead of every page route),
 * and this handler replays the canonical pathname into `auth.handler`. The library stays the
 * single source of the document's CONTENTS — better-call runs the router's `onRequest` hook
 * before it matches a route or applies its basePath 404, so the plugin answers the synthesized
 * request even though the path is outside `/api/auth`.
 *
 * Anything else under the well-known prefix gets a JSON 404. A metadata path must never answer
 * HTML: that is the bug, not a detail of it.
 */
type RouteContext = { params: Promise<{ path?: string[] }> };

function notFound(): Response {
	return new Response(JSON.stringify({ error: "not_found" }), {
		status: 404,
		headers: { "content-type": "application/json" },
	});
}

async function serveMetadata(request: Request, context: RouteContext): Promise<Response> {
	// No resource means mcp() was never registered, so there is no protected resource to describe.
	if (mcpResourceUrl === null) return notFound();

	const { path } = await context.params;
	const requestedPath = `${PROTECTED_RESOURCE_METADATA_PREFIX}${path?.length ? `/${path.join("/")}` : ""}`;

	// The two paths the plugin itself answers: the bare well-known path, and the one carrying the
	// resource's path. A request naming any OTHER resource is not ours to describe.
	const canonical = protectedResourceMetadataPath(mcpResourceUrl);
	if (requestedPath !== canonical && requestedPath !== PROTECTED_RESOURCE_METADATA_PREFIX) {
		return notFound();
	}

	const replayed = new URL(requestedPath, new URL(request.url).origin);
	return auth.handler(
		new Request(replayed, { method: request.method, headers: request.headers }),
	);
}

export const GET = serveMetadata;
export const HEAD = serveMetadata;
