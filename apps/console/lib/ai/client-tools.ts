// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The client tools (ADR 0003 §3): the tools a route declares WITHOUT `execute`, so their
// output can only come from the browser (`addToolOutput`). Shared client + server, so this
// module imports nothing but zod: the transport, the routes' tool sets and the claim
// (`lib/agent/turn-key.ts`, and slice 5's `reserveTurn`) all read this one list.
//
// The outputs are browser input that every later model call of the thread reads, so they
// are validated before they are stored (ADR 0003 §5.1 step 8): one schema per tool, mirroring
// the card that produces it, and a 4,096-byte cap on the JSON.

import { z } from "zod";

/**
 * The names of the client tools. A test pins this list to the tools without `execute` in
 * `buildAgentTools`, `buildProjectAgentTools` and `buildSupportTools`, so a new HITL tool
 * cannot be added to a route without being added here. `propose_changes` is the project
 * assistant's canvas proposal (`lib/ai/tools/compose.ts`): it has no `execute` either, so its
 * output also arrives from the browser and is validated like the other two.
 */
export const CLIENT_TOOL_NAMES = [
	"propose_operation",
	"create_support_case",
	"propose_changes",
] as const;

/** One of {@link CLIENT_TOOL_NAMES}. */
export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number];

/** The cap on one client tool output, in bytes of its UTF-8 JSON (ADR 0003 §5.1 step 8). */
export const CLIENT_TOOL_OUTPUT_MAX_BYTES = 4096;

/** The cap on a free-text `reason` in a client tool output, in characters. */
const REASON_MAX_CHARS = 2000;

/**
 * `propose_operation`'s output: the discriminated union `components/agent/approval-card.tsx`
 * passes to `onResolve` — approved (a plan or deploy job was queued), denied (the gate or the
 * action refused, with its sentence) or rejected (the user declined).
 */
export const proposeOperationOutputSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("approved"),
		operation: z.enum(["plan_project", "provision_project"]),
		projectId: z.uuid(),
		environmentId: z.uuid().nullable(),
		jobId: z.uuid(),
	}),
	z.object({
		status: z.literal("denied"),
		reason: z.string().max(REASON_MAX_CHARS),
	}),
	z.object({ status: z.literal("rejected") }),
]);

/**
 * `create_support_case`'s output: the discriminated union
 * `components/support/ask/support-case-approval-card.tsx` passes to `onResolve` — submitted (a
 * case was opened), failed (opening it threw) or dismissed (the user declined).
 */
export const createSupportCaseOutputSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("submitted"),
		caseId: z.uuid(),
		caseNumber: z.number().int(),
	}),
	z.object({
		status: z.literal("failed"),
		reason: z.string().max(REASON_MAX_CHARS),
	}),
	z.object({ status: z.literal("dismissed") }),
]);

/**
 * `propose_changes`' output: what `components/agent/render-tool-parts/project-tool-parts.tsx`
 * sends when the user clicks Accept, the only output that card produces. `label` echoes the
 * proposal's own label, which the model wrote, so it has no length rule of its own: the
 * 4,096-byte cap on the whole output bounds it.
 */
export const proposeChangesOutputSchema = z.object({
	status: z.literal("accepted"),
	label: z.string(),
});

/** The output schema of each client tool, keyed by its name. */
export const CLIENT_TOOL_OUTPUT_SCHEMAS = {
	propose_operation: proposeOperationOutputSchema,
	create_support_case: createSupportCaseOutputSchema,
	propose_changes: proposeChangesOutputSchema,
} satisfies Record<ClientToolName, z.ZodType>;

/**
 * The output `status` that means the card's action already ran on the SERVER and cannot be
 * undone: a plan or deploy was queued, or a support case was opened. An answer holding one
 * "carries an accepted approval" (ADR 0003 §5.2) and is never regenerated away.
 *
 * `propose_changes` has none (`null`): an accepted canvas proposal is applied in the browser,
 * to the canvas the user is editing, and queues nothing server-side, so it is not an accepted
 * approval and does not stop a regenerate.
 */
export const CLIENT_TOOL_ACCEPTED_STATUS = {
	propose_operation: "approved",
	create_support_case: "submitted",
	propose_changes: null,
} satisfies Record<ClientToolName, string | null>;

/** Narrows a tool name to a {@link ClientToolName}. */
export function isClientToolName(name: string): name is ClientToolName {
	return CLIENT_TOOL_NAMES.some((n) => n === name);
}

/** The result of {@link parseClientToolOutput}. */
export type ClientToolOutputResult =
	| { ok: true; output: z.infer<(typeof CLIENT_TOOL_OUTPUT_SCHEMAS)[ClientToolName]> }
	| { ok: false; error: "too-large" | "invalid" };

/**
 * Validates one browser-supplied client tool output before it is stored: first the byte cap on
 * its JSON (so an oversized value is refused without being walked by the schema), then the
 * tool's schema. On success the parsed value is returned with unknown keys stripped, and that
 * value, never the raw one, is what a caller stores.
 */
export function parseClientToolOutput(
	toolName: ClientToolName,
	output: unknown,
): ClientToolOutputResult {
	const json = JSON.stringify(output);
	// `JSON.stringify(undefined)` is undefined: no output is not a valid output.
	if (json === undefined) return { ok: false, error: "invalid" };
	if (new TextEncoder().encode(json).byteLength > CLIENT_TOOL_OUTPUT_MAX_BYTES) {
		return { ok: false, error: "too-large" };
	}
	const parsed = CLIENT_TOOL_OUTPUT_SCHEMAS[toolName].safeParse(output);
	return parsed.success ? { ok: true, output: parsed.data } : { ok: false, error: "invalid" };
}
