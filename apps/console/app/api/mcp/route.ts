// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { withMcpAuth } from "better-auth/plugins";
import { createMcpHandler } from "mcp-handler";
import { registerAiToolsOnMcp } from "@/lib/ai/mcp/adapter";
import { buildAgentTools } from "@/lib/ai/tools";
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
 * (discovery + token endpoints live under /api/auth + /.well-known); withMcpAuth
 * validates the access token and yields its session. We resolve that into the same
 * Actor every other caller uses (getActiveScope) and bind it for the request via
 * runWithActor, so the tools enforce the user's grants with no new authority.
 *
 * Read-only by design: mutations (plan/deploy) stay in the app behind HITL approval,
 * so we expose the "ask" tool set. scan_repo only queues a static analysis job.
 */
// lib/auth annotates `plugins` as BetterAuthOptions["plugins"] (widened, to allow the
// conditional enterprise pushes), which erases per-plugin type inference — so the mcp()
// plugin's getMcpSession isn't surfaced on `auth`'s static type though it exists at
// runtime. Bridge to the exact shape withMcpAuth requires (no behaviour change).
type McpAuthInstance = Parameters<typeof withMcpAuth>[0];

const handler = withMcpAuth(auth as unknown as McpAuthInstance, async (_req, session) => {
	const actor = await getActiveScope(session.userId);

	// The connector is a paid/ee surface; self-host (no Stripe) is always enabled.
	if (!(await isAiSurfaceEnabled(actor.orgId))) {
		return new Response(
			JSON.stringify({
				error: "AI features require an active plan. Upgrade to use the connector.",
			}),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	}

	const mcp = createMcpHandler(
		(server) => {
			registerAiToolsOnMcp(server, buildAgentTools({ mode: "ask" }));
		},
		{
			serverInfo: { name: "alethia", version: "1.0.0" },
			instructions:
				"Alethia control-plane tools: read the user's specs/zones/clusters/jobs/runners, browse the service catalog, and scan a git repo to infer the infrastructure it needs. Provisioning is done in the Alethia dashboard with human approval.",
		},
		{ basePath: "/api" },
	);

	// Bind the token-derived actor for the whole request so currentActor()/
	// requireOwner() inside the tools resolve to it instead of a (absent) session.
	return runWithActor(actor, () => mcp(_req));
});

export { handler as GET, handler as POST, handler as DELETE };
