// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolSet } from "ai";
import { z } from "zod";

/**
 * A generic bridge that registers an AI-SDK tool set (the in-app agent's tools) as MCP tools under
 * their in-app names.
 *
 * THE MCP SERVER NO LONGER USES IT. `lib/ai/mcp/server.ts` lists only the declared external tools
 * (`lib/ai/mcp/surface.ts`), and each declared read answers through the in-app tools it `replaces`
 * by running them in-process (`lib/ai/mcp/in-app.ts`), not by registering them. What still calls
 * this bridge is `tests/lib/ai/tools/registry.test.ts`, which serialises the in-app external
 * projection with it. Any caller must pass that READ-ONLY projection — `buildExternalAgentTools()`
 * (lib/ai/tools), filtered by audience (registry.ts) — never the full in-app set, whose HITL, canvas
 * and job-queuing tools must not reach a customer's agent.
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

/** Told about every finished call: the tool, how long it took, and the error when it failed. */
export type ToolCallObserver = (tool: string, latencyMs: number, error?: unknown) => Promise<void>;

/**
 * Registers every executable tool in `tools` on the MCP server. `observe`, when given, is told about
 * each call after it finishes (the MCP server records it in `agent_tool_calls`). Tools without an
 * execute() (none today) are skipped; errors thrown by a tool (e.g. ForbiddenError,
 * AiBudgetError) are returned as an MCP tool error so the model can react.
 */
export function registerAiToolsOnMcp(
	server: McpServer,
	tools: ToolSet,
	observe?: ToolCallObserver,
): void {
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
				const started = Date.now();
				try {
					const result = await execute(args ?? {}, {
						toolCallId: `mcp_${name}`,
						messages: [],
					});
					await observe?.(name, Date.now() - started);
					return { content: [{ type: "text" as const, text: stringify(result) }] };
				} catch (err) {
					await observe?.(name, Date.now() - started, err);
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
