// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireMcpAuth } from "@better-auth/mcp";
// The SDK directly, not mcp-handler. mcp-handler v2 is a thin wrapper that hardcodes
// `legacy: "stateless"` and exposes no way to override it, so routing through it would
// make the strict posture below unreachable. better-auth's own MCP docs and demo call the
// SDK the same way.
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { registerAiToolsOnMcp } from "@/lib/ai/mcp/adapter";
import { buildExternalAgentTools } from "@/lib/ai/tools";
import { auth } from "@/lib/auth";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { isAiSurfaceEnabled } from "@/lib/billing/ai-guard";

// Node runtime: the actor seam uses AsyncLocalStorage + the tools reach postgres-js.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Remote MCP endpoint (B7) — exposes the same PDP-gated tool SSOT the in-app agent
 * uses (read surface + service catalog + repo scanner) to Claude / claude.ai
 * connectors over Streamable HTTP. Auth is OAuth 2.1 via Better Auth's mcp() plugin
 * (discovery + token endpoints live under /api/auth + /oauth2); requireMcpAuth
 * validates the access token and yields its session. We resolve that into the same
 * Actor every other caller uses (getActiveScope) and bind it for the request via
 * runWithActor, so the tools enforce the user's grants with no new authority.
 *
 * Read-only by design: we expose the audience-filtered EXTERNAL projection
 * (buildExternalAgentTools → registry.ts), i.e. only read/both tools. HITL
 * proposals, canvas tools, AND job-queuing writes (scan_repo) are excluded — the
 * external surface stays strictly read-only at launch (see the elench plan A5).
 */
// v2 inverts the factory: it RETURNS a server rather than receiving one, and `serverInfo` moves
// to the McpServer constructor. It runs per request, so each call still gets a fresh server.
//
// `legacy: "reject"` is the point of calling the SDK directly. The default, "stateless", still
// SERVES 2025-era POSTs (it only answers GET/DELETE with 405); "reject" is what actually closes
// the old protocol generation. POST-only below is complementary, not redundant.
const mcpHandler = createMcpHandler(
	() => {
		const server = new McpServer(
			{ name: "alethia", version: "1.0.0" },
			{
				instructions:
					"Alethia control-plane tools (read-only): read the user's projects/clusters/jobs/runners, browse the service catalog, and review repo-scan results. Provisioning and repo scans are initiated in the Alethia dashboard with human approval.",
			},
		);
		registerAiToolsOnMcp(server, buildExternalAgentTools());
		return server;
	},
	{ legacy: "reject" },
);

// 1.7's requireMcpAuth is NOT a rename of withMcpAuth: the second argument is now the
// verified access-token CLAIMS (a JWTPayload), not a session object. The subject claim is
// the user id. It is typed optional, so fail closed rather than coercing — an actor
// resolved from an absent subject would be an actor with no user behind it.
const handler = requireMcpAuth(auth, async (_req, accessTokenClaims) => {
	const subject = accessTokenClaims.sub;
	if (typeof subject !== "string" || subject.length === 0) {
		return new Response(JSON.stringify({ error: "Access token carries no subject." }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}
	const actor = await getActiveScope(subject);

	// The connector is a paid/ee surface; self-host (no Stripe) is always enabled.
	if (!(await isAiSurfaceEnabled(actor.orgId))) {
		return new Response(
			JSON.stringify({
				error: "AI features require an active plan. Upgrade to use the connector.",
			}),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	}

	// Bind the token-derived actor for the whole request so currentActor()/
	// requireOwner() inside the tools resolve to it instead of a (absent) session.
	return runWithActor(actor, () => mcpHandler.fetch(_req));
});

// POST only. 1.7's upgrade guide requires dropping the MCP-route GET and DELETE exports
// (the SSE/session transports they served are the `legacy` mode now rejected above).
export { handler as POST };
