// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireMcpAuth } from "@better-auth/mcp";
// The SDK directly, not mcp-handler. mcp-handler v2 is a thin wrapper that hardcodes
// `legacy: "stateless"` and exposes no way to override it, so routing through it would
// make the strict posture below unreachable. better-auth's own MCP docs and demo call the
// SDK the same way.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type McpActorRefusal, resolveMcpActor } from "@/lib/ai/mcp/actor";
import { buildMcpServer } from "@/lib/ai/mcp/server";
import { parseSurfaceQuery } from "@/lib/ai/mcp/surface";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import { auth, mcpResourceUrl } from "@/lib/auth";
import { runWithActor } from "@/lib/authz/actor-context";
import { isAiSurfaceEnabled } from "@/lib/billing/ai-guard";

// Node runtime: the actor seam uses AsyncLocalStorage + the tools reach postgres-js.
export const runtime = "nodejs";

/*
 * Remote MCP endpoint (B7, agent surface §4.5) over Streamable HTTP. Auth is OAuth 2.1 via Better
 * Auth's mcp() plugin (discovery + token endpoints live under /api/auth + /oauth2); requireMcpAuth
 * validates the access token and yields its claims. `resolveMcpActor` turns those into the actor the
 * request runs as — the person, bound as `agent_oauth`, held to the token's scopes, the consent
 * grant's organization and projects, and the URL's `?project=` pin, and refused while the
 * organization's agent access is off — and runWithActor binds it, so every tool enforces the
 * person's grants under that ceiling with no new authority.
 *
 * The server (lib/ai/mcp/server.ts) lists the in-app read tools and the declared external tools
 * that have a handler, including the writes: `plan`, `request_apply`, `request_destroy` and
 * `cancel_job`. An apply or a destroy is queued only after a person approved it in the console, and
 * only for the plan that was approved (lib/ai/mcp/handlers.ts).
 *
 * `legacy: "reject"` is the point of calling the SDK directly. The default, "stateless", still
 * SERVES 2025-era POSTs (it only answers GET/DELETE with 405); "reject" is what actually closes
 * the old protocol generation. POST-only below is complementary, not redundant.
 */

/** A JSON error response with `status`. */
function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * What a token with no agent scope is told: typically a connection made before the agent scopes
 * existed, holding only OIDC scopes. Names the fix and every scope there is to grant.
 */
const INSUFFICIENT_SCOPE_MESSAGE = `This connection was authorized without any Alethia agent scope, so it can use no tools. Disconnect this MCP server in your client, then connect it again and approve the agent scopes it asks for: ${AGENT_SCOPES.join(", ")}. Approve at least read; each scope only narrows what your role allows.`;

/** The response for a token that resolved into no actor. */
function refusalResponse(reason: McpActorRefusal): Response {
	switch (reason) {
		case "no_subject":
			return jsonError(401, "Access token carries no subject.");
		case "insufficient_scope":
			// RFC 6750 §3.1: a client may step up by asking for the scope again. Connections made before
			// the agent scopes existed hold only OIDC scopes, so the body names the fix for a person.
			return jsonError(403, INSUFFICIENT_SCOPE_MESSAGE, {
				"www-authenticate": `Bearer error="insufficient_scope", scope="${AGENT_SCOPES.join(" ")}"`,
			});
		case "org_not_permitted":
			return jsonError(403, "The organization this connection was granted in is not one you belong to. Reconnect.");
		case "project_not_permitted":
			return jsonError(403, "This connection was not granted the project the URL names.");
		case "agent_access_disabled":
			return jsonError(
				403,
				"Agent access is turned off for this organization. An owner can turn it back on in the organization's agent settings.",
			);
	}
}

/** The console origin approval links are built on: the MCP resource's own origin. */
function appOriginOf(resource: string): string {
	return new URL(resource).origin;
}

// 1.7's requireMcpAuth is NOT a rename of withMcpAuth: the second argument is now the
// verified access-token CLAIMS (a JWTPayload), not a session object. The subject claim is
// the user id. It is typed optional, so fail closed rather than coercing — an actor
// resolved from an absent subject would be an actor with no user behind it.
//
// THE THIRD ARGUMENT IS NOT OPTIONAL IN PRACTICE (#3318). Left off, `requireMcpAuth` defaults
// `resource` to the auth BASE URL — `https://<host>/api/auth` — and uses it for two things at
// once: the RFC 9728 `resource_metadata` pointer in the 401 challenge, and the `aud` it demands
// of the access token. `mcp()` binds issued tokens (RFC 8707) to `https://<host>/api/mcp`, so the
// default made the 401 advertise metadata for a resource nobody serves AND made every correctly
// issued token fail audience verification — MCP could not authenticate at all, not just fail to
// be discovered. Same constant as the plugin's; see lib/auth/mcp-resource.ts.
//
// Deleting that argument leaves types, lint and the whole suite green while remote MCP auth is
// dead, which is why tests/app/api/mcp-route-audience.test.ts asserts the value that reaches the
// library rather than trusting the wiring to stay put (#3511).
/** Resolves a verified access token into the actor the request runs as, and answers the request. */
const withActorFromToken: Parameters<typeof requireMcpAuth>[1] = async (req, accessTokenClaims) => {
	const surface = parseSurfaceQuery(new URL(req.url).searchParams);
	if (!surface.ok) return jsonError(400, surface.error);

	const resolved = await resolveMcpActor(accessTokenClaims, surface.query.projectId);
	if (!resolved.ok) return refusalResponse(resolved.reason);
	const { actor } = resolved;

	// The connector is a paid/ee surface; self-host (no Stripe) is always enabled.
	if (!(await isAiSurfaceEnabled(actor.orgId))) {
		return jsonError(403, "AI features require an active plan. Upgrade to use the connector.");
	}

	const appOrigin = appOriginOf(mcpResourceUrl ?? req.url);
	// One server per request: what it lists depends on this request's token and URL.
	const handler = createMcpHandler(
		() => buildMcpServer({ actor, query: surface.query, appOrigin }),
		{ legacy: "reject" },
	);
	// Bind the token-derived actor for the whole request so currentActor()/
	// requireOwner() inside the tools resolve to it instead of a (absent) session.
	return runWithActor(actor, () => handler.fetch(req));
};

/**
 * The deployment cannot form an MCP resource (no absolute, https base URL), so `mcp()` was never
 * registered and there is no OAuth provider behind this route.
 *
 * 503 rather than the library's default 401 (#3511). That default advertises
 * `resource_metadata=…/.well-known/oauth-protected-resource/api/auth` — a document this
 * deployment deliberately 404s, since it describes the authorization server rather than the
 * resource. Pointing a client at a document we answer 404 to is a worse answer than saying the
 * feature is not configured.
 */
function notConfigured(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message:
					"MCP is not configured on this deployment: NEXT_PUBLIC_APP_URL must be an absolute https URL.",
			},
			id: null,
		}),
		{ status: 503, headers: { "content-type": "application/json" } },
	);
}

// The ternary is what keeps `requireMcpAuth` off the unconfigured path entirely: it validates
// `opts.resource` EAGERLY, so calling it with a null resource would throw at module load and take
// the route down instead of answering 503.
const handler =
	mcpResourceUrl === null
		? notConfigured
		: requireMcpAuth(auth, withActorFromToken, { resource: mcpResourceUrl });

// POST only. 1.7's upgrade guide requires dropping the MCP-route GET and DELETE exports
// (the SSE/session transports they served are the `legacy` mode now rejected above).
export { handler as POST };
