// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runs an in-app agent tool in-process for the declared read tools (lib/ai/mcp/reads.ts). The
// declared reads answer through the very tools their contract entry names in `replaces`, so the
// external surface and the in-app agent read through one layer: same server actions, same PDP
// verbs, same secret-free trimming. Only the shape of the answer differs.

import "server-only";
import type { Tool } from "ai";

/** True when `value` is an async iterable: a streaming tool result, which a read tool never is. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * Calls `tool`'s execute with `input` and returns its result. The tool resolves the caller itself
 * (the MCP route bound the token's actor with `runWithActor`) and checks its own verb, so this adds
 * no authority. A tool without an execute, or one that streams, is a programming error here.
 */
export async function runInAppTool<I, O>(name: string, tool: Tool<I, O>, input: I): Promise<O> {
	const { execute } = tool;
	if (!execute) throw new Error(`The in-app tool ${name} has no execute.`);
	const result = execute(input, { toolCallId: `mcp:${name}`, messages: [] });
	if (isAsyncIterable(result)) throw new Error(`The in-app tool ${name} streams its result.`);
	return await result;
}
