// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An in-memory Elench server for the component tests of ADR 0001 slice 9: the draft actions with
// REAL compare-and-set semantics (§3.4's S1-S7, §4.2, §5.1), the threads they start, the two chat
// routes as a `fetch` stub that stores a turn the way ADR 0003's routes do (the user turn appended
// with the mentions and cell target of its OWN message's metadata, then the answer), and the heartbeat route. One server
// is shared by every tab or device of a test, so two of them meet exactly as they would in the
// database: in the rows.
//
// It answers at once unless the test planned otherwise for the next call of an action:
//   hold   — keep the call pending until `release` (applied then) or `loseHeld` (applied, never answered);
//   lose   — apply it now and never answer (a lost response);
//   reject — reject it with a network failure, applying nothing.
// Nothing here is the code under test; it stands in for the database and the routes.

import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import type {
	ClaimDraftInput,
	ConsumeDraftInput,
	DraftCasInput,
	ListDraftsInput,
	ReleaseClaimInput,
	SaveDraftInput,
	StartConversationInput,
} from "@/app/server/actions/elench-drafts";
import type { LoadedThread } from "@/app/server/actions/agent";
import type { TurnRefusal } from "@/lib/agent/turn-claims";
import { turnText } from "@/lib/agent/turn-key";
import type { DraftContent } from "@/lib/elench/draft-content";
import type {
	ClaimDraftResult,
	ConsumeDraftResult,
	DiscardDraftResult,
	DraftGateRefusal,
	DraftThread,
	ListDraftsResult,
	ReleaseClaimResult,
	RestoreDraftResult,
	SaveDraftResult,
	ServerDraft,
	StartConversationResult,
	TouchClaimResult,
} from "@/lib/elench/draft-outcomes";
import type { DraftsTransport } from "@/lib/stores/elench-drafts/store";

/** The lease (§3.4 S5): a claim silent this long is settled by the next action that locks its row. */
const LEASE_MS = 120_000;

const EMPTY: DraftContent = { text: "", mentions: [], artifacts: [], cellTarget: null };

/** One stored thread. */
export interface FakeThread {
	id: string;
	projectId: string | null;
	title: string;
	messages: UIMessage[];
	revision: number;
	deleted: boolean;
}

/** How the next call of an action is answered. */
export type CallPlan = "hold" | "lose" | "reject";

/** A call the server holds until the test releases it. */
interface Held {
	name: string;
	run: () => unknown;
	resolve: (value: unknown) => void;
}

/** What one chat request answers. */
export type RouteAnswer =
	| { kind: "answer"; text: string }
	| { kind: "refuse"; status: number; refusal: TurnRefusal }
	| { kind: "status"; status: number; body: string }
	| { kind: "hang" };

/** The draft actions' names. */
type ActionName = keyof DraftsTransport;

/** A request a chat route received, as the tests read it. */
export interface RouteRequest {
	threadId: string | null;
	messages: UIMessage[];
	/** The body's `mentions` field, if a client still sent one (the routes never read it). */
	mentions: unknown;
	/** The body's `cellTarget` field, if a client still sent one (the routes never read it). */
	cellTarget: unknown;
	turnId: string | null;
}

/** The id of a key's row. */
function rowId(k: { orgId: string; projectId: string | null; conversationId: string }): string {
	return `${k.orgId}:${k.projectId ?? "org"}:${k.conversationId}`;
}

/** The text a turn of `text` is stored with: ADR 0003's `turnText`, on both sides. */
function textTurn(text: string): string {
	return turnText({ id: "", role: "user", parts: [{ type: "text", text }] });
}

/** The in-memory server. */
export class FakeElenchServer {
	rows = new Map<string, ServerDraft>();
	threads = new Map<string, FakeThread>();
	/** Every action call, in order, with the tab's page org it was POSTed from. */
	calls: { name: string; page: string; input: unknown }[] = [];
	/** Every chat request, in order. */
	requests: RouteRequest[] = [];
	/** What the next chat requests answer; an empty queue answers "OK". */
	route: RouteAnswer[] = [];
	private plans = new Map<string, CallPlan[]>();
	private held: Held[] = [];
	/** Slugs renamed under a page (§4 step 2): the page then answers `scope-changed(address)`. */
	renamed = new Set<string>();

	/** Plans how the next call of `name` is answered. */
	plan(name: ActionName, plan: CallPlan): void {
		this.plans.set(name, [...(this.plans.get(name) ?? []), plan]);
	}

	/** Answers the oldest held call of `name` (applying it now). */
	release(name: ActionName): void {
		const i = this.held.findIndex((h) => h.name === name);
		if (i === -1) throw new Error(`no held ${name}`);
		const [h] = this.held.splice(i, 1);
		h.resolve(h.run());
	}

	/** Applies the oldest held call of `name` and never answers it (a lost response). */
	loseHeld(name: ActionName): void {
		const i = this.held.findIndex((h) => h.name === name);
		if (i === -1) throw new Error(`no held ${name}`);
		const [h] = this.held.splice(i, 1);
		h.run();
	}

	/** The calls of `name`. */
	callsOf(name: ActionName): unknown[] {
		return this.calls.filter((c) => c.name === name).map((c) => c.input);
	}

	/** A key's row, or undefined. */
	row(k: { orgId: string; projectId: string | null; conversationId: string }): ServerDraft | undefined {
		return this.rows.get(rowId(k));
	}

	/** Stores a thread directly (a thread another device made earlier). */
	putThread(t: Omit<FakeThread, "revision" | "deleted"> & Partial<FakeThread>): void {
		this.threads.set(t.id, { revision: 1, deleted: false, ...t });
	}

	/** Runs one action under its plan. */
	private call<T>(name: ActionName, page: string, input: unknown, run: () => T): Promise<T> {
		this.calls.push({ name, page, input });
		const plan = this.plans.get(name)?.shift();
		if (plan === "reject") return Promise.reject(new TypeError("Failed to fetch"));
		if (plan === "lose") {
			run();
			return new Promise<T>(() => undefined);
		}
		if (plan === "hold")
			return new Promise<T>((resolve) => {
				this.held.push({ name, run, resolve: (v) => resolve(v as T) });
			});
		return Promise.resolve(run());
	}

	/** The thread status of a conversation (§2), with `hasTurn` for `turnId` and `text` (§4.2). */
	private thread(conversationId: string, turnId: string | null, text: string): DraftThread {
		const t = this.threads.get(conversationId);
		if (t === undefined) return { status: "none", firstTurnId: null, hasTurn: false };
		if (t.deleted) return { status: "deleted", firstTurnId: null, hasTurn: false };
		const first = t.messages[0]?.id ?? null;
		const hasTurn =
			turnId !== null && t.messages.some((m) => m.id === turnId && turnText(m) === textTurn(text));
		return { status: t.messages.length > 0 ? "listed" : "unlisted", firstTurnId: first, hasTurn };
	}

	/** The `thread` of a row, read against its claim. */
	private threadOf(row: ServerDraft): DraftThread {
		return this.thread(row.conversationId, row.claim?.turnId ?? null, row.content.text);
	}

	/** Writes a row, adding one to its revision. */
	private write(row: ServerDraft, over: Partial<ServerDraft>): ServerDraft {
		const next: ServerDraft = { ...row, ...over, revision: row.revision + 1, updatedAt: new Date().toISOString() };
		this.rows.set(rowId(next), next);
		return next;
	}

	/** S5: settles a claim silent past the lease (never inside a request that presents its token). */
	private settle(row: ServerDraft): ServerDraft {
		if (row.state !== "sending" || row.claim === null) return row;
		if (Date.now() - Date.parse(row.claim.claimedAt) < LEASE_MS) return row;
		return this.releaseRow(row, "lease", row.claim.kind === "later", null);
	}

	/** S3 (or S2's draft half): the claim consumed, the content emptied. */
	private consumeRow(row: ServerDraft): ServerDraft {
		const claim = row.claim;
		if (claim === null) return row;
		return this.write(row, {
			state: "active",
			content: { ...EMPTY },
			claim: null,
			failedSend: null,
			lastSent: { turnId: claim.turnId, kind: claim.kind, at: new Date().toISOString() },
			threadSeen: true,
		});
	}

	/** S4 (and S5's release arms): the claim cleared, the text kept, the marker written. */
	private releaseRow(row: ServerDraft, error: string, uncertain: boolean, freshTurnId: string | null): ServerDraft {
		const claim = row.claim;
		if (claim === null) return row;
		if (freshTurnId === null && claim.kind === "later" && this.threadOf(row).hasTurn) return this.consumeRow(row);
		const stored = this.threads.get(row.conversationId)?.messages.some((m) => m.id === claim.turnId) ?? false;
		const nullId = freshTurnId === null && claim.kind === "later" && stored;
		return this.write(row, {
			state: "active",
			claim: null,
			failedSend: {
				turnId: nullId ? null : (freshTurnId ?? claim.turnId),
				kind: claim.kind,
				error,
				at: new Date().toISOString(),
				uncertain: freshTurnId === null && !nullId && uncertain,
			},
		});
	}

	/** The gate every action runs first (§4 steps 2-3): the page's org against the key's. */
	private gate(page: string, orgId: string | null): DraftGateRefusal | null {
		if (this.renamed.has(page)) return { outcome: "scope-changed", reason: "address", slug: "renamed" };
		if (orgId !== null && orgId !== page) return { outcome: "scope-changed", reason: "other-org" };
		return null;
	}

	/** The draft actions as POSTed from a page of `page()`'s org (each tab or device has its own). */
	transport(page: () => string): DraftsTransport {
		return {
			listDrafts: (input: ListDraftsInput) =>
				this.call<ListDraftsResult>("listDrafts", page(), input, () => {
					const refused = this.gate(page(), null);
					if (refused) return refused;
					const drafts = [...this.rows.values()]
						.filter((r) => r.orgId === page() && r.projectId === input.projectId)
						.map((r) => this.settle(r))
						.map((row) => ({ row, thread: this.threadOf(row), threadTitle: this.threads.get(row.conversationId)?.title ?? null }));
					return { outcome: "ok", orgId: page(), drafts };
				}),
			saveDraft: (input: SaveDraftInput) =>
				this.call<SaveDraftResult>("saveDraft", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const found = this.row(input);
					if (found === undefined) {
						if (input.baseRevision !== 0) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
						const row: ServerDraft = {
							orgId: input.orgId,
							projectId: input.projectId,
							conversationId: input.conversationId,
							revision: 1,
							state: "active",
							content: input.content,
							claim: null,
							failedSend: input.failedSend ? { ...input.failedSend, at: new Date().toISOString() } : null,
							lastSent: null,
							threadSeen: false,
							title: null,
							lastWriter: input.tabId,
							discardedAt: null,
							updatedAt: new Date().toISOString(),
						};
						this.rows.set(rowId(row), row);
						return { outcome: "saved", revision: 1 };
					}
					const row = this.settle(found);
					const thread = this.threadOf(row);
					if (row.state === "sending") return { outcome: "claimed", row, thread };
					if (row.state === "discarded") return { outcome: "discarded", row, thread };
					if (row.revision !== input.baseRevision) return { outcome: "conflict", row, thread };
					const changed = row.content.text !== input.content.text;
					let failedSend = row.failedSend;
					if (input.failedSend) failedSend = { ...input.failedSend, at: new Date().toISOString() };
					else if (input.dismissFailedSend) failedSend = null;
					else if (changed && failedSend !== null && !failedSend.uncertain) failedSend = null;
					const next = this.write(row, { content: input.content, failedSend, lastWriter: input.tabId });
					return { outcome: "saved", revision: next.revision };
				}),
			restoreDraft: (input: DraftCasInput) =>
				this.call<RestoreDraftResult>("restoreDraft", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const row = this.row(input);
					if (row === undefined) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
					if (row.state !== "discarded" || row.revision !== input.baseRevision)
						return { outcome: "conflict", row, thread: this.threadOf(row) };
					return { outcome: "saved", revision: this.write(row, { state: "active", discardedAt: null }).revision };
				}),
			discardDraft: (input: DraftCasInput) =>
				this.call<DiscardDraftResult>("discardDraft", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const found = this.row(input);
					if (found === undefined) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
					const row = this.settle(found);
					if (row.state === "sending") return { outcome: "claimed", row, thread: this.threadOf(row) };
					if (row.state !== "active" || row.revision !== input.baseRevision)
						return { outcome: "conflict", row, thread: this.threadOf(row) };
					const next = this.write(row, { state: "discarded", discardedAt: new Date().toISOString() });
					return { outcome: "discarded", revision: next.revision };
				}),
			claimDraft: (input: ClaimDraftInput) =>
				this.call<ClaimDraftResult>("claimDraft", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const found = this.row(input);
					const row = found === undefined ? undefined : this.settle(found);
					if (row?.state === "sending") {
						if (row.claim?.token === input.token)
							return { outcome: "claimed-by-you", revision: row.revision, content: row.content };
						return { outcome: "claimed", row, thread: this.threadOf(row) };
					}
					if (row?.state === "discarded") return { outcome: "discarded", row, thread: this.threadOf(row) };
					if (row === undefined && input.baseRevision !== 0)
						return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
					if (row !== undefined && row.revision !== input.baseRevision)
						return { outcome: "conflict", row, thread: this.threadOf(row) };
					if (input.content.text.trim() === "") return { outcome: "empty" };
					const thread = this.thread(input.conversationId, null, "");
					const stored = thread.status === "listed" || thread.status === "unlisted";
					if ((input.kind === "later") !== stored) return { outcome: "wrong-kind", thread };
					const base: ServerDraft = row ?? {
						orgId: input.orgId,
						projectId: input.projectId,
						conversationId: input.conversationId,
						revision: 0,
						state: "active",
						content: EMPTY,
						claim: null,
						failedSend: null,
						lastSent: null,
						threadSeen: false,
						title: null,
						lastWriter: null,
						discardedAt: null,
						updatedAt: new Date().toISOString(),
					};
					const next = this.write(base, {
						state: "sending",
						content: input.content,
						failedSend: null,
						lastWriter: input.tabId,
						claim: { token: input.token, turnId: input.turnId, kind: input.kind, claimedAt: new Date().toISOString() },
					});
					return { outcome: "claimed-by-you", revision: next.revision, content: next.content };
				}),
			consumeDraft: (input: ConsumeDraftInput) =>
				this.call<ConsumeDraftResult>("consumeDraft", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const row = this.row(input);
					if (row === undefined) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
					if (row.state !== "sending" || row.claim?.token !== input.token)
						return { outcome: "not-claimed", row, thread: this.threadOf(row) };
					return { outcome: "consumed", revision: this.consumeRow(row).revision };
				}),
			releaseClaim: (input: ReleaseClaimInput) =>
				this.call<ReleaseClaimResult>("releaseClaim", page(), input, () => {
					const refused = this.gate(page(), input.orgId);
					if (refused) return refused;
					const row = this.row(input);
					if (row === undefined) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
					if (row.state !== "sending" || row.claim?.token !== input.token)
						return { outcome: "not-claimed", row, thread: this.threadOf(row) };
					// S4's redirect: a later turn already in the transcript (id AND text) is consumed.
					if (input.freshTurnId === undefined && row.claim.kind === "later" && this.threadOf(row).hasTurn)
						return { outcome: "consumed", revision: this.consumeRow(row).revision };
					const next = this.releaseRow(row, input.error, input.uncertain ?? false, input.freshTurnId ?? null);
					return { outcome: "released", row: next };
				}),
			startConversation: (input: StartConversationInput) =>
				this.call<StartConversationResult>("startConversation", page(), input, () => this.start(page(), input)),
		};
	}

	/** §5.1: one transaction that stores the first turn under the conversation id. */
	private start(page: string, input: StartConversationInput): StartConversationResult {
		const refused = this.gate(page, input.orgId);
		if (refused) return refused;
		const found = this.row(input);
		const composer = input.origin === "composer";
		const live = composer && found?.claim?.token === input.token;
		const row = found === undefined || live ? found : this.settle(found);
		let turn: { text: string; mentions: DraftContent["mentions"]; cellTarget: DraftContent["cellTarget"] };
		if (input.origin === "composer") {
			if (
				row === undefined ||
				row.state !== "sending" ||
				row.claim?.token !== input.token ||
				row.claim.kind !== "first" ||
				row.claim.turnId !== input.turnId
			) {
				if (row === undefined) return { outcome: "gone", thread: this.thread(input.conversationId, null, "") };
				return { outcome: "not-claimed", row, thread: this.threadOf(row) };
			}
			turn = { text: row.content.text, mentions: row.content.mentions, cellTarget: row.content.cellTarget };
		} else {
			if (row?.state === "sending") return { outcome: "claimed", row, thread: this.threadOf(row) };
			if (row !== undefined && (row.state !== "active" || row.revision !== input.revision))
				return { outcome: "draft-conflict", row, thread: this.threadOf(row) };
			turn = { text: input.text, mentions: input.mentions, cellTarget: input.cellTarget ?? null };
		}
		const existing = this.threads.get(input.conversationId);
		if (existing !== undefined) {
			const outcome = existing.deleted
				? "deleted"
				: existing.messages[0]?.id === input.turnId
					? "already-stored"
					: "conflict";
			let revision = row?.revision ?? 0;
			if (row !== undefined && composer) {
				const settled = outcome === "already-stored" ? this.consumeRow(row) : this.releaseRow(row, outcome, false, null);
				revision = settled.revision;
			}
			return { outcome, revision };
		}
		const lead = turn.text.length - turn.text.trimStart().length;
		const text = turn.text.trim();
		const mentions = turn.mentions
			.map((m) => ({ ...m, start: m.start - lead, end: m.end - lead }))
			.filter((m) => m.start >= 0 && m.end <= text.length);
		this.threads.set(input.conversationId, {
			id: input.conversationId,
			projectId: input.projectId,
			title: text.slice(0, 60),
			messages: [
				{
					id: input.turnId,
					role: "user",
					parts: [{ type: "text", text }],
					metadata: { mentions, cellTarget: turn.cellTarget },
				},
			],
			revision: 1,
			deleted: false,
		});
		let revision: number;
		if (composer && row !== undefined) revision = this.consumeRow(row).revision;
		else if (row !== undefined) revision = this.write(row, { failedSend: null, threadSeen: true }).revision;
		else {
			const inserted: ServerDraft = {
				orgId: input.orgId,
				projectId: input.projectId,
				conversationId: input.conversationId,
				revision: 1,
				state: "active",
				content: { ...EMPTY },
				claim: null,
				failedSend: null,
				lastSent: null,
				threadSeen: true,
				title: null,
				lastWriter: null,
				discardedAt: null,
				updatedAt: new Date().toISOString(),
			};
			this.rows.set(rowId(inserted), inserted);
			revision = 1;
		}
		return { outcome: "created", revision, threadRevision: 1 };
	}

	// ── The threads (`app/server/actions/agent.ts`) ─────────────────────────────────────────────

	/** The live threads of an anchor that hold messages, newest first. */
	listThreads(projectId?: string): LoadedThread[] {
		return [...this.threads.values()]
			.filter((t) => !t.deleted && t.messages.length > 0 && t.projectId === (projectId ?? null))
			.reverse()
			.map((t) => this.loaded(t));
	}

	/** One thread as `getThread` returns it, or null for a missing row or a tombstone. */
	getThread(id: string): LoadedThread | null {
		const t = this.threads.get(id);
		return t === undefined || t.deleted ? null : this.loaded(t);
	}

	/** `deleteThread`: the tombstone, and the purge of the caller's drafts of it in every org (§6.3). */
	deleteThread(id: string): void {
		const t = this.threads.get(id);
		if (t !== undefined) this.threads.set(id, { ...t, deleted: true, messages: [] });
		for (const [k, r] of this.rows) if (r.conversationId === id) this.rows.delete(k);
	}

	/** A thread in `getThread`'s shape. */
	private loaded(t: FakeThread): LoadedThread {
		const row = {
			id: t.id,
			title: t.title,
			messages: t.messages,
			revision: t.revision,
			project_id: t.projectId,
			inFlight: null,
		};
		return row as unknown as LoadedThread;
	}

	// ── The chat routes and the heartbeat route (`fetch`) ───────────────────────────────────────

	/** The stubbed `fetch`: the chat routes and the heartbeat route. */
	fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
		if (url.includes("/api/elench/drafts/heartbeat")) return this.heartbeat(body);
		return this.chat(body, init?.signal ?? null);
	};

	/** S7: renews a live claim's lease; never settles anything. */
	private heartbeat(body: unknown): Response {
		const b = body as { orgId: string; conversationId: string; token: string };
		const row = [...this.rows.values()].find((r) => r.orgId === b.orgId && r.conversationId === b.conversationId);
		let result: TouchClaimResult;
		if (row === undefined) result = { outcome: "gone", thread: this.thread(b.conversationId, null, "") };
		else if (row.state === "sending" && row.claim?.token === b.token) {
			this.rows.set(rowId(row), { ...row, claim: { ...row.claim, claimedAt: new Date().toISOString() } });
			result = { outcome: "touched" };
		} else result = { outcome: "not-claimed", row, thread: this.threadOf(row) };
		return Response.json(result);
	}

	/** A chat request: answered as planned, and stored the way ADR 0003's routes store a turn. */
	private chat(body: unknown, signal: AbortSignal | null): Promise<Response> {
		const b = body as {
			threadId?: string | null;
			messages: UIMessage[];
			mentions?: unknown;
			cellTarget?: unknown;
			turn?: { turnId: string };
		};
		this.requests.push({
			threadId: b.threadId ?? null,
			messages: b.messages,
			mentions: b.mentions,
			cellTarget: b.cellTarget,
			turnId: b.turn?.turnId ?? null,
		});
		const answer = this.route.shift() ?? { kind: "answer", text: "OK" };
		if (answer.kind === "refuse") return Promise.resolve(Response.json(answer.refusal, { status: answer.status }));
		if (answer.kind === "status") return Promise.resolve(new Response(answer.body, { status: answer.status }));
		if (answer.kind === "hang")
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const thread = b.threadId ? this.threads.get(b.threadId) : undefined;
		const last = b.messages.findLast((m) => m.role === "user");
		const replyId = `reply-${this.requests.length}`;
		if (thread !== undefined && last !== undefined) {
			const own = typeof last.metadata === "object" && last.metadata !== null ? last.metadata : {};
			const meta: Record<string, unknown> = {};
			if ("mentions" in own && Array.isArray(own.mentions) && own.mentions.length > 0) meta.mentions = own.mentions;
			if ("cellTarget" in own && own.cellTarget) meta.cellTarget = own.cellTarget;
			const stored = thread.messages.some((m) => m.id === last.id);
			const turn: UIMessage = { id: last.id, role: "user", parts: last.parts, ...(Object.keys(meta).length ? { metadata: meta } : {}) };
			thread.messages = [
				...thread.messages,
				...(stored ? [] : [turn]),
				{ id: replyId, role: "assistant", parts: [{ type: "text", text: answer.text }] },
			];
			thread.revision += 1;
		}
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: replyId },
			{ type: "start-step" },
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: answer.text },
			{ type: "text-end", id: "t" },
			{ type: "finish-step" },
			{ type: "finish" },
		];
		return Promise.resolve(
			createUIMessageStreamResponse({
				stream: createUIMessageStream({
					execute: ({ writer }) => {
						for (const c of chunks) writer.write(c);
					},
				}),
			}),
		);
	}
}
