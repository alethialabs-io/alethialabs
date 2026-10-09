// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The preamble every Elench draft action runs (ADR 0001 §4 steps 2-7), and the reads they share.
// The actions (app/server/actions/elench-drafts.ts) parse their own input (step 1) and hand the
// gate the scope it names; the gate resolves the actor, refuses a key of another org, rate limits,
// authorizes the scope quietly, and runs the action's body in one `withActorScope` transaction.
// Every expected failure comes back as an outcome of lib/elench/draft-outcomes.ts, never a throw.

import type { UIMessage } from "ai";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { THREAD_DELETED } from "@/lib/agent/transcript-save";
import { turnText } from "@/lib/agent/turn-key";
import { UnauthorizedError } from "@/lib/auth/errors";
import { getOwnerScope } from "@/lib/auth/owner";
import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { getServiceDb, type Tx, withActorScope } from "@/lib/db";
import { causeChain, pgErrorCode } from "@/lib/db/pg-error";
import {
	agentThreads,
	type ElenchDraft,
	elenchDrafts,
	member,
	organization,
	projects,
} from "@/lib/db/schema";
import type {
	DraftGateRefusal,
	DraftThread,
	DraftThreadStatus,
	ServerDraft,
} from "@/lib/elench/draft-outcomes";
import { errorDigest, errorName } from "@/lib/errors";
import { log } from "@/lib/observability/log";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";

const glog = log.child({ component: "elench-drafts" });

/** Draft requests one user may make per {@link DRAFT_RATE_WINDOW_MS} (§4 step 7). */
export const DRAFT_RATE_LIMIT = 20;

/** The rate limit's window: one second. */
export const DRAFT_RATE_WINDOW_MS = 1000;

/** The rate-limit bucket of a user's draft requests, shared by every draft action. */
export function draftRateKey(userId: string): string {
	return `elench-drafts:${userId}`;
}

/**
 * The scope a draft request names. `keyOrgId` is the key's org (every keyed action); `orgHint` is
 * the org a keyless action's tab last listed (`listDrafts`). Each is used only to choose between
 * `address` and `membership` when the page's org cannot be resolved (§4 step 2), and `keyOrgId` to
 * refuse a key of another org (step 3). Neither is ever trusted as a tenant.
 */
export interface DraftScope {
	keyOrgId: string | null;
	orgHint: string | null;
	projectId: string | null;
}

/** True when `e` is Next's `notFound()` signal, which `currentActor()` throws for a lost org slug. */
export function isNotFoundSignal(e: unknown): boolean {
	const digest = errorDigest(e) ?? "";
	return digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404") || digest === "NEXT_NOT_FOUND";
}

/**
 * True when `e` came from the database: anything in its cause chain is a Drizzle query error or a
 * postgres.js error, or carries a code (a SQLSTATE, or a connection error's `ECONNREFUSED`).
 * Only these become `unavailable`; any other throw is a defect and is rethrown: §4 step 6 keeps
 * `unavailable` for the transient case, so slice 7's client will not retry a defect for ever.
 */
export function isDatabaseError(e: unknown): boolean {
	if (pgErrorCode(e) !== undefined) return true;
	return causeChain(e).some((link) => {
		const name = errorName(link);
		return name === "DrizzleQueryError" || name === "PostgresError";
	});
}

/**
 * §4 step 2: the page's slug no longer resolves for this user. One service-role read of the
 * caller's OWN membership in `hintOrgId` decides which true thing happened: the org still exists
 * for them under another address (`address`, with its current slug), or it no longer admits them
 * (`membership`). The read names only `hintOrgId` and the session's user, so it tells the caller
 * nothing a membership list does not.
 */
async function refuseLostScope(
	userId: string,
	hintOrgId: string | null,
): Promise<DraftGateRefusal> {
	if (hintOrgId === null) return { outcome: "forbidden", reason: "membership" };
	// The personal org: in community every slug resolves here, so a renamed slug is the same
	// tenant; slice 7's client will word it as "Open Elench again to save" (A13).
	if (hintOrgId === userId) {
		return { outcome: "scope-changed", reason: "address", slug: PERSONAL_ORG_SLUG };
	}
	const [membership] = await getServiceDb()
		.select({ orgId: member.organizationId })
		.from(member)
		.where(
			and(
				eq(member.organizationId, hintOrgId),
				eq(member.userId, userId),
				eq(member.status, "active"),
			),
		)
		.limit(1);
	if (!membership) return { outcome: "forbidden", reason: "membership" };
	const [org] = await getServiceDb()
		.select({ slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, membership.orgId))
		.limit(1);
	// An org with no slug has no address to offer, so the only true answer left is that this page
	// cannot reach it.
	if (!org?.slug) return { outcome: "forbidden", reason: "membership" };
	return { outcome: "scope-changed", reason: "address", slug: org.slug };
}

/**
 * Maps a throw from the preamble or the body to its outcome (§4 step 6), or rethrows it. A
 * `notFound()` is step 2's lost scope; a redirect and every other unexpected throw propagate.
 * The lost-scope reads run here, inside the catch, so a throw from THEM (a database outage on the
 * service-role membership read, a session that is gone) is classified the same way rather than
 * escaping the action as a rejection.
 */
async function classifyThrow(e: unknown, scope: DraftScope): Promise<DraftGateRefusal> {
	if (!isNotFoundSignal(e)) return classifyPlainThrow(e);
	try {
		// `currentActor()` threw after the session resolved (only the address failed), so the
		// session read here answers the same user.
		const { userId } = await getOwnerScope();
		return await refuseLostScope(userId, scope.keyOrgId ?? scope.orgHint);
	} catch (inner) {
		return classifyPlainThrow(inner);
	}
}

/**
 * Maps a throw that is not a `notFound()` to its outcome: no session is `unauthorized`, a refused
 * authorization `forbidden`, a database error `unavailable`. Anything else is rethrown.
 */
function classifyPlainThrow(e: unknown): DraftGateRefusal {
	if (e instanceof UnauthorizedError) return { outcome: "unauthorized" };
	if (e instanceof ForbiddenError) return { outcome: "forbidden" };
	if (isDatabaseError(e)) {
		// The name only: a driver error's message can quote the statement's parameters, which here
		// include the user's draft text.
		glog.error("draft action database error", { error: errorName(e) });
		return { outcome: "unavailable" };
	}
	throw e;
}

/**
 * §4 step 4: authorizes the scope quietly (an autosave is not an activity-log event). For a
 * project anchor it FIRST reads the project with `org_id = actor.orgId`: `authorizeQuiet` alone
 * admits any project id for an org-wide grant (`coversResource` never looks at the target), so
 * without this read a member with an org-wide `project:view` would pass for another org's project.
 * Throws `ForbiddenError` on either failure, the same for another org's project and a missing one.
 */
async function authorizeScope(actor: Actor, projectId: string | null): Promise<void> {
	if (projectId === null) {
		await authorizeQuiet("view", { type: "org" });
		return;
	}
	const inOrg = await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.id, projectId), eq(projects.org_id, actor.orgId)))
			.limit(1);
		return row !== undefined;
	});
	if (!inOrg) {
		throw new ForbiddenError("view", { type: "project", id: projectId }, "not a project of this org");
	}
	await authorizeQuiet("view", { type: "project", id: projectId });
}

/**
 * Runs a draft action's body behind §4's preamble: the actor (step 2, with the `notFound()`
 * mapping), the org check (step 3), the rate limit (step 7), quiet authorization (step 4), and one
 * `withActorScope` transaction for the body (step 5). Returns the body's answer, or the refusal.
 */
export async function runDraftGate<T>(
	scope: DraftScope,
	body: (actor: Actor, tx: Tx) => Promise<T>,
): Promise<T | DraftGateRefusal> {
	try {
		const actor = await currentActor();
		if (scope.keyOrgId !== null && scope.keyOrgId !== actor.orgId) {
			return { outcome: "scope-changed", reason: "other-org" };
		}
		const rate = await checkRateLimit(
			draftRateKey(actor.userId),
			DRAFT_RATE_LIMIT,
			DRAFT_RATE_WINDOW_MS,
		);
		if (!rate.ok) return { outcome: "rate-limited" };
		await authorizeScope(actor, scope.projectId);
		return await withActorScope(actor, (tx) => body(actor, tx));
	} catch (e) {
		return classifyThrow(e, scope);
	}
}

// ── Reads every action shares ───────────────────────────────────────────────────────────────────

/**
 * Serializes the new-row path of one scope (§4.3): a transaction-scoped advisory lock on the
 * caller's `(user, org, anchor)`, released at commit or rollback. Taken before the active-draft
 * count, so two concurrent base-0 saves of different conversations in one scope count one after
 * the other instead of both reading 199 and both inserting.
 */
export async function lockDraftScope(
	tx: Tx,
	actor: Actor,
	projectId: string | null,
): Promise<void> {
	const scopeKey = `elench-drafts:${actor.userId}:${actor.orgId}:${projectId ?? "~"}`;
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`);
}

/**
 * Locks the caller's draft row for a key `FOR UPDATE`, or returns null when there is none. The
 * explicit `user_id` and `org_id` predicates are the actor's, the same pair the RLS policy pins.
 */
export async function lockDraft(
	tx: Tx,
	actor: Actor,
	conversationId: string,
): Promise<ElenchDraft | null> {
	const [row] = await tx
		.select()
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.user_id, actor.userId),
				eq(elenchDrafts.org_id, actor.orgId),
				eq(elenchDrafts.conversation_id, conversationId),
			),
		)
		.limit(1)
		.for("update");
	return row ?? null;
}

/** The thread status of §2 for a thread row's status and message count (undefined = no row). */
export function threadStatusOf(
	thread: { status: string; messageCount: number } | undefined,
): DraftThreadStatus {
	if (!thread) return "none";
	if (thread.status === THREAD_DELETED) return "deleted";
	return thread.messageCount > 0 ? "listed" : "unlisted";
}

/** The columns of a thread row the status of §2 and the Unsent label need, never its transcript. */
export const threadSummaryColumns = {
	id: agentThreads.id,
	status: agentThreads.status,
	title: agentThreads.title,
	firstTurnId: sql<string | null>`${agentThreads.messages}->0->>'id'`,
	messageCount: sql<number>`jsonb_array_length(${agentThreads.messages})`.mapWith(Number),
};

/**
 * Whether the caller's live thread stores `turnId`, and with which text (§4.2's `hasTurn`, split
 * three ways): `same` when a message with that id has the same `turnText` as `text`, `different`
 * when the id is stored only with another text, `absent` when the id is not stored. `turnText` is
 * applied to BOTH sides, so a turn sent trimmed equals its untrimmed draft (B3). This is the one
 * implementation of the rule: `hasTurn` is `same`, and the claim's settle and release read all three.
 */
export async function storedTurn(
	tx: Tx,
	actor: Actor,
	conversationId: string,
	turnId: string,
	text: string,
): Promise<"same" | "different" | "absent"> {
	const [thread] = await tx
		.select({ messages: agentThreads.messages })
		.from(agentThreads)
		.where(
			and(
				eq(agentThreads.id, conversationId),
				eq(agentThreads.user_id, actor.userId),
				ne(agentThreads.status, THREAD_DELETED),
			),
		)
		.limit(1);
	if (!thread) return "absent";
	const drafted: UIMessage = { id: turnId, role: "user", parts: [{ type: "text", text }] };
	const want = turnText(drafted);
	const withId = thread.messages.filter((m) => m.id === turnId);
	if (withId.length === 0) return "absent";
	return withId.some((m) => turnText(m) === want) ? "same" : "different";
}

/**
 * §4.2's `thread` for a key, read in the caller's transaction. Every statement names
 * `user_id = actor.userId` (§4 step 5): `owner_all` on `agent_threads` also admits every row whose
 * `org_id` is the page's org, so the predicate, not the policy, keeps this to the caller's threads.
 * `turnId` is the turn the request names (a claim's), or null when it names none.
 */
export async function readThread(
	tx: Tx,
	actor: Actor,
	conversationId: string,
	turnId: string | null,
	text: string,
): Promise<DraftThread & { title: string | null }> {
	const [thread] = await tx
		.select(threadSummaryColumns)
		.from(agentThreads)
		.where(and(eq(agentThreads.id, conversationId), eq(agentThreads.user_id, actor.userId)))
		.limit(1);
	const status = threadStatusOf(thread);
	const live = status === "listed" || status === "unlisted";
	return {
		status,
		firstTurnId: live ? (thread?.firstTurnId ?? null) : null,
		hasTurn:
			status === "listed" && turnId !== null
				? (await storedTurn(tx, actor, conversationId, turnId, text)) === "same"
				: false,
		title: live ? (thread?.title ?? null) : null,
	};
}

/** The summaries of the caller's threads among `ids`, keyed by id (one statement, `user_id` pinned). */
export async function readThreadSummaries(
	tx: Tx,
	actor: Actor,
	ids: string[],
): Promise<Map<string, { status: string; title: string | null; firstTurnId: string | null; messageCount: number }>> {
	const out = new Map<
		string,
		{ status: string; title: string | null; firstTurnId: string | null; messageCount: number }
	>();
	if (ids.length === 0) return out;
	const rows = await tx
		.select(threadSummaryColumns)
		.from(agentThreads)
		.where(and(inArray(agentThreads.id, ids), eq(agentThreads.user_id, actor.userId)));
	for (const row of rows) out.set(row.id, row);
	return out;
}

/** A draft row as the client sees it (§7.1's `ServerDraft`): never its row id or its user. */
export function toServerDraft(row: ElenchDraft): ServerDraft {
	const claim =
		row.status === "sending" &&
		row.claim_token !== null &&
		row.claim_turn_id !== null &&
		row.claim_kind !== null &&
		row.claimed_at !== null
			? {
					token: row.claim_token,
					turnId: row.claim_turn_id,
					kind: row.claim_kind,
					claimedAt: row.claimed_at.toISOString(),
				}
			: null;
	return {
		orgId: row.org_id,
		projectId: row.project_id,
		conversationId: row.conversation_id,
		revision: row.revision,
		state: row.status,
		content: {
			text: row.text,
			mentions: row.mentions,
			artifacts: row.artifacts,
			cellTarget: row.cell_target,
		},
		claim,
		failedSend: row.failed_send,
		lastSent: row.last_sent,
		threadSeen: row.thread_seen,
		title: row.title,
		lastWriter: row.last_writer,
		discardedAt: row.discarded_at?.toISOString() ?? null,
		updatedAt: row.updated_at.toISOString(),
	};
}
