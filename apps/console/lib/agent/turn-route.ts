// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The shared body of every chat route on the turn claim (`docs/adr/0003-chat-turn-answered-and-billed-once.md`):
// the two Elench routes (`/api/agent`, `/api/projects/[projectId]/assistant`, slice 6), and the
// agent-identity route (`/api/agent/[agentId]`) and the support route for a request that names a thread
// (`/api/support/ask`, slice 8, Q11). A turn is answered by the model, and billed, exactly once. Each
// route parses its own body fields, names its thread and ledger kinds, may add its own check before
// the hold, and builds its own prompt and tools (`TurnRouteSpec`); everything that decides WHO pays,
// WHETHER the model runs and WHAT is stored lives here, so the routes cannot drift on it.
//
// The order of refusals (§9.3), every one before the budget hold:
//   401 no session · 503 AI not configured · 400 malformed body · 413 over-long turn ·
//   409 client-outdated (no `orgId` or no `turn`) · 400 malformed turn or approval output ·
//   403 org-forbidden (§6.1) · the route's own check (`gate`) · 404 project-not-found (§6.2) · then
//   `reserveTurn`'s own refusals and the 402 budget refusal, all inside its one transaction (§5.1).
//
// MONEY. The hold is reserved only by `reserveTurn` and settled or released only by `finalizeTurn`,
// called exactly once per accepted attempt through `finalizeOnce`: from the end of the model stream
// (before `finish` is written, so no auto-send can start before the answer is stored), from the
// stream's own `onError`, and as C7 from the pre-stream `catch`. A lost finalize settles nothing.
//
// TENANCY. `userId` is the verified session's, never the body's. `orgId` is validated as a uuid before
// `resolveTurnActor` (whose enterprise resolver casts it `::uuid`), the thread's pin wins over it, and
// from the org gate on everything runs inside `runWithActor`, so the route's own check, the tools and
// every nested `currentActor()` resolve the billing org, not the session's.

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
import { type Mention, mentionSchema, mentionsSchema } from "@/lib/ai/mentions";
import { MAX_DRAFT_MENTION_FIELD, MAX_DRAFT_MENTION_SPANS } from "@/lib/elench/draft-content";
import { refuseUserMessage } from "@/lib/ai/message-limits";
import { textToAiOutput, uiMessagesToAiInput } from "@/lib/ai/ai-observability";
import { cachedSystemMessage, thinkingOptions } from "@/lib/ai/provider-options";
import { getOwner } from "@/lib/auth/owner";
import { getPdp } from "@/lib/authz";
import { runWithActor } from "@/lib/authz/actor-context";
import { resolveTurnActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import type { AgentStep } from "@/lib/billing/agent-metering";
import type { MeteredAiKind } from "@/lib/billing/ai-guard";
import type { ResolvedModel } from "@/lib/config/ai";
import { isAiConfigured } from "@/lib/config/ai";
import { getServiceDb } from "@/lib/db";
import { holdRequest } from "@/lib/http/hold-request";
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
const cellTargetSchema = z.object({
	x: z.number().int().min(0).max(4),
	y: z.number().int().min(0),
});

/** A cell target. */
type CellTarget = z.infer<typeof cellTargetSchema>;

/**
 * The distinct mentions of `spans`, by type and id, in order of first appearance. A user message's
 * `metadata.mentions` holds one entry per pill, repeats included (ADR 0001 §4.1), and the cap of
 * `mentionsSchema` applies to the distinct resources, as it did when the composer deduped them.
 */
function distinctResources(spans: readonly Mention[]): Mention[] {
	const seen = new Set<string>();
	return spans.flatMap((m) => {
		const key = `${m.type}:${m.id}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [{ id: m.id, type: m.type, label: m.label }];
	});
}

/** One mention of a message's `metadata`, its id and label capped as a draft caps them. */
const turnMentionSchema = mentionSchema.extend({
	id: z.string().max(MAX_DRAFT_MENTION_FIELD),
	label: z.string().max(MAX_DRAFT_MENTION_FIELD),
});

/**
 * What a user message carries in `metadata` (§9.2): its mentions and its cell target. Read
 * leniently, so a value that predates the schema degrades to "none" rather than failing a turn, and
 * `z.object` keeps these two fields and nothing else of it.
 */
const turnMetadataSchema = z.object({
	mentions: z
		.array(turnMentionSchema)
		.max(MAX_DRAFT_MENTION_SPANS)
		.transform(distinctResources)
		.pipe(mentionsSchema.unwrap())
		.optional()
		.catch(undefined),
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
	/** The route's own fields. */
	route: R;
}

/** What a route's `prepare` is given, after acceptance, inside `runWithActor`. */
export interface PrepareTurnInput<R> {
	actor: Actor;
	turn: AcceptedTurn;
	/** The turn's mentions: its stored user message's `metadata.mentions` (§9.2). */
	mentions: Mention[] | undefined;
	/** The turn's cell target: its stored user message's `metadata.cellTarget` (§9.2). */
	cellTarget: CellTarget | null;
	route: R;
}

/** The models of a turn: a tier-derived advisor plans step 0, an executor runs the rest (§1). */
export interface TurnModels {
	advisor: ResolvedModel;
	executor: ResolvedModel;
	/** The run's base model: the user's explicit pick, else the executor. */
	base: ResolvedModel;
	/**
	 * True for one model (`base`) on every step: the user force-picked it, or the route runs a single
	 * model. Extended thinking on every step unless `thinking` is false.
	 */
	clientPick: boolean;
	/** False: no extended thinking on any step (the support persona). Read only with `clientPick`. */
	thinking?: boolean;
}

/** What a route's `prepare` builds: the prompt, the tool set and the models. */
export interface PreparedTurn {
	system: string;
	tools: ToolSet;
	models: TurnModels;
}

/** What a route's own check answers: the thread's project, or the refusal to answer. */
export type TurnGate = { ok: true; projectId: string | null } | { ok: false; response: Response };

/** The route-specific half of a chat route on the claim. */
export interface TurnRouteSpec<R> {
	/** The 503 body when AI is not configured. */
	aiDisabledMessage: string;
	/** The project the route answers for (its threads' `project_id`), or null for an org thread. */
	projectId: string | null;
	/** The route's thread kind (`agent_threads.kind`). Default `agent`. */
	threadKind?: "agent" | "support";
	/** The ledger kind of the turn's hold. Default `agent`. */
	aiKind?: MeteredAiKind;
	/**
	 * Which of a turn's `metadata` fields this route stores when it appends the turn (§9.2): the
	 * Elench routes' mentions, and the org route's cell target. A field the route does not name is
	 * never stored from a request, so a route with no use for it cannot be handed one. Default none.
	 */
	turnMetadata?: { mentions?: boolean; cellTarget?: boolean };
	/**
	 * The route's own check, under the resolved actor, after the org gate and before the project check
	 * and the hold: the thread's project (replacing `projectId`), or the refusal to answer. It runs
	 * again when the thread's pin moved, under the pinned org's actor.
	 */
	gate?(actor: Actor, route: R): Promise<TurnGate>;
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

/**
 * The org gate, the route's own check and the project gate (§6.1, §6.2): the actor and the thread's
 * project, or the refusal to answer.
 */
async function resolveActor<R>(
	userId: string,
	orgId: string,
	turnId: string,
	spec: TurnRouteSpec<R>,
	route: R,
): Promise<{ ok: true; actor: Actor; projectId: string | null } | { ok: false; response: Response }> {
	const actor = await resolveTurnActor(userId, orgId);
	if (!actor || actor.userId !== userId) {
		return { ok: false, response: earlyRefusal("org-forbidden", turnId) };
	}
	let projectId = spec.projectId;
	if (spec.gate) {
		const { gate } = spec;
		const checked = await runWithActor(actor, () => gate(actor, route));
		if (!checked.ok) return checked;
		projectId = checked.projectId;
	}
	if (projectId !== null && !(await projectVisible(actor, projectId))) {
		return { ok: false, response: earlyRefusal("project-not-found", turnId) };
	}
	return { ok: true, actor, projectId };
}

/**
 * The turn's mentions and cell target (§9.2): read from the turn's STORED user message's `metadata`
 * only, never from the request. A turn appended by this acceptance was stored with its request
 * message's validated fields (`appendedTurnMetadata`); a stored turn keeps what it was stored with, so a
 * regenerate, a continuation or a Retry cannot change them.
 */
function turnContext(turn: AcceptedTurn): { mentions: Mention[] | undefined; cellTarget: CellTarget | null } {
	const stored = turn.modelInput.find((m) => m.id === turn.turnId && m.role === "user");
	const meta = turnMetadataSchema.safeParse(stored?.metadata ?? {});
	if (!meta.success) return { mentions: undefined, cellTarget: null };
	return { mentions: meta.data.mentions, cellTarget: meta.data.cellTarget ?? null };
}

/**
 * The `metadata` the turn's user message is stored with when this acceptance appends it (§5.1 step
 * 8): the request message's mentions and cell target, each validated by its schema and nothing else
 * of it kept. `reserveTurn` stores it only for an append; a turn already stored keeps its own.
 * Undefined when it carries neither.
 */
function appendedTurnMetadata(
	messages: readonly UIMessage[],
	turnId: string,
	accepts: TurnRouteSpec<unknown>["turnMetadata"],
): UIMessage["metadata"] {
	const requested = messages.findLast((m) => m.role === "user" && m.id === turnId);
	const parsed = turnMetadataSchema.safeParse(requested?.metadata ?? {});
	if (!parsed.success) return undefined;
	const meta: { mentions?: Mention[]; cellTarget?: CellTarget } = {};
	if (accepts?.mentions && parsed.data.mentions && parsed.data.mentions.length > 0)
		meta.mentions = parsed.data.mentions;
	if (accepts?.cellTarget && parsed.data.cellTarget) meta.cellTarget = parsed.data.cellTarget;
	return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * The first three refusals of §9.3: 401 without a verified session, 503 when AI is not configured, 400
 * when the body is not a JSON object. Exported so that a route that chooses its path from the body (the
 * support route, §12) reads it once.
 */
export async function readTurnRequest(
	req: Request,
	aiDisabledMessage: string,
): Promise<{ ok: true; userId: string; raw: object } | { ok: false; response: Response }> {
	// The verified session's user: the thread's owner and the only identity a turn runs as.
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
 * Serve one chat request on the claim: refuse in §9.3's order, accept through `reserveTurn` under the
 * resolved actor, and stream the model's answer, finalized exactly once.
 */
export async function serveTurn<R>(req: Request, spec: TurnRouteSpec<R>): Promise<Response> {
	const request = await readTurnRequest(req, spec.aiDisabledMessage);
	if (!request.ok) return request.response;
	return serveTurnBody(req, request.userId, request.raw, spec);
}

/**
 * {@link serveTurn} after {@link readTurnRequest}: for a route that has already read the session and
 * the body. `userId` must be the verified session's.
 */
export async function serveTurnBody<R>(
	req: Request,
	userId: string,
	raw: object,
	spec: TurnRouteSpec<R>,
): Promise<Response> {
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
		const gate = await resolveActor(userId, billingOrgId, turn.turnId, spec, body.route);
		if (!gate.ok) return gate.response;
		const { actor, projectId } = gate;
		const outcome = await runWithActor(actor, async (): Promise<{ response: Response } | { pinnedOrgId: string }> => {
			const reserved = await reserveTurn({
				userId,
				orgId: actor.orgId,
				threadId,
				threadKind: spec.threadKind ?? "agent",
				projectId,
				aiKind: spec.aiKind ?? "agent",
				turn,
				messages: body.messages,
				turnMetadata: appendedTurnMetadata(body.messages, turn.turnId, spec.turnMetadata),
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
	//
	// `req.signal` is not the signal the request was built with: a `Request` gets its own controller,
	// which follows the init signal only while the `Request` object is reachable (undici holds it
	// through a WeakRef and unregisters the listener when the controller is collected). Nothing here
	// reads `req` once this function returns, so without `holdRequest` below a GC between acceptance
	// and the disconnect drops the controller, `req.signal` never fires, and an abandoned turn runs to
	// its budget with nobody reading it.
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
		const { mentions, cellTarget } = turnContext(turn);
		const prepared = await spec.prepare({ actor, turn, mentions, cellTarget, route: body.route });
		const { advisor, executor, base, clientPick } = prepared.models;
		const thinkEveryStep = clientPick && prepared.models.thinking !== false;
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
					providerOptions: thinkEveryStep ? thinkingOptions(base) : undefined,
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
