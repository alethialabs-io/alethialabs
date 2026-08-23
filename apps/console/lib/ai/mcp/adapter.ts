// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolSet } from "ai";
import { z } from "zod";

/**
 * The "one tool layer, two consumers" bridge (B7): re-expose the exact same AI-SDK
 * tool set the in-app agent uses (buildAgentTools()) as MCP tools, so Claude /
 * claude.ai connectors drive the identical PDP-gated surface over the wire. No new
 * authority — each tool's execute() still resolves currentActor() and enforces its
 * verb; the MCP route binds the token-derived actor via runWithActor() first.
 *
 * This function is a generic bridge over whatever tool set it is given. The MCP
 * route MUST pass the READ-ONLY external projection — `buildExternalAgentTools()`
 * (lib/ai/tools), which filters by audience (registry.ts) — so HITL/canvas/
 * job-queuing tools are never exposed to a customer's agent at launch.
 */

/** The runtime slice of an AI-SDK tool the bridge needs. Tool's published type erases
 * the concrete zod schema (FlexibleSchema) and brands execute's input, so we narrow
 * to this structural view at the boundary (the runtime shape is exactly this). */
interface BridgeableTool {
	description?: string;
	inputSchema: z.ZodTypeAny;
	execute?: (input: unknown, options: unknown) => PromiseLike<unknown> | unknown;
}

/** JSON-stringifies a tool result for MCP text content; never throws on cycles/bigint. */
function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
	} catch {
		return String(value);
	}
}

/**
 * Registers every executable tool in `tools` on the MCP server. Tools without an
 * execute() (none today) are skipped; errors thrown by a tool (e.g. ForbiddenError,
 * AiBudgetError) are returned as an MCP tool error so the model can react.
 */
export function registerAiToolsOnMcp(server: McpServer, tools: ToolSet): void {
	for (const [name, def] of Object.entries(tools)) {
		// Bridge the published Tool type to its runtime shape (see BridgeableTool).
		// @ts-expect-error AI-SDK's published Tool type brands execute's input and erases the concrete zod schema; this is its runtime shape
		const tool: BridgeableTool = def;
		const { execute } = tool;
		if (typeof execute !== "function") continue;
		// Pass the WHOLE z.object(), not its raw shape. SDK v2 still accepts a raw shape, but
		// only through a deprecated overload that re-wraps it with the SDK's OWN bundled zod —
		// and a shape authored by a different zod instance either fails at registration or
		// silently loses every `.describe()`, because those descriptions live in the authoring
		// zod's registry. The descriptions are how the model knows what the arguments mean.
		const inputSchema = tool.inputSchema instanceof z.ZodObject ? tool.inputSchema : z.object({});
		server.registerTool(
			name,
			{ description: tool.description ?? name, inputSchema },
			async (args: unknown) => {
				try {
					const result = await execute(args ?? {}, {
						toolCallId: `mcp_${name}`,
						messages: [],
					});
					return { content: [{ type: "text" as const, text: stringify(result) }] };
				} catch (err) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: err instanceof Error ? err.message : String(err),
							},
						],
					};
				}
			},
		);
	}
}
