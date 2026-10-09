// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The shared body of the two Elench chat routes (`/api/agent`, `/api/projects/[projectId]/assistant`),
// ADR 0003 slice 6 (`docs/adr/0003-chat-turn-answered-and-billed-once.md`): a turn is answered by the
// model, and billed, exactly once. Each route parses its own body fields and builds its own prompt and
// tools (`TurnRouteSpec`); everything that decides WHO pays, WHETHER the model runs and WHAT is stored
// lives here, so the two routes cannot drift on it.
//
// The order of refusals (§9.3), every one before the budget hold:
//   401 no session · 503 AI not configured · 400 malformed body · 413 over-long turn ·
//   409 client-outdated (no `orgId` or no `turn`) · 400 malformed turn or approval output ·
//   403 org-forbidden (§6.1) · 404 project-not-found (§6.2) · then `reserveTurn`'s own refusals and
//   the 402 budget refusal, all inside its one transaction (§5.1).
//
// MONEY. The hold is reserved only by `reserveTurn` and settled or released only by `finalizeTurn`,
// called exactly once per accepted attempt through `finalizeOnce`: from the end of the model stream
// (before `finish` is written, so no auto-send can start before the answer is stored), from the
// stream's own `onError`, and as C7 from the pre-stream `catch`. A lost finalize settles nothing.
//
// TENANCY. `userId` is the verified session's, never the body's. `orgId` is validated as a uuid before
// `resolveTurnActor` (whose enterprise resolver casts it `::uuid`), the thread's pin wins over it, and
// from acceptance on everything runs inside `runWithActor`, so the tools and every nested
// `currentActor()` resolve the billing org, not the session's.

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
import { AGENT_STEP_PART_TYPE, type AgentStepData, agentStepMarker } from "@/lib/ai/agent-steps";
import { isClientToolName, parseClientToolOutput } from "@/lib/ai/client-tools";
import { type Mention, mentionsSchema } from "@/lib/ai/mentions";
import { refuseUserMessage } from "@/lib/ai/message-limits";
import { textToAiOutput, uiMessagesToAiInput } from "@/lib/ai/ai-observability";
import { cachedSystemMessage, thinkingOptions } from "@/lib/ai/provider-options";
import { getOwner } from "@/lib/auth/owner";
import { getPdp } from "@/lib/authz";
import { runWithActor } from "@/lib/authz/actor-context";
import { resolveTurnActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import type { AgentStep } from "@/lib/billing/agent-metering";
import type { ResolvedModel } from "@/lib/config/ai";
import { isAiConfigured } from "@/lib/config/ai";
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

/** The empty-cell target a request may name (an empty-cell prompt, §9.2). */
export const cellTargetSchema = z.object({
	x: z.number().int().min(0).max(4),
	y: z.number().int().min(0),
});

/** A cell target. */
type CellTarget = z.infer<typeof cellTargetSchema>;

/**
 * What a stored user message carries in `metadata` (§9.2): its mentions and its cell target. Read
 * leniently, so a stored value that predates the schema degrades to "none" rather than failing a turn.
 */
const turnMetadataSchema = z.object({
	mentions: mentionsSchema.catch(undefined),
	cellTarget: cellTargetSchema.nullish().catch(null),
});

/** The request's turn fields (§9.1). The turn id's shape is the claim's (§4.1). */
const turnFieldsSchema = z.object({
	trigger: z.enum(["submit-message", "regenerate-message"]),
	turnId: turnIdSchema,
	baseRevision: z.number().int().min(0),
	answerId: z.string().min(1).max(256).optional(),
	toolCallIds: z.array(z.string().min(1).max(256)).max(64).optional(),
});

/** The fields every Elench request carries, whatever its route. */
export interface TurnRouteBody<R> {
	messages: UIMessage[];
	/** The thread the turn belongs to. Required; validated as a uuid here. */
	threadId: unknown;
	/** The body's mentions: read only for a first answer whose stored message carries none (§9.2). */
	mentions: Mention[] | undefined;
	/** The body's cell target: read only for a first answer whose stored message carries none. */
	cellTarget: CellTarget | null;
	/** The route's own fields. */
	route: R;
}

/** What a route's `prepare` is given, after acceptance, inside `runWithActor`. */
export interface PrepareTurnInput<R> {
	actor: Actor;
	turn: AcceptedTurn;
	/** The turn's mentions: the stored message's, else (a first answer only) the body's. */
	mentions: Mention[] | undefined;
	/** The turn's cell target, read the same way. */
	cellTarget: CellTarget | null;
	route: R;
}

/** The models of a turn: a tier-derived advisor plans step 0, an executor runs the rest (§1). */
export interface TurnModels {
	advisor: ResolvedModel;
	executor: ResolvedModel;
	/** The run's base model: the user's explicit pick, else the executor. */
	base: ResolvedModel;
	/** True when the user force-picked a model: one model on every step, thinking throughout. */
	clientPick: boolean;
}

/** What a route's `prepare` builds: the prompt, the tool set and the models. */
export interface PreparedTurn {
	system: string;
	tools: ToolSet;
	models: TurnModels;
}

/** The route-specific half of an Elench route. */
export interface TurnRouteSpec<R> {
	/** The 503 body when AI is not configured. */
	aiDisabledMessage: string;
	/** The project the route answers for (its threads' `project_id`), or null for the org route. */
	projectId: string | null;
	/** Parse the route's body: a 400 with `message` when it is malformed. Runs before the 413. */
	parseBody(raw: object): { ok: true; value: TurnRouteBody<R> } | { ok: false; message: string };
	/**
	 * Build the prompt, tools and models of an accepted turn. Runs inside `runWithActor`; a throw
	 * here finalizes the attempt as C7 (failed, hold released) and is rethrown.
	 */
	prepare(input: PrepareTurnInput<R>): Promise<PreparedTurn>;
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
 * True when every output the browser sent for the pending client tool calls of a continuation's
 * answer passes its schema and byte cap (§5.1 step 8). Checked here so that a bad approval output is
 * a 400 before the org and project checks (§9.3's order); `reserveTurn` checks it again on the
 * stored answer, under its lock, and that check is the one that decides what is stored.
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
 * The project check (§6.2): the project exists IN the actor's org (one service-role read) and the
 * actor may view it (asked with `can`, so nothing is recorded). Either failing is the same 404, so a
 * status code never confirms that a project id exists in another org.
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

/** The org gate and the project gate (§6.1, §6.2): the actor, or the refusal to answer. */
async function resolveActor(
	userId: string,
	orgId: string,
	projectId: string | null,
	turnId: string,
): Promise<{ ok: true; actor: Actor } | { ok: false; response: Response }> {
	const actor = await resolveTurnActor(userId, orgId);
	if (!actor || actor.userId !== userId) {
		return { ok: false, response: earlyRefusal("org-forbidden", turnId) };
	}
	if (projectId !== null && !(await projectVisible(actor, projectId))) {
		return { ok: false, response: earlyRefusal("project-not-found", turnId) };
	}
	return { ok: true, actor };
}

/**
 * The turn's mentions and cell target (§9.2): the stored user message's `metadata` wins; the body's
 * fields are read only for a first answer, whose stored message (a first turn stored with its thread)
 * may carry none. A regenerate or a continuation never takes the body's, which describe whatever the
 * composer last sent.
 */
function turnContext(
	turn: AcceptedTurn,
	body: Pick<TurnRouteBody<unknown>, "mentions" | "cellTarget">,
): { mentions: Mention[] | undefined; cellTarget: CellTarget | null } {
	const stored = turn.modelInput.find((m) => m.id === turn.turnId && m.role === "user");
	const meta = turnMetadataSchema.safeParse(stored?.metadata ?? {});
	const fromStore = meta.success ? meta.data : { mentions: undefined, cellTarget: null };
	const fallback = turn.kind === "answer";
	return {
		mentions: fromStore.mentions ?? (fallback ? body.mentions : undefined),
		cellTarget: fromStore.cellTarget ?? (fallback ? body.cellTarget : null),
	};
}

/**
 * The `metadata` an appended user turn is stored with (§5.1 step 8): the body's mentions and cell
 * target, validated by the route's parse. Undefined when it carries neither.
 */
function appendedTurnMetadata(
	body: Pick<TurnRouteBody<unknown>, "mentions" | "cellTarget">,
): UIMessage["metadata"] {
	const meta: { mentions?: Mention[]; cellTarget?: CellTarget } = {};
	if (body.mentions && body.mentions.length > 0) meta.mentions = body.mentions;
	if (body.cellTarget) meta.cellTarget = body.cellTarget;
	return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Serve one Elench chat request (ADR 0003 slice 6): refuse in §9.3's order, accept through
 * `reserveTurn` under the resolved actor, and stream the model's answer, finalized exactly once.
 */
export async function serveTurn<R>(req: Request, spec: TurnRouteSpec<R>): Promise<Response> {
	// The verified session's user: the thread's owner and the only identity a turn runs as.
	const userId = await getOwner();
	if (!userId) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) return new Response(spec.aiDisabledMessage, { status: 503 });

	const raw: unknown = await req.json().catch(() => null);
	if (raw === null || typeof raw !== "object") {
		return new Response("The request body is malformed.", { status: 400 });
	}
	const parsed = spec.parseBody(raw);
	if (!parsed.ok) return new Response(parsed.message, { status: 400 });
	const body = parsed.value;
	// The per-message limit, before the hold (400 when the messages cannot be read).
	const tooLong = refuseUserMessage(body.messages);
	if (tooLong) return tooLong;

	// A tab on a bundle older than the claim sends neither field: refused before anything is billed.
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
		const gate = await resolveActor(userId, billingOrgId, spec.projectId, turn.turnId);
		if (!gate.ok) return gate.response;
		const { actor } = gate;
		const outcome = await runWithActor(actor, async (): Promise<{ response: Response } | { pinnedOrgId: string }> => {
			const reserved = await reserveTurn({
				userId,
				orgId: actor.orgId,
				threadId,
				threadKind: "agent",
				projectId: spec.projectId,
				aiKind: "agent",
				turn,
				messages: body.messages,
				turnMetadata: appendedTurnMetadata(body),
			});
			switch (reserved.outcome) {
				case "accepted":
					return { response: await streamAcceptedTurn(req, spec, actor, reserved.turn, body) };
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

/**
 * The id of a step marker: unique per ATTEMPT, never `step-<n>` alone. ai merges a data part into
 * an existing part of the same type and id, and a continuation streams into the stored answer it
 * continues, whose own markers (from the first answer's steps 0 and 1) would otherwise be
 * overwritten in place, so the earlier PLAN/EXECUTE separators would be lost on reload.
 */
function stepMarkerId(turn: Pick<AcceptedTurn, "claimId" | "attemptNo">, step: number): string {
	return `step-${turn.claimId}-${turn.attemptNo}-${step}`;
}

/**
 * Pass the model's UI stream through, recording whether it aborted, errored or ended, and writing
 * each queued step marker immediately before the `start-step` it announces, so the markers are part
 * of the answer that is stored (the PLAN/EXECUTE separators survive a reload). Each marker's id is
 * unique to this attempt ({@link stepMarkerId}), so a continuation's markers are appended to the
 * stored answer rather than replacing the ones its earlier steps wrote.
 */
function answerStreamTransform(
	turn: Pick<AcceptedTurn, "claimId" | "attemptNo">,
	markers: AgentStepData[],
	flags: StreamFlags,
): TransformStream<UIMessageChunk, UIMessageChunk> {
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform(chunk, controller) {
			if (chunk.type === "abort") flags.aborted = true;
			if (chunk.type === "error") flags.errored = true;
			if (chunk.type === "start-step") {
				for (const marker of markers.splice(0)) {
					controller.enqueue({ type: AGENT_STEP_PART_TYPE, id: stepMarkerId(turn, marker.step), data: marker });
				}
			}
			controller.enqueue(chunk);
		},
		flush() {
			flags.ended = true;
		},
	});
}

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
async function streamAcceptedTurn<R>(
	req: Request,
	spec: TurnRouteSpec<R>,
	actor: Actor,
	turn: AcceptedTurn,
	body: TurnRouteBody<R>,
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

	// The route's own bound, the client's disconnect, and the route stopping the model itself: a lease
	// the heartbeat found lost, or a stored copy of the answer that ended before the model did.
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
		const { mentions, cellTarget } = turnContext(turn, body);
		const prepared = await spec.prepare({ actor, turn, mentions, cellTarget, route: body.route });
		const { advisor, executor, base, clientPick } = prepared.models;
		/** The canonical key metered for a step (step 0 is the advisor unless the user forced a pick). */
		const modelForStep = (stepNumber: number): string =>
			!clientPick && stepNumber === 0 ? advisor.key : base.key;
		// The stored transcript. A partial answer stored after an abort mid-tool can hold a tool call
		// with no result; without the option every later turn would send the provider a dangling call.
		const modelMessages = await convertToModelMessages(turn.modelInput, {
			ignoreIncompleteToolCalls: true,
		});
		// The answer's id: a continuation (and its resume) extends the stored answer under its own id;
		// a first answer and a regenerate get a new one, minted here and never by the client.
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
				const markers: AgentStepData[] = [];
				const flags: StreamFlags = { aborted: false, errored: false, ended: false };
				const startedAt = Date.now();
				const result = streamText({
					model: base.model,
					// Our own system prompt (cached) is intentionally a system message; user turns are never
					// system-role, so this is not a prompt-injection surface.
					messages: [cachedSystemMessage(prepared.system), ...modelMessages],
					allowSystemInMessages: true,
					abortSignal,
					tools: prepared.tools,
					stopWhen: stepCountIs(8),
					providerOptions: clientPick ? thinkingOptions(base) : undefined,
					prepareStep: ({ stepNumber }) => {
						const marker = agentStepMarker({
							stepNumber,
							clientPick,
							advisorKey: advisor.key,
							executorKey: executor.key,
							baseKey: base.key,
						});
						if (marker) markers.push(marker);
						if (clientPick) return {};
						return stepNumber === 0
							? { model: advisor.model, providerOptions: thinkingOptions(advisor) }
							: {};
					},
					// Every completed step is billed from here on every path: `onError` receives no steps
					// and `onAbort` only the completed ones (§5.3).
					onStepFinish: (step) => {
						steps.push({
							model: modelForStep(steps.length),
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
					.pipeThrough(answerStreamTransform(turn, markers, flags));
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
				// The stored copy ended before the model's stream did (a processing error stops it while the
				// client's copy keeps flowing): stop the model, so nothing reaches the client that is not in
				// the answer this attempt stores and bills, and store what was read as a partial answer.
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
			// A throw inside `execute` after the stream registered (the heartbeat may be running) ends
			// the attempt as C7 — or C6 partial, when model output had already streamed.
			onError: (error) => {
				log.warn("chat turn stream failed", { thread_id: turn.threadId, err: error });
				void finalizeOnce({ answer: soFar.message, steps: [...steps], partial: true, error: "stream-error" });
				return "An error occurred.";
			},
		});
		return createUIMessageStreamResponse({ stream });
	} catch (err) {
		// A throw between acceptance and the stream's registration (tier, context, the transcript's
		// conversion, the tool build): C7, so the claim is failed and its hold released in one
		// transaction, and a Retry re-arms it (C2).
		await finalizeOnce({ answer: null, steps: [], partial: false, error: "pre-stream-throw" });
		throw err;
	}
}
