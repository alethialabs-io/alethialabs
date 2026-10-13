// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The turn key (ADR 0003 §3, §5.2): which attempt a chat request is, derived from the STORED
// transcript, so two tabs, a Retry and a duplicated request all name the same claim. Pure and
// shared client + server: the transport derives a continuation's tool call ids with the same
// `pendingClientToolCalls` the server runs over the locked row, and ADR 0001 imports `turnText`
// for `hasTurn` rather than defining its own.
//
// Nothing here reads a database or a clock. `classifyTurn` decides §5.2's table; the claim row of
// the key it returns then decides C1-C4 (§5.1 step 4), which is slice 5's `reserveTurn`.

import {
	type DynamicToolUIPart,
	getToolName,
	isToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import { z } from "zod";
import { CLIENT_TOOL_ACCEPTED_STATUS, isClientToolName } from "@/lib/ai/client-tools";

/**
 * The text a turn is compared by (ADR 0003 §5.2, the one definition ADR 0001 imports): the
 * message's `text` parts joined in order with no separator; then U+0000 removed and
 * `toWellFormed()` (ADR 0001 §4.1's normalization); then `\r\n` and `\r` to `\n`; then trimmed.
 * No other part type and no `metadata` field takes part. Applied to both sides of a comparison,
 * so a turn typed with a trailing newline equals the same turn stored trimmed.
 */
export function turnText(message: UIMessage): string {
	let joined = "";
	for (const part of message.parts) {
		if (part.type === "text") joined += part.text;
	}
	return joined
		.replaceAll("\u0000", "")
		.toWellFormed()
		.replace(/\r\n?/g, "\n")
		.trim();
}

/** A tool part of a UI message, static or dynamic. */
type ToolPart = ToolUIPart | DynamicToolUIPart;

/**
 * The client-tool parts of a message (tool name in `CLIENT_TOOL_NAMES`, not
 * `providerExecuted`), grouped by step. A step is the parts after a `step-start`; parts before
 * the first `step-start` form a step of their own.
 */
function clientToolPartsBySteps(message: UIMessage): ToolPart[][] {
	const steps: ToolPart[][] = [[]];
	for (const part of message.parts) {
		if (part.type === "step-start") {
			steps.push([]);
			continue;
		}
		if (!isToolUIPart(part)) continue;
		if (part.providerExecuted === true) continue;
		if (!isClientToolName(getToolName(part))) continue;
		steps[steps.length - 1]?.push(part);
	}
	return steps;
}

/**
 * The client-tool parts of the LAST step of `message` that holds any (ADR 0003 §3). For an
 * answer that ends on a proposal this is its last step; for an answer whose continuation has
 * run, it is still the approval's step, because the continuation's steps hold no client tool.
 */
function pendingClientToolParts(message: UIMessage): ToolPart[] {
	const steps = clientToolPartsBySteps(message);
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step && step.length > 0) return step;
	}
	return [];
}

/**
 * The pending client tool calls of an answer (ADR 0003 §3): the ids of the client-tool parts of
 * the last step that holds any, sorted. It reads tool names and `providerExecuted` only, never
 * whether an output is present, so the client's copy (outputs just added) and the stored row
 * (outputs not yet stored, or stored) give the same set, and a server tool in the same step
 * (`list_projects` beside `propose_operation`) never enters it (case 7b).
 */
export function pendingClientToolCalls(message: UIMessage): string[] {
	return pendingClientToolParts(message)
		.map((p) => p.toolCallId)
		.sort();
}

/** Reads the `status` of a stored tool output, whatever else it holds. */
const outputStatusSchema = z.object({ status: z.string() });

/**
 * True when `message` carries an accepted approval (ADR 0003 §5.2): one of its client-tool parts
 * has a stored output whose `status` is its tool's accepted status (`approved` for
 * `propose_operation`, a plan or deploy was queued; `submitted` for `create_support_case`, a case
 * was opened). Such an answer is never regenerated away. An accepted `propose_changes` does not
 * count: it was applied to the canvas in the browser and queued nothing server-side, so its
 * tool has no accepted status. Only the `status` is read, not the full schema, so a stored
 * output that predates validation still counts: refusing a regenerate is the safe direction.
 */
export function hasAcceptedApproval(message: UIMessage): boolean {
	for (const step of clientToolPartsBySteps(message)) {
		for (const part of step) {
			if (part.state !== "output-available") continue;
			const name = getToolName(part);
			if (!isClientToolName(name)) continue;
			const parsed = outputStatusSchema.safeParse(part.output);
			if (parsed.success && parsed.data.status === CLIENT_TOOL_ACCEPTED_STATUS[name]) {
				return true;
			}
		}
	}
	return false;
}

/** The ids of `message`'s tool parts that carry an output, of any tool. */
function toolCallIdsWithOutput(message: UIMessage): Set<string> {
	const ids = new Set<string>();
	for (const part of message.parts) {
		if (isToolUIPart(part) && part.state === "output-available") ids.add(part.toolCallId);
	}
	return ids;
}

/** The attempt key of a continuation of answer `answerId` after `toolCallIds` (ADR 0003 §3). */
export function continuationKey(answerId: string, toolCallIds: readonly string[]): string {
	return `continue:${answerId}:${[...toolCallIds].sort().join(",")}`;
}

/** The attempt key of a regenerate of answer `answerId` (ADR 0003 §3). */
export function regenerateKey(answerId: string): string {
	return `regen:${answerId}`;
}

/** The turn fields a request carries (ADR 0003 §9.1). */
export interface TurnRequest {
	trigger: "submit-message" | "regenerate-message";
	/** The id of the request's last user message. */
	turnId: string;
	/** The revision of the transcript the requesting tab holds. */
	baseRevision: number;
	/** A regenerate's answer, or a continuation's (the request's last assistant message). */
	answerId?: string;
	/** A continuation's pending client tool calls, as the client derived them. */
	toolCallIds?: readonly string[];
}

/** What the classifier needs to know of a claim row of the thread (ADR 0003 §4.1). */
export interface ClaimSnapshot {
	attemptKey: string;
	state: "running" | "answered" | "failed" | "expired";
	partial: boolean;
}

/** The input of {@link classifyTurn}. */
export interface ClassifyTurnInput {
	turn: TurnRequest;
	/** The request's messages (the client's list). Only `u` and the continued answer are read. */
	requestMessages: readonly UIMessage[];
	/** `T`: the locked row's messages. */
	stored: readonly UIMessage[];
	/** The locked row's revision. */
	revision: number;
	/** The thread's claim rows. Only a continuation reads them (the retry and resume arms). */
	claims: readonly ClaimSnapshot[];
}

/** A refusal §5.2 decides, before any claim row is read. */
export type TurnKeyRefusal =
	| "transcript-stale"
	| "turn-committed-different-text"
	| "turn-answered"
	| "turn-has-accepted-approval";

/**
 * The outcome of {@link classifyTurn}.
 *
 * - `accept`: the attempt key. The claim row of that key then decides (§5.1 step 4): none (C1),
 *   `failed`/`expired` (C2), `running` (C3), `answered` (C4) — except a `resume`, which IS the
 *   C4r arm and re-arms an `answered`, `partial` claim.
 *   - `answer`: `appendTurn` says whether step 8 appends `u` (it is not yet stored).
 *   - `continue`: `mode` is `first` (no output of `P` is stored: step 8 stores the request's),
 *     `retry` (all are stored and the claim exists: the stored outputs win), or `resume` (C4r).
 * - `refuse`: a §9.3 refusal with the flags the transcript decides; the caller adds `revision`.
 * - `invalid`: the request's messages contradict its `turn` fields. A 400, never a claim.
 */
export type TurnClassification =
	| { outcome: "accept"; kind: "answer"; attemptKey: "answer"; appendTurn: boolean }
	| { outcome: "accept"; kind: "regenerate"; attemptKey: string; answerId: string }
	| {
			outcome: "accept";
			kind: "continue";
			attemptKey: string;
			answerId: string;
			pending: string[];
			mode: "first" | "retry" | "resume";
	  }
	| {
			outcome: "refuse";
			refusal: TurnKeyRefusal;
			turnId: string;
			committed: boolean;
			textCommitted: boolean;
			answered: boolean;
			answerId: string | null;
	  }
	| { outcome: "invalid"; reason: string };

/** The stored-transcript facts every refusal reports for `turnId`. */
function storedTurnFacts(
	stored: readonly UIMessage[],
	turnId: string,
): { committed: boolean; answered: boolean; answerId: string | null } {
	const i = stored.findIndex((m) => m.id === turnId);
	if (i < 0) return { committed: false, answered: false, answerId: null };
	const next = stored[i + 1];
	return {
		committed: true,
		answered: next !== undefined,
		answerId: next?.role === "assistant" ? next.id : null,
	};
}

/** A refusal whose flags follow the stored transcript (`textCommitted` equals `committed`). */
function refuse(
	input: ClassifyTurnInput,
	refusal: TurnKeyRefusal,
): Extract<TurnClassification, { outcome: "refuse" }> {
	const facts = storedTurnFacts(input.stored, input.turn.turnId);
	return {
		outcome: "refuse",
		refusal,
		turnId: input.turn.turnId,
		committed: facts.committed,
		textCommitted: facts.committed,
		answered: facts.answered,
		answerId: facts.answerId,
	};
}

/**
 * The submit rows of §5.2, which a Retry (`regenerate-message` with no `answerId`) shares: the
 * request's last message is the user turn `u`. The different-text row is checked first, so an
 * edited re-send is never read as answered or in progress.
 */
function classifySubmit(input: ClassifyTurnInput): TurnClassification {
	const { turn, stored } = input;
	const u = input.requestMessages.at(-1);
	if (u === undefined || u.role !== "user" || u.id !== turn.turnId) {
		return { outcome: "invalid", reason: "the turn is not the request's last message" };
	}
	const i = stored.findIndex((m) => m.id === turn.turnId);
	if (i < 0) {
		if (input.revision !== turn.baseRevision) return refuse(input, "transcript-stale");
		return { outcome: "accept", kind: "answer", attemptKey: "answer", appendTurn: true };
	}
	const storedTurn = stored[i];
	if (storedTurn === undefined || storedTurn.role !== "user") {
		return { outcome: "invalid", reason: "the turn id names a stored non-user message" };
	}
	if (turnText(u) !== turnText(storedTurn)) {
		return {
			...refuse(input, "turn-committed-different-text"),
			textCommitted: false,
		};
	}
	if (i === stored.length - 1) {
		return { outcome: "accept", kind: "answer", attemptKey: "answer", appendTurn: false };
	}
	return refuse(input, "turn-answered");
}

/** The regenerate rows of §5.2: `regen:a` for the stored last answer of the turn, or a refusal. */
function classifyRegenerate(input: ClassifyTurnInput, answerId: string): TurnClassification {
	const { turn, stored } = input;
	const ai = stored.findIndex((m) => m.id === answerId);
	const a = stored[ai];
	if (a !== undefined && a.role === "assistant" && hasAcceptedApproval(a)) {
		return {
			outcome: "refuse",
			refusal: "turn-has-accepted-approval",
			turnId: turn.turnId,
			committed: true,
			textCommitted: true,
			answered: true,
			answerId,
		};
	}
	const isLast = a !== undefined && ai === stored.length - 1 && a.role === "assistant";
	const answersTurn = ai > 0 && stored[ai - 1]?.id === turn.turnId;
	if (isLast && answersTurn && input.revision === turn.baseRevision) {
		return {
			outcome: "accept",
			kind: "regenerate",
			attemptKey: regenerateKey(answerId),
			answerId,
		};
	}
	return refuse(input, "turn-answered");
}

/** True when two id lists hold the same ids. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((id, k) => id === sb[k]);
}

/**
 * The two continuation rows of §5.2: the request's last message is the assistant message `a`,
 * whose pending client tool calls `P` received outputs. Accepts `continue:a:<P>` on the first
 * approval, on a retry of a continuation whose claim exists, and as the resume (C4r) of one that
 * ended partial; everything else is `turn-answered`.
 */
function classifyContinuation(input: ClassifyTurnInput): TurnClassification {
	const { turn, stored } = input;
	const requestA = input.requestMessages.at(-1);
	const a = stored.at(-1);
	const answerId = turn.answerId;
	if (
		answerId === undefined ||
		requestA === undefined ||
		requestA.id !== answerId ||
		a === undefined ||
		a.id !== answerId ||
		a.role !== "assistant"
	) {
		return refuse(input, "turn-answered");
	}
	const pending = pendingClientToolCalls(a);
	if (pending.length === 0 || !sameIds(turn.toolCallIds ?? [], pending)) {
		return refuse(input, "turn-answered");
	}
	const sent = toolCallIdsWithOutput(requestA);
	if (!pending.every((id) => sent.has(id))) return refuse(input, "turn-answered");

	const attemptKey = continuationKey(answerId, pending);
	const storedOutputs = toolCallIdsWithOutput(a);
	const storedCount = pending.filter((id) => storedOutputs.has(id)).length;

	if (storedCount === 0 && input.revision === turn.baseRevision) {
		return { outcome: "accept", kind: "continue", attemptKey, answerId, pending, mode: "first" };
	}
	if (storedCount === pending.length) {
		const claim = input.claims.find((c) => c.attemptKey === attemptKey);
		if (claim !== undefined) {
			const resume =
				claim.state === "answered" &&
				claim.partial &&
				input.revision === turn.baseRevision;
			return {
				outcome: "accept",
				kind: "continue",
				attemptKey,
				answerId,
				pending,
				mode: resume ? "resume" : "retry",
			};
		}
	}
	return refuse(input, "turn-answered");
}

/**
 * Classifies a chat request against the locked transcript (ADR 0003 §5.2, the whole table) and
 * returns its attempt key or the refusal the transcript decides. Which rows apply: a regenerate
 * with an `answerId` takes the regenerate rows (the accepted-approval refusal first); a request
 * whose last message is an assistant message is a continuation and takes the continuation rows
 * ONLY; a submit or a Retry with the user turn last takes the submit rows, the different-text
 * row first.
 */
export function classifyTurn(input: ClassifyTurnInput): TurnClassification {
	const { turn } = input;
	if (turn.trigger === "regenerate-message") {
		return turn.answerId === undefined
			? classifySubmit(input)
			: classifyRegenerate(input, turn.answerId);
	}
	if (input.requestMessages.at(-1)?.role === "assistant") return classifyContinuation(input);
	return classifySubmit(input);
}
