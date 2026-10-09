// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The shared body of the two single-model chat routes on the claim, ADR 0003 slice 8
// (`docs/adr/0003-chat-turn-answered-and-billed-once.md`, Q11): `/api/agent/[agentId]`, and
// `/api/support/ask` for a request that names a thread. A support request with no `threadId` does not
// come here: it keeps its per-request hold (§12).
//
// It is the slice 6 route body (`lib/agent/turn-route.ts`, `serveTurn`) for a route that runs ONE model
// on every step, with two differences that route body cannot express: the thread kind and the ledger
// kind are the route's own (`support` for the support route), and a route may add its own check under
// the resolved actor, before the hold (the agent identity's tenancy-scoped lookup). Slice 8 imports
// `turn-route.ts` and never edits it (§14), so the stream half is repeated here rather than shared; the
// R tests (`tests/api/support-turn-routes.test.ts`) pin it to the same behaviour.
//
// The order of refusals (§9.3), every one before the budget hold:
//   401 no session · 503 AI not configured · 400 malformed body · 413 over-long turn ·
//   409 client-outdated (no `orgId` or no `turn`) · 400 malformed turn, thread id or approval output ·
//   403 org-forbidden (§6.1) · the route's own check (a 404) · 404 project-not-found (§6.2) · then
//   `reserveTurn`'s own refusals and the 402 budget refusal, all inside its one transaction (§5.1).
//
// MONEY. The hold is reserved only by `reserveTurn` and settled or released only by `finalizeTurn`,
// called exactly once per accepted attempt through `finalizeOnce`: from the end of the model stream
// (before `finish` is written), from the stream's own `onError`, and as C7 from the pre-stream `catch`.
//
// TENANCY. `userId` is the verified session's, never the body's. `orgId` is validated as a uuid before
// `resolveTurnActor` (whose enterprise resolver casts it `::uuid`), the thread's pin wins over it, and
// from the org gate on everything runs inside `runWithActor`, so the route's check, the tools and every
// nested `currentActor()` resolve the billing org, not the session's.

import {
	type AsyncIterableStream,
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateId,
	getToolName,
	isToolUIPart,
	readUIMessageStream,
	stepCountIs,
	streamText,
	type ToolSet,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isClientToolName, parseClientToolOutput } from "@/lib/ai/client-tools";
import { textToAiOutput, uiMessagesToAiInput } from "@/lib/ai/ai-observability";
import { refuseUserMessage } from "@/lib/ai/message-limits";
import { cachedSystemMessage, thinkingOptions } from "@/lib/ai/provider-options";
import { getOwner } from "@/lib/auth/owner";
import { getPdp } from "@/lib/authz";
import { runWithActor } from "@/lib/authz/actor-context";
import { resolveTurnActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import type { AgentStep } from "@/lib/billing/agent-metering";
import type { MeteredAiKind } from "@/lib/billing/ai-guard";
import { isAiConfigured, type ResolvedModel } from "@/lib/config/ai";
import { getServiceDb } from "@/lib/db";
import { agentThreads, projects } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import {
	type AcceptedTurn,
	type FinalizeResult,
	finalizeTurn,
	heartbeatTurn,
	reserveTurn,
	TURN_BUDGET_MS,
	TURN_HEARTBEAT_MS,
	type TurnOutcome,
	type TurnRefusal,
	type TurnRefusalCode,
	turnIdSchema,
	turnRefusal,
	TURN_REFUSAL_STATUS,
} from "./turn-claims";
import { pendingClientToolCalls, type TurnRequest } from "./turn-key";

/** The transient part the stream opens with, once the turn is accepted (ADR 0003 §5.1 step 9). */
const TURN_ACCEPTED_PART = "data-turn-accepted";

/** The transient part written after finalize stored the answer, before `finish` (§5.3). */
const TURN_FINISHED_PART = "data-turn-finished";

/** The request's turn fields (§9.1), as the slice 6 route body reads them. */
const turnFieldsSchema = z.object({
	trigger: z.enum(["submit-message", "regenerate-message"]),
	turnId: turnIdSchema,
	baseRevision: z.number().int().min(0),
	answerId: z.string().min(1).max(256).optional(),
	toolCallIds: z.array(z.string().min(1).max(256)).max(64).optional(),
});

/** The fields every claimed request carries, whatever its route. */
export interface ClaimedTurnBody<R> {
	messages: UIMessage[];
	/** The thread the turn belongs to. Required; validated as a uuid here. */
	threadId: unknown;
	/** The route's own fields. */
	route: R;
}

/** What a route's own check answers: the thread's project and what `prepare` needs, or a refusal. */
export type ClaimedTurnGate<G> =
	| { ok: true; projectId: string | null; context: G }
	| { ok: false; response: Response };

/** The prompt, tools and model of an accepted turn: one model on every step. */
export interface SingleModelTurn {
	system: string;
	tools: ToolSet;
	model: ResolvedModel;
	/** Extended thinking on every step (the provider's own options; none for a non-Anthropic model). */
	thinking: boolean;
}

/** The route-specific half of a claimed single-model route. */
export interface ClaimedTurnSpec<R, G> {
	/** The thread kind the route answers (`agent_threads.kind`). */
	threadKind: "agent" | "support";
	/** The ledger kind of the turn's hold. */
	aiKind: MeteredAiKind;
	/** Parse the route's body: a 400 with `message` when it is malformed. Runs before the 413. */
	parseBody(raw: object): { ok: true; value: ClaimedTurnBody<R> } | { ok: false; message: string };
	/**
	 * The route's own check, under the resolved actor and before the hold: what the thread's project is
	 * and what `prepare` needs, or the refusal to answer. Runs again when the thread's pin moved.
	 */
	gate(actor: Actor, route: R): Promise<ClaimedTurnGate<G>>;
	/**
	 * Build the prompt, tools and model of an accepted turn. Runs inside `runWithActor`; a throw here
	 * finalizes the attempt as C7 (failed, hold released) and is rethrown.
	 */
	prepare(input: { actor: Actor; turn: AcceptedTurn; route: R; context: G }): Promise<SingleModelTurn>;
}

/** A JSON response. */
function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A typed refusal (§9.3) as its response. */
function refusalResponse(body: TurnRefusal): Response {
	return json(body, TURN_REFUSAL_STATUS[body.refusal]);
}

/** A refusal decided before the transcript is read: nothing about the turn is known yet. */
function earlyRefusal(code: TurnRefusalCode, turnId: string | null): Response {
	return refusalResponse(turnRefusal(code, turnId, [], null));
}

/**
 * The first three refusals of §9.3, shared by both routes so that the support route can read the body
 * once and then choose its path: 401 without a verified session, 503 when AI is not configured, 400
 * when the body is not a JSON object.
 */
export async function readTurnRequest(
	req: Request,
	aiDisabledMessage: string,
): Promise<{ ok: true; userId: string; raw: object } | { ok: false; response: Response }> {
	const userId = await getOwner();
	if (!userId) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
	if (!isAiConfigured()) return { ok: false, response: new Response(aiDisabledMessage, { status: 503 }) };
	const raw: unknown = await req.json().catch(() => null);
	if (raw === null || typeof raw !== "object") {
		return { ok: false, response: new Response("The request body is malformed.", { status: 400 }) };
	}
	return { ok: true, userId, raw };
}

/**
 * True when every output the browser sent for the pending client tool calls of a continuation's
 * answer passes its schema and byte cap (§5.1 step 8), checked here so a bad approval output is a 400
 * before the org check; `reserveTurn` checks it again on the stored answer, under its lock.
 */
function approvalOutputsValid(messages: readonly UIMessage[]): boolean {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant") return true;
	const pending = new Set(pendingClientToolCalls(last));
	for (const part of last.parts) {
		if (!isToolUIPart(part) || !pending.has(part.toolCallId)) continue;
		if (part.state !== "output-available") continue;
		const name = getToolName(part);
		if (!isClientToolName(name)) continue;
		if (!parseClientToolOutput(name, part.output).ok) return false;
	}
	return true;
}

/**
 * The thread's billing pin, read without a lock and with an explicit owner predicate (§6.1). Null
 * for an unpinned thread or one the caller does not own; `reserveTurn` re-reads it under the lock.
 */
async function readThreadPin(threadId: string, userId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ billingOrgId: agentThreads.billing_org_id })
		.from(agentThreads)
		.where(and(eq(agentThreads.id, threadId), eq(agentThreads.user_id, userId)));
	return row?.billingOrgId ?? null;
}

/**
 * The project check (§6.2): the project exists IN the actor's org and the actor may view it. Either
 * failing is the same 404, so a status code never confirms that a project id exists in another org.
 */
async function projectVisible(actor: Actor, projectId: string): Promise<boolean> {
	if (!z.uuid().safeParse(projectId).success) return false;
	const [row] = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.org_id, actor.orgId)));
	if (!row) return false;
	const decision = await getPdp().can(actor, "view", { type: "project", id: projectId });
	return decision.allowed;
}

/** The org gate, the route's own check and the project gate: the actor, or the refusal to answer. */
async function resolveGates<R, G>(
	userId: string,
	orgId: string,
	turnId: string,
	spec: ClaimedTurnSpec<R, G>,
	route: R,
): Promise<{ ok: true; actor: Actor; projectId: string | null; context: G } | { ok: false; response: Response }> {
	const actor = await resolveTurnActor(userId, orgId);
	if (!actor || actor.userId !== userId) {
		return { ok: false, response: earlyRefusal("org-forbidden", turnId) };
	}
	const gate = await runWithActor(actor, () => spec.gate(actor, route));
	if (!gate.ok) return gate;
	if (gate.projectId !== null && !(await projectVisible(actor, gate.projectId))) {
		return { ok: false, response: earlyRefusal("project-not-found", turnId) };
	}
	return { ok: true, actor, projectId: gate.projectId, context: gate.context };
}

/**
 * Serve one claimed request of a single-model route (ADR 0003 slice 8): refuse in §9.3's order, accept
 * through `reserveTurn` under the resolved actor with the route's thread and ledger kinds, and stream
 * the model's answer, finalized exactly once. `userId` and `raw` come from {@link readTurnRequest}.
 */
export async function serveClaimedTurn<R, G>(
	req: Request,
	userId: string,
	raw: object,
	spec: ClaimedTurnSpec<R, G>,
): Promise<Response> {
	const parsed = spec.parseBody(raw);
	if (!parsed.ok) return new Response(parsed.message, { status: 400 });
	const body = parsed.value;
	const tooLong = refuseUserMessage(body.messages);
	if (tooLong) return tooLong;

	// A request without either field was built for the per-request hold: refused before anything is billed.
	const orgIdRaw = "orgId" in raw ? raw.orgId : undefined;
	const turnRaw = "turn" in raw ? raw.turn : undefined;
	if (orgIdRaw === undefined || orgIdRaw === null || turnRaw === undefined || turnRaw === null) {
		return earlyRefusal("client-outdated", null);
	}
	const turnParsed = turnFieldsSchema.safeParse(turnRaw);
	if (!turnParsed.success) return new Response("The request's turn is malformed.", { status: 400 });
	const turn: TurnRequest = turnParsed.data;
	const threadParsed = z.uuid().safeParse(body.threadId);
	if (!threadParsed.success) {
		return new Response("The request's threadId is missing or invalid.", { status: 400 });
	}
	const threadId = threadParsed.data;
	if (!approvalOutputsValid(body.messages)) {
		return new Response("An approval output is malformed or too large.", { status: 400 });
	}

	// A uuid BEFORE the resolver: its enterprise arm casts the id `::uuid`, so a malformed one would
	// throw (a 500) instead of answering 403.
	const orgParsed = z.uuid().safeParse(orgIdRaw);
	if (!orgParsed.success) return earlyRefusal("org-forbidden", turn.turnId);
	// The thread's pin wins over the request's org (§6.1); the request's org pins a first turn.
	let billingOrgId = (await readThreadPin(threadId, userId)) ?? orgParsed.data;

	// One re-run when a racing first turn pinned the thread after the read above (§5.1 step 2).
	for (let attempt = 0; attempt < 2; attempt++) {
		const gate = await resolveGates(userId, billingOrgId, turn.turnId, spec, body.route);
		if (!gate.ok) return gate.response;
		const { actor, projectId, context } = gate;
		const outcome = await runWithActor(actor, async (): Promise<{ response: Response } | { pinnedOrgId: string }> => {
			const reserved = await reserveTurn({
				userId,
				orgId: actor.orgId,
				threadId,
				threadKind: spec.threadKind,
				projectId,
				aiKind: spec.aiKind,
				turn,
				messages: body.messages,
			});
			switch (reserved.outcome) {
				case "accepted":
					return {
						response: await streamClaimedTurn(req, actor, reserved.turn, () =>
							spec.prepare({ actor, turn: reserved.turn, route: body.route, context }),
						),
					};
				case "refused":
					return { response: json(reserved.body, reserved.status) };
				case "invalid":
					return { response: new Response(`The request is invalid: ${reserved.reason}.`, { status: 400 }) };
				case "budget":
					return {
						response: json(
							{
								error: reserved.error.message,
								reason: reserved.error.reason,
								resetAt: reserved.error.resetAt,
								upgradable: reserved.error.upgradable,
							},
							402,
						),
					};
				case "pin-moved":
					return { pinnedOrgId: reserved.pinnedOrgId };
			}
		});
		if ("response" in outcome) return outcome.response;
		billingOrgId = outcome.pinnedOrgId;
	}
	throw new Error(`thread ${threadId}: its billing pin moved twice under one request`);
}

/** The flags the answer stream raised, read when it ends. */
interface StreamFlags {
	aborted: boolean;
	errored: boolean;
	/** The model's stream reached its end (the transform flushed). */
	ended: boolean;
}

/** Pass the model's UI stream through, recording whether it aborted, errored or ended. */
function flagStream(flags: StreamFlags): TransformStream<UIMessageChunk, UIMessageChunk> {
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform(chunk, controller) {
			if (chunk.type === "abort") flags.aborted = true;
			if (chunk.type === "error") flags.errored = true;
			controller.enqueue(chunk);
		},
		flush() {
			flags.ended = true;
		},
	});
}

/**
 * Do nothing with `req`. A call from inside the stream's `execute` closure makes the closure capture
 * the request, so it stays reachable (and keeps forwarding its client's disconnect to `req.signal`)
 * for as long as the stream is running.
 */
function holdRequest(_req: Request): void {}

/** The text of an answer, for the turn's observability enrichment. */
function answerText(answer: UIMessage | null): string {
	return (answer?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** The answer as it has streamed so far: updated with every snapshot, final when the stream ends. */
interface AnswerSoFar {
	message: UIMessage | null;
}

/** Read an answer stream to its end, keeping `into` at its latest snapshot. */
async function readAnswer(stream: AsyncIterableStream<UIMessage>, into: AnswerSoFar): Promise<UIMessage | null> {
	for await (const message of stream) into.message = message;
	return into.message;
}

/**
 * Stream an accepted attempt. The model's input is the STORED transcript `reserveTurn` returned,
 * never the client's list. The lease is renewed every {@link TURN_HEARTBEAT_MS} from the stream's
 * registration until finalize; the call is bounded by {@link TURN_BUDGET_MS}; and `finalizeTurn`
 * runs exactly once, before `finish` is written.
 */
async function streamClaimedTurn(
	req: Request,
	actor: Actor,
	turn: AcceptedTurn,
	prepare: () => Promise<SingleModelTurn>,
): Promise<Response> {
	const steps: AgentStep[] = [];
	const soFar: AnswerSoFar = { message: null };
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let finalizing: Promise<FinalizeResult | null> | null = null;

	/** Finalize the attempt once, whichever end comes first, and stop the heartbeat with it. */
	const finalizeOnce = (outcome: TurnOutcome): Promise<FinalizeResult | null> => {
		if (finalizing) return finalizing;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		finalizing = finalizeTurn(turn, outcome).catch((err: unknown) => {
			// Nothing was stored or settled; the claim stays `running` until C8 releases its hold.
			log.error("turn finalize failed", { thread_id: turn.threadId, claim_id: turn.claimId, err });
			return null;
		});
		return finalizing;
	};

	// The route's own bound, the client's disconnect, and the route stopping the model itself (a lease
	// the heartbeat found lost, or a stored copy of the answer that ended before the model did).
	//
	// `req.signal` follows the signal the request was built with only while the `Request` object is
	// reachable (undici holds its controller through a WeakRef). Nothing here reads `req` once this
	// function returns, so without `holdRequest` below a GC between acceptance and the disconnect drops
	// the controller, `req.signal` never fires, and an abandoned turn runs to its budget.
	const stop = new AbortController();
	const timeout = AbortSignal.timeout(TURN_BUDGET_MS);
	const abortSignal = AbortSignal.any([req.signal, timeout, stop.signal]);

	/** Renew the lease every TURN_HEARTBEAT_MS until finalize; a lost lease aborts the model (C5). */
	const startHeartbeat = (): void => {
		if (finalizing || heartbeat) return;
		heartbeat = setInterval(() => {
			heartbeatTurn(turn)
				.then((renewed) => {
					if (!renewed && !finalizing) stop.abort(new Error("turn lease lost"));
				})
				.catch((err: unknown) => {
					log.warn("turn heartbeat failed", { thread_id: turn.threadId, claim_id: turn.claimId, err });
				});
		}, TURN_HEARTBEAT_MS);
	};

	try {
		const prepared = await prepare();
		const { model } = prepared;
		// The stored transcript. A partial answer stored after an abort mid-tool can hold a tool call
		// with no result; without the option every later turn would send the provider a dangling call.
		const modelMessages = await convertToModelMessages(turn.modelInput, {
			ignoreIncompleteToolCalls: true,
		});
		// A continuation (and its resume) extends the stored answer under its own id; a first answer and
		// a regenerate get a new one, minted here and never by the client.
		const continued = turn.kind === "continue" ? turn.modelInput.at(-1) : undefined;
		const answerId = continued?.id ?? generateId();

		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				startHeartbeat();
				writer.write({
					type: TURN_ACCEPTED_PART,
					data: { turnId: turn.turnId, answerId, revision: turn.acceptedRevision },
					transient: true,
				});
				const flags: StreamFlags = { aborted: false, errored: false, ended: false };
				const startedAt = Date.now();
				const result = streamText({
					model: model.model,
					// Our own system prompt (cached) is intentionally a system message; user turns are never
					// system-role, so this is not a prompt-injection surface.
					messages: [cachedSystemMessage(prepared.system), ...modelMessages],
					allowSystemInMessages: true,
					abortSignal,
					tools: prepared.tools,
					stopWhen: stepCountIs(8),
					providerOptions: prepared.thinking ? thinkingOptions(model) : undefined,
					// Every completed step is billed from here on every path: `onError` receives no steps
					// and `onAbort` only the completed ones (§5.3).
					onStepFinish: (step) => {
						steps.push({
							model: model.key,
							usage: {
								inputTokens: step.usage.inputTokens,
								outputTokens: step.usage.outputTokens,
								cachedInputTokens: step.usage.cachedInputTokens,
							},
						});
					},
					onError: ({ error }) => {
						log.warn("chat turn model error", { thread_id: turn.threadId, err: error });
					},
				});
				const answerStream = result
					.toUIMessageStream({
						sendFinish: false,
						originalMessages: turn.modelInput,
						generateMessageId: () => answerId,
					})
					.pipeThrough(flagStream(flags));
				// One copy to the client, one to the answer that is stored. `merge` reads its copy
				// whether or not the client is still connected, so a disconnect still reaches finalize.
				const [toClient, toStore] = answerStream.tee();
				writer.merge(toClient);
				let storeFailed = false;
				const answer = await readAnswer(
					readUIMessageStream({
						message: continued ? structuredClone(continued) : undefined,
						stream: toStore,
						onError: (err: unknown) => {
							storeFailed = true;
							log.warn("chat turn answer could not be read", { thread_id: turn.threadId, err });
						},
					}),
					soFar,
				);
				// The stored copy ended before the model's stream did: stop the model, so nothing reaches the
				// client that is not in the answer this attempt stores and bills.
				const endedEarly = storeFailed || !flags.ended;
				if (endedEarly) stop.abort(new Error("the stored answer ended early"));
				const partial = flags.aborted || flags.errored || endedEarly;
				const error = timeout.aborted
					? "timeout"
					: flags.aborted || endedEarly
						? "aborted"
						: flags.errored
							? "provider-error"
							: undefined;
				const finalized = await finalizeOnce({
					answer,
					steps: [...steps],
					partial,
					...(error ? { error } : {}),
					observability: {
						sessionId: turn.threadId,
						input: uiMessagesToAiInput(turn.modelInput),
						outputChoices: textToAiOutput(answerText(answer)),
						tools: Object.keys(prepared.tools),
						latencyMs: Date.now() - startedAt,
						...(error === "provider-error" ? { isError: true, error } : {}),
					},
				});
				// The request has to stay reachable until the model's stream has ended (see `stop` above).
				holdRequest(req);
				// Stored and settled: tell the client the revision it now holds, and only then finish.
				if (finalized?.outcome === "won" && finalized.state === "answered") {
					writer.write({
						type: TURN_FINISHED_PART,
						data: { answerId: finalized.answerId, revision: finalized.revision },
						transient: true,
					});
				}
				writer.write({ type: "finish" });
			},
			// A throw inside `execute` after the stream registered ends the attempt as C7, or C6 partial
			// when model output had already streamed.
			onError: (error) => {
				log.warn("chat turn stream failed", { thread_id: turn.threadId, org_id: actor.orgId, err: error });
				void finalizeOnce({ answer: soFar.message, steps: [...steps], partial: true, error: "stream-error" });
				return "An error occurred.";
			},
		});
		return createUIMessageStreamResponse({ stream });
	} catch (err) {
		// A throw between acceptance and the stream's registration (the route's prepare, the transcript's
		// conversion): C7, so the claim is failed and its hold released in one transaction.
		await finalizeOnce({ answer: null, steps: [], partial: false, error: "pre-stream-throw" });
		throw err;
	}
}
