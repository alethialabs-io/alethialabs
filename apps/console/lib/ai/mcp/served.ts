// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What every declared tool's handler is built from: the caller's context, the refusal a tool answers
// with, and `served`, which binds a handler to its contract's own input and output schemas. Kept apart
// from the handler modules so each of them (operations, reads, design) can be loaded on its own.

import "server-only";
import type { z } from "zod";
import type { AgentScope } from "@/lib/approvals/types";
import type { Actor } from "@/lib/authz/types";

/** Who is calling, and where the console a person approves in lives. */
export interface HandlerContext {
	actor: Actor;
	/** The console's origin, e.g. `https://alethialabs.io`; approval links are built on it. */
	appOrigin: string;
}

/** A refusal a tool answers with: a machine-readable code and a sentence for the person. */
export class McpToolRefusal extends Error {
	/** The machine-readable reason. */
	readonly code: string;

	/** Builds the refusal from its reason and the sentence to show. */
	constructor(code: string, message: string) {
		super(message);
		this.name = "McpToolRefusal";
		this.code = code;
	}
}

/** The schemas of one declared tool. */
interface ToolSchemas<I extends z.ZodObject, O extends z.ZodObject> {
	scope: AgentScope | null;
	inputSchema: I;
	outputSchema: O;
}

/** One served tool: the scope it needs and the call that validates, runs and validates again. */
export interface HandledTool {
	scope: AgentScope | null;
	call(rawInput: unknown, ctx: HandlerContext): Promise<Record<string, unknown>>;
}

/**
 * Pairs a declared tool's schemas with its handler. The input is parsed by the tool's own schema and
 * the result by its own output schema, so a handler can return neither more nor other than the
 * contract says.
 */
export function served<I extends z.ZodObject, O extends z.ZodObject>(
	contract: ToolSchemas<I, O>,
	run: (input: z.output<I>, ctx: HandlerContext) => Promise<z.input<O>>,
): HandledTool {
	const output: z.ZodObject = contract.outputSchema;
	return {
		scope: contract.scope,
		call: async (rawInput, ctx) => output.parse(await run(contract.inputSchema.parse(rawInput), ctx)),
	};
}
