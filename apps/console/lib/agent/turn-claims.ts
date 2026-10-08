// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The claim state machine of a chat turn (ADR 0003 §5, `docs/adr/0003-chat-turn-answered-and-billed-once.md`):
// a turn is answered by the model, and billed, exactly once.
//
//   reserveTurn        acceptance (§5.1): one service-role transaction, C1-C4r, the hold, the append
//   heartbeatTurn      C5: renews the lease of a running attempt younger than its age bound
//   finalizeTurn       §5.3: C6 / C6m / C7 or `deleted`, settled or released on the same transaction
//   expireSilentTurns  C8 for the `release-ai-holds` sweep: a silent lease, or past the age bound
//
// ONE LOCK ORDER, everywhere (§5): the org's AI-budget advisory lock, then the thread row, then the
// claim row, then the hold's ledger row. A transaction skips a lock it does not need and never takes
// them out of order, so acceptance, finalize, expiry and the heartbeat cannot deadlock each other.
// One addition, in finalize's `deleted` outcome only: after the claim, `recoverTranscript` may lock a
// SECOND thread row (an earlier Recovered thread of the same owner, through `updateLive`). No cycle
// can close on it: acceptance takes a thread's lock before any claim, so nothing that holds that
// Recovered thread's row waits on this claim or this hold.
//
// Every statement is on the service role (the ledger writes need it, ADR 0003 hand-off from #5723's
// review). What holds the service role to the owner's rows (§4.3) differs by table:
// - every claim and thread statement names `user_id` explicitly;
// - a ledger write matches the hold by id ALONE; that id is only ever read from a claim row selected
//   with its owner's `user_id`, or taken from the in-memory `AcceptedTurn` this module returned, so
//   an `AcceptedTurn` must never be built from request data;
// - `expireSilentTurns`' candidate scan has NO owner predicate, by design: the sweep serves every
//   user, and re-checks each candidate under its locks with that candidate's own `user_id`.
// No route calls this module yet: ADR 0003 slice 6 cuts the routes over.

import { randomUUID } from "node:crypto";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { and, eq, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { isClientToolName, parseClientToolOutput } from "@/lib/ai/client-tools";
import { type AgentStep, recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import {
	type AiBudgetError,
	type AiBudgetRefusal,
	type AiCharge,
	aiBudgetRefusalError,
	METERED_RESERVE_CREDITS,
	type MeteredAiKind,
	reserveAiHold,
} from "@/lib/billing/ai-guard";
import type { AiUsageAfterCommit } from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";
import { getServiceDb, type Tx } from "@/lib/db";
import { agentThreads, agentTurnClaims, aiUsageLedger, type TurnClaimState } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { transcriptRows } from "./thread-transcript";
import { recoverTranscript, THREAD_DELETED, threadTitle } from "./transcript-save";
import {
	type ClaimSnapshot,
	classifyTurn,
	type TurnClassification,
	type TurnRequest,
	turnText,
} from "./turn-key";

// ── The bounds (§8.2) ────────────────────────────────────────────────────────────────────────────

/** How long a turn may run (Q7): above the six minutes measured for a deep-reasoning turn. */
export const TURN_BUDGET_MS = 900_000;

/** The lease: a running attempt silent for this long is expired (C8). Renewed by every heartbeat. */
export const TURN_LEASE_MS = 90_000;

/** How often a route renews its lease (C5). A third of the lease, so two may be lost. */
export const TURN_HEARTBEAT_MS = 30_000;

/**
 * An attempt older than this since `accepted_at` is past its own timeout: C5 no longer renews it and
 * C8 expires it whatever its lease, so a heartbeat timer leaked by a bug cannot pin a hold.
 */
export const TURN_AGE_BOUND_MS = TURN_BUDGET_MS + TURN_LEASE_MS;

/** The lease interval as SQL, so the database's clock sets it. */
const LEASE_SQL = sql`now() + make_interval(secs => ${TURN_LEASE_MS / 1000})`;

// ── Refusals (§9.3) ──────────────────────────────────────────────────────────────────────────────

/** Every typed refusal a chat route answers before its budget hold (ADR 0003 §9.3). */
export type TurnRefusalCode =
	| "turn-in-progress"
	| "turn-answered"
	| "turn-committed-different-text"
	| "thread-busy"
	| "transcript-stale"
	| "thread-deleted"
	| "thread-not-found"
	| "org-forbidden"
	| "project-not-found"
	| "client-outdated"
	| "turn-has-accepted-approval";

/** The JSON body of a refusal (ADR 0003 §9.3). */
export interface TurnRefusal {
	refusal: TurnRefusalCode;
	turnId: string | null;
	/** A turn with this id is in the stored transcript. */
	committed: boolean;
	/** ...and its text is the text this request sent. */
	textCommitted: boolean;
	/** ...and it has an answer. */
	answered: boolean;
	revision: number | null;
	answerId: string | null;
}

/** The statuses a refusal answers with. */
export type TurnRefusalStatus = 403 | 404 | 409 | 410;

/** The HTTP status of each refusal (ADR 0003 §9.3). */
export const TURN_REFUSAL_STATUS: { readonly [K in TurnRefusalCode]: TurnRefusalStatus } = {
	"turn-in-progress": 409,
	"turn-answered": 409,
	"turn-committed-different-text": 409,
	"thread-busy": 409,
	"transcript-stale": 409,
	"client-outdated": 409,
	"turn-has-accepted-approval": 409,
	"thread-deleted": 410,
	"thread-not-found": 404,
	"project-not-found": 404,
	"org-forbidden": 403,
};

/**
 * The refusals that say the turn IS committed, whatever the transcript position of the request's
 * `turnId` (ADR 0003 §9.3's table; #5721 advisory 1): a client consumes its draft on these, so a
 * hand-built request whose `turnId` is not stored must not read `committed: false` and release it.
 */
const COMMITTED_REFUSALS: ReadonlySet<TurnRefusalCode> = new Set([
	"turn-in-progress",
	"turn-answered",
	"turn-committed-different-text",
	"turn-has-accepted-approval",
]);

/** The stored-transcript facts of `turnId`: whether it is stored, answered, and by which message. */
function storedFacts(
	stored: readonly UIMessage[],
	turnId: string,
): { committed: boolean; answered: boolean; answerId: string | null } {
	const i = stored.findIndex((m) => m.id === turnId);
	if (i < 0) return { committed: false, answered: false, answerId: null };
	const next = stored[i + 1];
	return { committed: true, answered: next !== undefined, answerId: next?.role === "assistant" ? next.id : null };
}

/**
 * The body of refusal `code` for `turnId` against the locked transcript (`stored`, `revision`; null
 * when there is no row). `committed` is §9.3's table: true exactly for the refusals that name a
 * stored turn, whatever the position of a hand-built request's `turnId`; `textCommitted` equals it
 * except on `turn-committed-different-text`. `answerId` defaults to the message after the turn.
 */
export function turnRefusal(
	code: TurnRefusalCode,
	turnId: string | null,
	stored: readonly UIMessage[],
	revision: number | null,
	answerId?: string | null,
): TurnRefusal {
	const facts = turnId === null ? storedFacts([], "") : storedFacts(stored, turnId);
	const committed = COMMITTED_REFUSALS.has(code);
	let answered = false;
	if (code === "turn-answered" || code === "turn-has-accepted-approval") answered = true;
	else if (code === "turn-committed-different-text") answered = facts.answered;
	return {
		refusal: code,
		turnId,
		committed,
		textCommitted: committed && code !== "turn-committed-different-text",
		answered,
		revision,
		answerId: answerId ?? facts.answerId,
	};
}

// ── The transitions as pure functions (§5's table; the U tests) ─────────────────────────────────

/** Why C8 expires a running claim: its lease is silent, or it is older than its age bound. */
export type ClaimExpiry = "lease-silent" | "age-bound";

/**
 * C8's guard: whether a `running` claim is expired at `now` (the database's clock), and why. The
 * age bound wins over a fresh lease: a leaked heartbeat keeps the lease fresh for ever, and the age
 * bound is what ends it (§8.2).
 */
export function claimExpiry(
	claim: { leaseUntil: Date; acceptedAt: Date },
	now: Date,
): ClaimExpiry | null {
	if (claim.acceptedAt.getTime() < now.getTime() - TURN_AGE_BOUND_MS) return "age-bound";
	if (claim.leaseUntil.getTime() < now.getTime()) return "lease-silent";
	return null;
}

/**
 * C5's guard: a heartbeat renews the lease only of the attempt it names (`token`), only while it is
 * `running`, and only while it is younger than {@link TURN_AGE_BOUND_MS} since its acceptance.
 */
export function heartbeatRenews(
	claim: { state: TurnClaimState; token: string; acceptedAt: Date },
	token: string,
	now: Date,
): boolean {
	return (
		claim.state === "running" &&
		claim.token === token &&
		claim.acceptedAt.getTime() >= now.getTime() - TURN_AGE_BOUND_MS
	);
}

/** The claim row of the request's attempt key, as acceptance reads it under its lock. */
export interface KeyClaim {
	id: string;
	state: TurnClaimState;
	partial: boolean;
	attemptNo: number;
}

/** The accept arms of {@link classifyTurn}. */
export type AcceptClassification = Extract<TurnClassification, { outcome: "accept" }>;

/**
 * What acceptance does with the claim row of the key (§5.1 steps 4-6):
 * - `insert`: C1, no row for the key;
 * - `rearm`: C2 from `failed`/`expired`, or C4r from an `answered`, `partial` continuation (the resume);
 * - `refuse`: C3 `turn-in-progress`, C4 `turn-answered`, or §5.1 step 5's `thread-busy`.
 */
export type AcceptanceDecision =
	| { action: "insert" }
	| { action: "rearm"; from: "failed" | "expired" | "answered"; claim: KeyClaim }
	| { action: "refuse"; refusal: "turn-in-progress" | "turn-answered" | "thread-busy" };

/**
 * Decide C1-C4r for an accepted classification, given the key's claim row and whether ANOTHER
 * attempt of the thread is running. The key's own row is read first (§5.1 step 4 before step 5),
 * so a duplicate of a running turn is `turn-in-progress` (committed), never `thread-busy`.
 */
export function decideAcceptance(
	classification: AcceptClassification,
	keyClaim: KeyClaim | null,
	otherRunning: boolean,
): AcceptanceDecision {
	if (keyClaim?.state === "running") return { action: "refuse", refusal: "turn-in-progress" };
	if (keyClaim?.state === "answered") {
		const resume =
			classification.kind === "continue" && classification.mode === "resume" && keyClaim.partial;
		if (!resume) return { action: "refuse", refusal: "turn-answered" };
	}
	if (otherRunning) return { action: "refuse", refusal: "thread-busy" };
	if (keyClaim === null) return { action: "insert" };
	return { action: "rearm", from: keyClaim.state, claim: keyClaim };
}

/**
 * The columns a re-arm (C2, C4r) writes besides the thread's copies and the clock: a new token, the
 * next attempt number, and everything `answered`/`failed` set cleared, so the row satisfies
 * `check ((state = 'answered') = (answer_id is not null))` inside the acceptance (§4.1, C4r).
 */
export function rearmedClaim(
	prev: Pick<KeyClaim, "attemptNo">,
	token: string,
): {
	state: "running";
	token: string;
	attempt_no: number;
	answer_id: null;
	partial: false;
	error: null;
	finished_at: null;
	hold_id: null;
} {
	return {
		state: "running",
		token,
		attempt_no: prev.attemptNo + 1,
		answer_id: null,
		partial: false,
		error: null,
		finished_at: null,
		hold_id: null,
	};
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

/** A turn id (ADR 0003 §4.1): 1-128 chars of `[A-Za-z0-9_-]`. */
export const turnIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * The parts of answer `a` up to the end of the step that holds the outputs of `pending` (the cut a
 * resume answers from, C4r): everything after that step's last part is dropped.
 */
export function cutAfterApprovalStep(a: UIMessage, pending: readonly string[]): UIMessage {
	let last = -1;
	a.parts.forEach((part, i) => {
		if (isToolUIPart(part) && pending.includes(part.toolCallId)) last = i;
	});
	if (last < 0) return a;
	const next = a.parts.findIndex((part, i) => i > last && part.type === "step-start");
	return { ...a, parts: next < 0 ? a.parts : a.parts.slice(0, next) };
}

/**
 * Stored answer `a` with the browser's outputs of `pending` merged in (§5.1 step 8). Each output is
 * validated with its tool's schema and byte cap and the PARSED value is stored, never the raw one;
 * the tool name is the stored part's, never the request's. Null when an output is missing or fails.
 */
function mergeClientOutputs(
	a: UIMessage,
	requestA: UIMessage,
	pending: readonly string[],
): UIMessage | null {
	const sent = new Map<string, unknown>();
	for (const part of requestA.parts) {
		if (isToolUIPart(part) && part.state === "output-available" && pending.includes(part.toolCallId)) {
			sent.set(part.toolCallId, part.output);
		}
	}
	const parts: UIMessage["parts"] = [];
	for (const part of a.parts) {
		if (!isToolUIPart(part) || !pending.includes(part.toolCallId)) {
			parts.push(part);
			continue;
		}
		const name = getToolName(part);
		if (!isClientToolName(name) || !sent.has(part.toolCallId)) return null;
		const parsed = parseClientToolOutput(name, sent.get(part.toolCallId));
		if (!parsed.ok) return null;
		if (part.type === "dynamic-tool") {
			parts.push({
				type: "dynamic-tool",
				toolName: part.toolName,
				toolCallId: part.toolCallId,
				state: "output-available",
				input: part.input,
				output: parsed.output,
			});
		} else {
			parts.push({
				type: part.type,
				toolCallId: part.toolCallId,
				state: "output-available",
				input: part.input,
				output: parsed.output,
			});
		}
	}
	return { ...a, parts };
}

/** True when `parts` hold model output: text, reasoning or a tool part (§3; not `data-*` markers). */
function hasModelOutput(parts: UIMessage["parts"]): boolean {
	return parts.some(
		(p) =>
			(p.type === "text" && p.text.length > 0) ||
			(p.type === "reasoning" && p.text.length > 0) ||
			isToolUIPart(p),
	);
}

// ── Acceptance (§5.1) ────────────────────────────────────────────────────────────────────────────

/** The input of {@link reserveTurn}: everything the route resolved before it (§5.1, §6). */
export interface ReserveTurnInput {
	/** The verified session's user, the thread's owner. Never from the request body. */
	userId: string;
	/** The billing org §6.1 resolved: the thread's pin, or the named org for its first turn. */
	orgId: string;
	threadId: string;
	/** The route's thread kind and project (null: an org thread). */
	threadKind: "agent" | "support";
	projectId: string | null;
	/** The ledger kind of the hold. */
	aiKind: MeteredAiKind;
	turn: TurnRequest;
	/** The request's messages. Only `u` and, for a continuation, the outputs of `P` are read. */
	messages: readonly UIMessage[];
	/**
	 * The route-validated `metadata` of an appended user turn (its mentions and cell target, §9.2).
	 * The request message's own `metadata` is never stored.
	 */
	turnMetadata?: UIMessage["metadata"];
}

/** A turn this process accepted: the handle its heartbeat and finalize name (held in memory only). */
export interface AcceptedTurn {
	claimId: string;
	token: string;
	userId: string;
	threadId: string;
	threadKind: "agent" | "support";
	projectId: string | null;
	billingOrgId: string;
	aiKind: MeteredAiKind;
	turnId: string;
	attemptKey: string;
	attemptNo: number;
	kind: AcceptClassification["kind"];
	/** The thread's revision after acceptance; finalize stores only while it still holds. */
	acceptedRevision: number;
	/** The hold (`settle`), or the self-host bypass (a fixed charge of 0). */
	charge: AiCharge;
	/**
	 * The model's input, built from the STORED transcript (§5.2): `T` after step 8; `T` without `a`
	 * for a regenerate; `T` with `a` cut after the approval's step for a resume.
	 */
	modelInput: UIMessage[];
}

/** What {@link reserveTurn} answered. */
export type ReserveTurnResult =
	| { outcome: "accepted"; turn: AcceptedTurn }
	| { outcome: "refused"; status: TurnRefusalStatus; body: TurnRefusal }
	/** A 400: a malformed turn, a request that contradicts its turn fields, or an output that fails its schema. */
	| { outcome: "invalid"; reason: string }
	/** A 402: the budget refused the hold; everything this acceptance wrote was rolled back. */
	| { outcome: "budget"; error: AiBudgetError }
	/**
	 * The thread's pin is not the org this call locked (§5.1 step 2: a racing first turn wrote it).
	 * Nothing was written; re-run §6.1 for `pinnedOrgId` and call once more.
	 */
	| { outcome: "pin-moved"; pinnedOrgId: string };

/** Unwinds the acceptance transaction (rolling back everything it wrote) with what to answer. */
class Halt extends Error {
	constructor(
		readonly result:
			| Exclude<ReserveTurnResult, { outcome: "accepted" | "budget" }>
			| { outcome: "budget-refused"; refusal: AiBudgetRefusal },
	) {
		super("reserveTurn halted");
	}
}

/** Refuse `code` from inside the acceptance transaction. */
function halt(body: TurnRefusal): never {
	throw new Halt({ outcome: "refused", status: TURN_REFUSAL_STATUS[body.refusal], body });
}

/** A running claim as acceptance and the sweep lock it, with the database's clock. */
const runningClaimColumns = {
	id: agentTurnClaims.id,
	attemptKey: agentTurnClaims.attempt_key,
	leaseUntil: agentTurnClaims.lease_until,
	acceptedAt: agentTurnClaims.accepted_at,
	now: sql`now()`.mapWith(agentTurnClaims.accepted_at),
};

/**
 * C8 on the caller's transaction, which already holds the thread's lock: `claimId` (of `userId`,
 * still `running`) becomes `expired`, and its hold is released to 0 with `settled_at` stamped, as
 * `releaseStrandedAiHolds` does. Both on `tx` — never through `releaseAiHold`, whose pooled
 * connection is the deadlock `ai-guard.ts` warns about and would not be atomic with the claim.
 */
async function expireClaim(tx: Tx, claimId: string, userId: string, why: ClaimExpiry): Promise<boolean> {
	const [expired] = await tx
		.update(agentTurnClaims)
		.set({ state: "expired", error: why, finished_at: sql`now()`, updated_at: sql`now()` })
		.where(
			and(
				eq(agentTurnClaims.id, claimId),
				eq(agentTurnClaims.user_id, userId),
				eq(agentTurnClaims.state, "running"),
			),
		)
		.returning({ holdId: agentTurnClaims.hold_id });
	if (!expired) return false;
	if (expired.holdId) {
		await tx
			.update(aiUsageLedger)
			.set({ credits: 0, settled_at: sql`now()` })
			.where(and(eq(aiUsageLedger.id, expired.holdId), sql`${aiUsageLedger.settled_at} is null`));
	}
	return true;
}

/**
 * Lock the running claims of `threadId` (at most one) and run C8 on any that is silent or past its
 * bound. Returns the one still running, or null. The caller holds the thread's lock (§5's order).
 */
async function expireStaleRunning(
	tx: Tx,
	threadId: string,
	userId: string,
): Promise<{ id: string; attemptKey: string } | null> {
	const running = await tx
		.select(runningClaimColumns)
		.from(agentTurnClaims)
		.where(
			and(
				eq(agentTurnClaims.thread_id, threadId),
				eq(agentTurnClaims.user_id, userId),
				eq(agentTurnClaims.state, "running"),
			),
		)
		.for("update");
	let live: { id: string; attemptKey: string } | null = null;
	for (const claim of running) {
		const why = claimExpiry(claim, claim.now);
		if (why) await expireClaim(tx, claim.id, userId, why);
		else live = { id: claim.id, attemptKey: claim.attemptKey };
	}
	return live;
}

/** The thread row acceptance locks (§5.1 step 2). */
interface LockedThread {
	kind: string;
	projectId: string | null;
	status: string;
	billingOrgId: string | null;
	revision: number;
	messages: UIMessage[];
}

/** `SELECT … FOR UPDATE` of the caller's thread row (`user_id` named): the row, or undefined. */
async function selectThreadForUpdate(tx: Tx, threadId: string, userId: string): Promise<LockedThread | undefined> {
	const [row] = await tx
		.select({
			kind: agentThreads.kind,
			projectId: agentThreads.project_id,
			status: agentThreads.status,
			billingOrgId: agentThreads.billing_org_id,
			revision: agentThreads.revision,
			messages: agentThreads.messages,
		})
		.from(agentThreads)
		.where(and(eq(agentThreads.id, threadId), eq(agentThreads.user_id, userId)))
		.for("update");
	return row;
}

/**
 * §5.1 step 2: lock the caller's thread, or recreate a reaped `agent` thread under its id (running
 * C8 on the id's claims first, then deleting its terminal claims, so a turn the old thread answered
 * cannot answer `turn-answered` in the new one). Refuses a tombstone, a missing support thread, an
 * id held by another owner, and a thread of another kind or project.
 *
 * When the recreating INSERT does nothing, another transaction committed a row under the id after
 * this one's first read: another owner's (404), this owner's tombstone (410), or this owner's LIVE
 * thread, which a concurrent first turn under ANOTHER org (so another advisory lock) just created.
 * That row is locked like any existing one, so the second request reads the first one's pin and
 * claim (§4.3 case 8) instead of being told the thread does not exist.
 */
async function lockThread(tx: Tx, input: ReserveTurnInput, u: UIMessage | undefined): Promise<LockedThread> {
	const { threadId, userId, turn } = input;
	const notFound = (): never => halt(turnRefusal("thread-not-found", turn.turnId, [], null));
	/** The checks every existing row of the caller's goes through. */
	const existing = (row: LockedThread): LockedThread => {
		if (row.status === THREAD_DELETED) halt(turnRefusal("thread-deleted", turn.turnId, [], null));
		if (row.kind !== input.threadKind || row.projectId !== input.projectId) notFound();
		return row;
	};
	const row = await selectThreadForUpdate(tx, threadId, userId);
	if (row) return existing(row);
	// dev never recreates a support thread (no client creates one), and this does not start to.
	if (input.threadKind !== "agent") notFound();
	const [inserted] = await tx
		.insert(agentThreads)
		.values({
			id: threadId,
			user_id: userId,
			org_id: userId,
			title: threadTitle(u ? turnText(u) : undefined),
			kind: "agent",
			...(input.projectId ? { project_id: input.projectId } : {}),
		})
		.onConflictDoNothing({ target: agentThreads.id })
		.returning({ revision: agentThreads.revision });
	if (!inserted) {
		// A row committed under the id since the first read: lock it (a fresh READ COMMITTED snapshot).
		const raced = await selectThreadForUpdate(tx, threadId, userId);
		return raced ? existing(raced) : notFound();
	}
	// C8 first, so a claim it ends is deleted with the rest instead of surviving on the new id.
	await expireStaleRunning(tx, threadId, userId);
	await tx
		.delete(agentTurnClaims)
		.where(
			and(
				eq(agentTurnClaims.thread_id, threadId),
				eq(agentTurnClaims.user_id, userId),
				ne(agentTurnClaims.state, "running"),
			),
		);
	return {
		kind: "agent",
		projectId: input.projectId,
		status: "active",
		billingOrgId: null,
		revision: inserted.revision,
		messages: [],
	};
}

/**
 * Accept a chat turn (ADR 0003 §5.1): ONE service-role transaction on ONE connection that takes the
 * org's AI-budget lock, locks the thread, runs C8 on its stale running claim, classifies the request
 * against the stored transcript, inserts or re-arms the key's claim, reserves the hold, and appends
 * the user turn (or merges a continuation's approval outputs). All of it commits, or none of it does,
 * so a second request for one turn waits on the thread lock, reads the first one's claim, and is
 * refused before it reaches the hold.
 *
 * A refusal, a 400 and a 402 roll the whole transaction back. The 402's `AiBudgetError` is built only
 * after the rollback, because its reset times are read on a pooled connection.
 */
export async function reserveTurn(input: ReserveTurnInput): Promise<ReserveTurnResult> {
	if (!turnIdSchema.safeParse(input.turn.turnId).success) {
		return { outcome: "invalid", reason: "the turn id is malformed" };
	}
	const hosted = isStripeConfigured();
	try {
		const turn = await getServiceDb().transaction((tx) => acceptOnTx(tx, input, hosted));
		return { outcome: "accepted", turn };
	} catch (err) {
		if (!(err instanceof Halt)) throw err;
		const r = err.result;
		if (r.outcome !== "budget-refused") return r;
		// Rolled back and the lock released: now the error may read its reset times on the pool.
		return { outcome: "budget", error: await aiBudgetRefusalError(input.orgId, input.userId, r.refusal) };
	}
}

/** The body of {@link reserveTurn}'s transaction: §5.1 steps 1-8, in order. */
async function acceptOnTx(tx: Tx, input: ReserveTurnInput, hosted: boolean): Promise<AcceptedTurn> {
	const { userId, orgId, threadId, turn } = input;
	const requestLast = input.messages.at(-1);
	const u = [...input.messages].reverse().find((m) => m.role === "user" && m.id === turn.turnId);

	// 1. The org's AI-budget advisory lock, first, always (the lock `reserveAiHold` re-enters).
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ai_budget'), hashtext(${orgId}))`);

	// 2. The thread, locked; the pin checked or written.
	const thread = await lockThread(tx, input, u);
	if (thread.billingOrgId !== null && thread.billingOrgId !== orgId) {
		throw new Halt({ outcome: "pin-moved", pinnedOrgId: thread.billingOrgId });
	}
	if (thread.billingOrgId === null) {
		await tx
			.update(agentThreads)
			.set({ billing_org_id: orgId })
			.where(
				and(
					eq(agentThreads.id, threadId),
					eq(agentThreads.user_id, userId),
					sql`${agentThreads.billing_org_id} is null`,
				),
			);
	}
	const stored = thread.messages;
	const refuse = (code: TurnRefusalCode, answerId?: string | null): never =>
		halt(turnRefusal(code, turn.turnId, stored, thread.revision, answerId));

	// 3. C8 on this thread's running claim, if its lease is silent or it is past its bound.
	const running = await expireStaleRunning(tx, threadId, userId);

	// 4. Classify against the locked transcript, then read the key's claim row.
	const claims: ClaimSnapshot[] = await tx
		.select({
			attemptKey: agentTurnClaims.attempt_key,
			state: agentTurnClaims.state,
			partial: agentTurnClaims.partial,
		})
		.from(agentTurnClaims)
		.where(
			and(
				eq(agentTurnClaims.thread_id, threadId),
				eq(agentTurnClaims.user_id, userId),
				like(agentTurnClaims.attempt_key, "continue:%"),
			),
		);
	const cls = classifyTurn({
		turn,
		requestMessages: input.messages,
		stored,
		revision: thread.revision,
		claims,
	});
	if (cls.outcome === "invalid") throw new Halt({ outcome: "invalid", reason: cls.reason });
	if (cls.outcome === "refuse") return refuse(cls.refusal, cls.answerId);

	// The transcript writes of step 8, decided (and validated) before anything is written.
	let appendTurn: UIMessage | null = null;
	let mergedAnswer: UIMessage | null = null;
	if (cls.kind === "answer" && cls.appendTurn) {
		if (!u) throw new Halt({ outcome: "invalid", reason: "the turn is not in the request" });
		appendTurn = {
			id: u.id,
			role: "user",
			parts: u.parts,
			...(input.turnMetadata === undefined ? {} : { metadata: input.turnMetadata }),
		};
	}
	if (cls.kind === "continue" && cls.mode === "first") {
		const a = stored.at(-1);
		if (!a || !requestLast) throw new Error("unreachable: a continuation without its answer");
		mergedAnswer = mergeClientOutputs(a, requestLast, cls.pending);
		if (!mergedAnswer) {
			throw new Halt({ outcome: "invalid", reason: "an approval output failed its schema or size cap" });
		}
	}

	const [key] = await tx
		.select({
			id: agentTurnClaims.id,
			state: agentTurnClaims.state,
			partial: agentTurnClaims.partial,
			attemptNo: agentTurnClaims.attempt_no,
		})
		.from(agentTurnClaims)
		.where(
			and(
				eq(agentTurnClaims.thread_id, threadId),
				eq(agentTurnClaims.user_id, userId),
				eq(agentTurnClaims.turn_id, turn.turnId),
				eq(agentTurnClaims.attempt_key, cls.attemptKey),
			),
		)
		.for("update");
	const keyClaim: KeyClaim | null = key ?? null;

	// 5. Another attempt of this thread running: thread-busy (after the key's own row, step 4).
	const decision = decideAcceptance(cls, keyClaim, running !== null && running.id !== keyClaim?.id);
	if (decision.action === "refuse") return refuse(decision.refusal);

	// 6. Insert (C1) or re-arm (C2, C4r) the claim.
	const writes = appendTurn !== null || mergedAnswer !== null;
	const acceptedRevision = thread.revision + (writes ? 1 : 0);
	const token = randomUUID();
	const copies = {
		billing_org_id: orgId,
		project_id: thread.projectId,
		accepted_revision: acceptedRevision,
		lease_until: LEASE_SQL,
		accepted_at: sql`now()`,
		updated_at: sql`now()`,
	};
	let claimId: string;
	let attemptNo: number;
	if (decision.action === "insert") {
		const [row] = await tx
			.insert(agentTurnClaims)
			.values({
				thread_id: threadId,
				user_id: userId,
				turn_id: turn.turnId,
				attempt_key: cls.attemptKey,
				state: "running",
				token,
				...copies,
			})
			.returning({ id: agentTurnClaims.id, attemptNo: agentTurnClaims.attempt_no });
		claimId = row.id;
		attemptNo = row.attemptNo;
	} else {
		const [row] = await tx
			.update(agentTurnClaims)
			.set({ ...rearmedClaim(decision.claim, token), ...copies })
			.where(
				and(
					eq(agentTurnClaims.id, decision.claim.id),
					eq(agentTurnClaims.user_id, userId),
					eq(agentTurnClaims.state, decision.from),
				),
			)
			.returning({ id: agentTurnClaims.id, attemptNo: agentTurnClaims.attempt_no });
		if (!row) throw new Error(`claim ${decision.claim.id} changed under the thread lock`);
		claimId = row.id;
		attemptNo = row.attemptNo;
	}

	// 7. The hold, on THIS transaction (it re-enters step 1's lock and reads the plan on `tx`).
	let charge: AiCharge = { source: "included", credits: 0 };
	if (hosted) {
		const hold = await reserveAiHold(tx, orgId, input.aiKind, userId);
		if (hold.outcome === "refused") throw new Halt({ outcome: "budget-refused", refusal: hold.refusal });
		charge = hold.charge;
		await tx
			.update(agentTurnClaims)
			.set({ hold_id: hold.charge.holdId })
			.where(and(eq(agentTurnClaims.id, claimId), eq(agentTurnClaims.user_id, userId)));
	}

	// 8. Append the user turn, or merge the approval outputs: durable from acceptance.
	const rows = transcriptRows(tx, userId);
	let modelInput: UIMessage[] = stored;
	if (appendTurn) {
		const rev = await rows.appendLive(threadId, input.threadKind, input.projectId, thread.revision, [appendTurn]);
		if (rev !== acceptedRevision) throw new Error(`thread ${threadId} moved under its lock`);
		modelInput = [...stored, appendTurn];
	} else if (mergedAnswer) {
		const rev = await rows.replaceLast(threadId, input.threadKind, input.projectId, thread.revision, mergedAnswer);
		if (rev !== acceptedRevision) throw new Error(`thread ${threadId} moved under its lock`);
		modelInput = [...stored.slice(0, -1), mergedAnswer];
	} else if (cls.kind === "regenerate") {
		modelInput = stored.slice(0, -1);
	} else if (cls.kind === "continue" && cls.mode === "resume") {
		const a = stored.at(-1);
		if (!a) throw new Error("unreachable: a resume without its answer");
		modelInput = [...stored.slice(0, -1), cutAfterApprovalStep(a, cls.pending)];
	}

	// 9. The caller's commit is the acceptance.
	return {
		claimId,
		token,
		userId,
		threadId,
		threadKind: input.threadKind,
		projectId: input.projectId,
		billingOrgId: orgId,
		aiKind: input.aiKind,
		turnId: turn.turnId,
		attemptKey: cls.attemptKey,
		attemptNo,
		kind: cls.kind,
		acceptedRevision,
		charge,
		modelInput,
	};
}

// ── The heartbeat (C5) ───────────────────────────────────────────────────────────────────────────

/**
 * Renew the lease of `turn`'s claim to now() + {@link TURN_LEASE_MS} (C5). One transaction holding
 * ONE lock, the claim row, and waiting on nothing else, so it cannot close a deadlock cycle. False
 * when the claim no longer matches (expired by C8, re-armed under another token, or past its age
 * bound): the route then aborts the model, because its finalize can no longer store. A deleted
 * thread does NOT stop it: the claim survives the delete (§4.3, Q4).
 */
export async function heartbeatTurn(turn: Pick<AcceptedTurn, "claimId" | "token" | "userId">): Promise<boolean> {
	return getServiceDb().transaction(async (tx) => {
		const [claim] = await tx
			.select({
				state: agentTurnClaims.state,
				token: agentTurnClaims.token,
				acceptedAt: agentTurnClaims.accepted_at,
				now: sql`now()`.mapWith(agentTurnClaims.accepted_at),
			})
			.from(agentTurnClaims)
			.where(and(eq(agentTurnClaims.id, turn.claimId), eq(agentTurnClaims.user_id, turn.userId)))
			.for("update");
		if (!claim || !heartbeatRenews(claim, turn.token, claim.now)) return false;
		await tx
			.update(agentTurnClaims)
			.set({ lease_until: LEASE_SQL, updated_at: sql`now()` })
			.where(and(eq(agentTurnClaims.id, turn.claimId), eq(agentTurnClaims.user_id, turn.userId)));
		return true;
	});
}

// ── Finalize (§5.3) ──────────────────────────────────────────────────────────────────────────────

/** A code for an attempt that stored nothing (C7), never model or user text. */
export type FinalizeErrorCode =
	| "provider-error"
	| "aborted"
	| "timeout"
	| "stream-error"
	| "pre-stream-throw"
	| "no-output";

/** How an attempt ended, as the route reports it to {@link finalizeTurn}. */
export interface TurnOutcome {
	/**
	 * The answer message ai produced (for a continuation, the continued message), or null when the
	 * model emitted nothing. Model output in it decides C6 versus C7.
	 */
	answer: UIMessage | null;
	/** The steps collected by `onStepFinish` as each finished: the billing source on every path. */
	steps: AgentStep[];
	/** The answer ended by abort or timeout (§8.1): billed at least the reserve when stored. */
	partial: boolean;
	/** Why it ended without an answer, when it did. */
	error?: FinalizeErrorCode;
}

/** What {@link finalizeTurn} did (§5.3's four outcomes; `won` is C6 or C7). */
export type FinalizeResult =
	| { outcome: "won"; state: "answered"; answerId: string; revision: number }
	| { outcome: "won"; state: "failed" }
	| { outcome: "moved" }
	| { outcome: "deleted"; answerId: string; recoveredThreadId: string }
	| { outcome: "lost" };

/**
 * The message an attempt stores, or null when it produced no model output. A continuation (and a
 * resume) stores the SERVER's prefix of `a` (the last message of the model input) with only the
 * parts the attempt added after it, so the route's echo of the prefix is never what is stored.
 */
function answerToStore(turn: AcceptedTurn, answer: UIMessage | null): UIMessage | null {
	if (!answer) return null;
	if (turn.kind !== "continue") return hasModelOutput(answer.parts) ? answer : null;
	const prefix = turn.modelInput.at(-1);
	if (!prefix || answer.id !== prefix.id) return null;
	const added = answer.parts.slice(prefix.parts.length);
	return hasModelOutput(added) ? { ...prefix, parts: [...prefix.parts, ...added] } : null;
}

/** Thrown inside finalize's transaction to roll it back with a decided outcome. */
class FinalizeLost extends Error {
	constructor() {
		super("finalize lost its compare-and-set");
	}
}

/**
 * Finalize an accepted attempt (ADR 0003 §5.3), once, from whichever end of the stream comes first.
 * One service-role transaction in §5's lock order: lock the thread, then compare-and-set the claim
 * on `token AND state = 'running'`, then write the transcript and settle or release the hold on the
 * SAME transaction, so an answer is stored if and only if it is billed. Only the compare-and-set
 * winner stores (also into a Recovered thread when the thread was deleted), so a lost attempt can
 * never store or settle. The metering side effects run after the commit, and never after a rollback.
 *
 * A metering write that fails rolls the whole finalize back (nothing stored, the claim still
 * `running` until C8 releases its hold), is logged as `finalize-metering-failed`, and is rethrown.
 */
export async function finalizeTurn(turn: AcceptedTurn, outcome: TurnOutcome): Promise<FinalizeResult> {
	const message = answerToStore(turn, outcome.answer);
	let meteringFailed = false;
	let afterCommit: AiUsageAfterCommit = () => {};

	/** Settle (`steps`, floored) or release (no steps) the attempt's hold on `tx`. */
	const meter = async (tx: Tx, steps: AgentStep[], floor: number): Promise<void> => {
		try {
			afterCommit = await recordAgentTurnUsage(
				{
					orgId: turn.billingOrgId,
					userId: turn.userId,
					kind: turn.aiKind,
					charge: turn.charge,
					refId: turn.threadId,
					steps,
					...(floor > 0 ? { floorCredits: floor } : {}),
				},
				tx,
			);
		} catch (err) {
			meteringFailed = true;
			throw err;
		}
	};

	let result: FinalizeResult;
	try {
		result = await getServiceDb().transaction(async (tx): Promise<FinalizeResult> => {
			// 1st lock: the thread (or nothing, when its row is gone).
			const [thread] = await tx
				.select({ status: agentThreads.status, revision: agentThreads.revision })
				.from(agentThreads)
				.where(and(eq(agentThreads.id, turn.threadId), eq(agentThreads.user_id, turn.userId)))
				.for("update");
			const deleted = !thread || thread.status === THREAD_DELETED;
			const moved = !deleted && thread.revision !== turn.acceptedRevision;
			const stores = message !== null && !moved;

			// 2nd lock: the claim, by compare-and-set. Only its winner goes on.
			const [won] = await tx
				.update(agentTurnClaims)
				.set(
					stores
						? { state: "answered", answer_id: message.id, partial: outcome.partial, error: null }
						: {
								state: "failed",
								error: message !== null && moved ? "transcript-moved" : (outcome.error ?? "no-output"),
							},
				)
				.where(
					and(
						eq(agentTurnClaims.id, turn.claimId),
						eq(agentTurnClaims.user_id, turn.userId),
						eq(agentTurnClaims.token, turn.token),
						eq(agentTurnClaims.state, "running"),
					),
				)
				.returning({ id: agentTurnClaims.id });
			if (!won) throw new FinalizeLost();
			await tx
				.update(agentTurnClaims)
				.set({ finished_at: sql`now()`, updated_at: sql`now()` })
				.where(and(eq(agentTurnClaims.id, turn.claimId), eq(agentTurnClaims.user_id, turn.userId)));

			// C7 (no model output) and C6m (the revision moved): nothing stored, the hold released to 0.
			if (!stores) {
				await meter(tx, [], 0);
				return message !== null && moved ? { outcome: "moved" } : { outcome: "won", state: "failed" };
			}

			const floor = outcome.partial && turn.charge.settle ? METERED_RESERVE_CREDITS : 0;
			const rows = transcriptRows(tx, turn.userId);
			if (deleted) {
				// The `deleted` outcome: the winner's answer reaches a Recovered thread, built from the
				// server's model input and the answer, and is settled with it.
				const transcript =
					turn.kind === "continue"
						? [...turn.modelInput.slice(0, -1), message]
						: [...turn.modelInput, message];
				const recovered = await recoverTranscript(
					rows,
					{ owner: turn.userId, threadId: turn.threadId, kind: turn.threadKind, projectId: turn.projectId },
					transcript,
				);
				await meter(tx, outcome.steps, floor);
				return { outcome: "deleted", answerId: message.id, recoveredThreadId: recovered.threadId };
			}

			// C6: append the answer (a first answer) or replace the last message (a regenerate replaces
			// `a`; a continuation and a resume replace `a` with its continued form), then settle.
			const revision =
				turn.kind === "answer"
					? await rows.appendLive(turn.threadId, turn.threadKind, turn.projectId, turn.acceptedRevision, [message])
					: await rows.replaceLast(turn.threadId, turn.threadKind, turn.projectId, turn.acceptedRevision, message);
			if (revision === null) throw new Error(`thread ${turn.threadId} moved under its lock`);
			await meter(tx, outcome.steps, floor);
			return { outcome: "won", state: "answered", answerId: message.id, revision };
		});
	} catch (err) {
		if (err instanceof FinalizeLost) return { outcome: "lost" };
		if (meteringFailed) {
			log.error("finalize-metering-failed", {
				org_id: turn.billingOrgId,
				thread_id: turn.threadId,
				claim_id: turn.claimId,
				err,
			});
		}
		throw err;
	}
	// Committed: the side effects of the settle (the generation capture and the spend alert).
	try {
		afterCommit();
	} catch (err) {
		log.warn("ai metering side effects failed after a committed finalize", {
			org_id: turn.billingOrgId,
			err,
		});
	}
	return result;
}

// ── Expiry for the sweep (C8) ────────────────────────────────────────────────────────────────────

/** How many claims one {@link expireSilentTurns} pass examines. */
const EXPIRE_BATCH_LIMIT = 500;

/**
 * C8 for the `release-ai-holds` sweep (§8.2 pass 1): every `running` claim whose lease is silent or
 * that is older than its age bound is set `expired` and its hold released to 0, ONE transaction per
 * claim, locked in §5's order: the thread `FOR UPDATE SKIP LOCKED` (a thread an acceptance or a
 * finalize holds is skipped, for the next pass), then the claim, re-checked under its lock, then the
 * ledger row. A claim whose thread row is gone (deleted and reaped) is expired all the same.
 */
export async function expireSilentTurns(): Promise<{ expired: number }> {
	const db = getServiceDb();
	const candidates = await db
		.select({ id: agentTurnClaims.id, threadId: agentTurnClaims.thread_id, userId: agentTurnClaims.user_id })
		.from(agentTurnClaims)
		.where(
			and(
				eq(agentTurnClaims.state, "running"),
				sql`(${agentTurnClaims.lease_until} < now() or ${agentTurnClaims.accepted_at} < now() - make_interval(secs => ${TURN_AGE_BOUND_MS / 1000}))`,
			),
		)
		.limit(EXPIRE_BATCH_LIMIT);
	let expired = 0;
	for (const c of candidates) {
		const done = await db.transaction(async (tx) => {
			const [locked] = await tx
				.select({ id: agentThreads.id })
				.from(agentThreads)
				.where(and(eq(agentThreads.id, c.threadId), eq(agentThreads.user_id, c.userId)))
				.for("update", { skipLocked: true });
			if (!locked) {
				// Skipped (another transaction holds it) or gone: only a gone row is expired here.
				const [exists] = await tx
					.select({ id: agentThreads.id })
					.from(agentThreads)
					.where(and(eq(agentThreads.id, c.threadId), eq(agentThreads.user_id, c.userId)));
				if (exists) return false;
			}
			const [claim] = await tx
				.select(runningClaimColumns)
				.from(agentTurnClaims)
				.where(
					and(
						eq(agentTurnClaims.id, c.id),
						eq(agentTurnClaims.user_id, c.userId),
						eq(agentTurnClaims.state, "running"),
					),
				)
				.for("update");
			const why = claim ? claimExpiry(claim, claim.now) : null;
			return why ? expireClaim(tx, c.id, c.userId, why) : false;
		});
		if (done) expired += 1;
	}
	return { expired };
}
