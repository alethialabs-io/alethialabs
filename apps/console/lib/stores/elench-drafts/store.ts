// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench drafts store (ADR 0001 §7): the pure reducer (reducer.ts) plus the effects layer that
// runs what it asks for and feeds every answer back as an event. Nothing renders it yet: slice 9's
// drafts root will create one store per tab, bind the server actions as its transport, and call
// `load`, `connect`, `setSurfaceOpen` and `dispatch`; the composer and conversation will execute
// the UI effects it hands to `ui`.
//
// What runs here:
// - every draft write through the per-key queue (queue.ts), with its client timeout and the D29
//   page-org hold, answered as the reducer's `*_RESULT` / `*_FAILED` events;
// - the save debounce and D27's backoff (`schedule-save`), and the delays of a consume or release
//   retry, as timers;
// - the `sessionStorage` cache (cache.ts): written after 300 ms of quiet and synchronously on
//   `pagehide`, removed when the reducer says the words are acknowledged (I4);
// - the heartbeat of every granted claim (heartbeat.ts, D34), derived from the state after each
//   dispatch, so a claim that is only `claiming` never has one;
// - `listDrafts` at LOAD (with the restored cache items, D26), on a scope change, on window focus,
//   and every 60 s while the surface is open (every 10 s while a row is being sent from another tab
//   or device, D30).
// Draft text is never logged here: nothing in this file logs at all.

import { createStore, type StoreApi } from "zustand/vanilla";
import type {
	ClaimDraftInput,
	ConsumeDraftInput,
	DraftCasInput,
	ListDraftsInput,
	ReleaseClaimInput,
	SaveDraftInput,
	StartConversationInput,
} from "@/app/server/actions/elench-drafts";
import type {
	ClaimDraftResult,
	ConsumeDraftResult,
	DiscardDraftResult,
	ListDraftsResult,
	ReleaseClaimResult,
	RestoreDraftResult,
	SaveDraftResult,
	StartConversationResult,
} from "@/lib/elench/draft-outcomes";
import { cacheable, DraftCache } from "@/lib/stores/elench-drafts/cache";
import { ClaimHeartbeats, type HeartbeatSend } from "@/lib/stores/elench-drafts/heartbeat";
import {
	DraftWriteQueue,
	type QueuedWrite,
	START_TIMEOUT_MS,
	WRITE_TIMEOUT_MS,
} from "@/lib/stores/elench-drafts/queue";
import {
	type DraftsStore,
	type DraftsStoreEvent,
	initialDraftsStore,
	reduce,
} from "@/lib/stores/elench-drafts/reducer";
import { keyId, scopeId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { CachedDraft, SendEffect } from "@/lib/stores/elench-drafts/reducer-sending";
import type { DraftEntry, DraftKey, DraftScope } from "@/lib/stores/elench-drafts/types";

/** The server side of the store: the draft actions (§4.2). Injected, so tests need no network. */
export interface DraftsTransport {
	listDrafts(input: ListDraftsInput): Promise<ListDraftsResult>;
	saveDraft(input: SaveDraftInput): Promise<SaveDraftResult>;
	restoreDraft(input: DraftCasInput): Promise<RestoreDraftResult>;
	discardDraft(input: DraftCasInput): Promise<DiscardDraftResult>;
	claimDraft(input: ClaimDraftInput): Promise<ClaimDraftResult>;
	consumeDraft(input: ConsumeDraftInput): Promise<ConsumeDraftResult>;
	releaseClaim(input: ReleaseClaimInput): Promise<ReleaseClaimResult>;
	startConversation(input: StartConversationInput): Promise<StartConversationResult>;
}

/** The effects the conversation executes (from slice 9): they touch `useChat`, not the server. */
export type DraftUiEffect = Extract<
	SendEffect,
	{
		type:
			| "send-message"
			| "remove-optimistic"
			| "load-transcript"
			| "thread-revision"
			| "place-artifacts"
			| "poll-thread"
			| "offer-undo-discard";
	}
>;

/** A notice waiting to be shown (§7.4); slice 11 will render them and acknowledge them by id. */
export interface DraftNoticeItem {
	id: number;
	key: DraftKey;
	notice: Extract<SendEffect, { type: "notice" }>["notice"];
}

/** What the store publishes to its selectors. */
export interface DraftsView {
	drafts: DraftsStore;
	/** `keyId` → true when this tab's cache refused the key's last write ("this tab can't keep it either"). */
	uncached: Record<string, true>;
	notices: DraftNoticeItem[];
}

/** What a store is built from. Every clock is the global timer, so tests run it on fake timers. */
export interface DraftsStoreDeps {
	viewerId: string | null;
	transport: DraftsTransport;
	heartbeat: HeartbeatSend;
	/** `() => window.sessionStorage`; it may throw, and the store then runs without a cache. */
	storage: () => Storage | null;
	/** This page load's tab id (§7.1: minted per load, kept in memory only). */
	tabId: string;
	/** A fresh random id (`crypto.randomUUID`). */
	mint: () => string;
	ui?: (effect: DraftUiEffect) => void;
}

/** The store's handle. */
export interface DraftsStoreHandle {
	view: StoreApi<DraftsView>;
	dispatch(event: DraftsStoreEvent): void;
	/** D26: LOAD of `scope`, which restores this tab's cache items into the scope's first list. */
	load(scope: DraftScope): void;
	/** Whether the surface shows its active conversation: D12's `mounted`, and the 60 s poll. */
	setSurfaceOpen(open: boolean): void;
	/** Listens for `focus`, `online`, `visibilitychange` and `pagehide`; returns the unsubscribe. */
	connect(win: Window, doc: Document): () => void;
	ackNotices(ids: readonly number[]): void;
	/** The active conversation this tab last showed in `scope` (§7.3), for slice 10's resume. */
	readActive(scope: DraftScope): string | null;
	dispose(): void;
}

/** The cache is written after this much quiet (§7.5). */
export const CACHE_DEBOUNCE_MS = 300;

/** `listDrafts` runs this often while the surface is open (§6.4). */
export const LIST_POLL_MS = 60_000;

/** …and this often while a row of the scope is being sent from another tab or device (D30). */
export const CLAIMED_POLL_MS = 10_000;

/** Creates one tab's drafts store. */
export function createDraftsStore(deps: DraftsStoreDeps): DraftsStoreHandle {
	const view = createStore<DraftsView>(() => ({
		drafts: initialDraftsStore(deps.viewerId),
		uncached: {},
		notices: [],
	}));
	const cache = new DraftCache(deps.storage);
	let seq = 0;
	const nextSeq = (): number => ++seq;
	const queue = new DraftWriteQueue(nextSeq, () => view.getState().drafts.pageOrg);
	const heartbeats = new ClaimHeartbeats(deps.heartbeat, (claim, result) =>
		dispatch({ type: "ENTRY", key: claim.key, event: { type: "HEARTBEAT_RESULT", token: claim.token, result } }),
	);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const cacheTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const cached = new Map<string, DraftEntry>();
	const pendingRestore = new Map<string, CachedDraft[]>();
	let lastListedOrg: string | null = null;
	let surfaceOpen = false;
	let poll: { ms: number; timer: ReturnType<typeof setInterval> } | null = null;
	let noticeId = 0;

	/** Arms the timer `name`, replacing one of the same name; with no delay, runs at once. */
	const arm = (name: string, ms: number, run: () => void): void => {
		const old = timers.get(name);
		if (old !== undefined) clearTimeout(old);
		timers.delete(name);
		if (ms <= 0) return run();
		timers.set(
			name,
			setTimeout(() => {
				timers.delete(name);
				run();
			}, ms),
		);
	};

	/** Queues one write of `key` with its timeout. */
	const write = <T>(key: DraftKey, w: Omit<QueuedWrite<T>, "orgId" | "timeoutMs">, timeoutMs = WRITE_TIMEOUT_MS): void =>
		queue.enqueue(keyId(key), { ...w, orgId: key.orgId, timeoutMs });

	/** Dispatches a per-key event. */
	const entry = (key: DraftKey, event: Extract<DraftsStoreEvent, { type: "ENTRY" }>["event"]): void =>
		dispatch({ type: "ENTRY", key, event });

	/** `listDrafts` for `scope` at `generation`; its answer is D22 (with D26's restored items). */
	const list = (scope: DraftScope, generation: number): void => {
		const at = nextSeq();
		const input: ListDraftsInput =
			lastListedOrg === null ? { projectId: scope.projectId } : { projectId: scope.projectId, orgHint: lastListedOrg };
		deps.transport.listDrafts(input).then(
			(result) => {
				// §7.4: a list that fails changes nothing.
				if (result.outcome !== "ok") return;
				const now = view.getState().drafts;
				if (now.generation !== generation) return; // D23: a late answer for an older scope
				lastListedOrg = result.orgId;
				const sid = scopeId(scope);
				const restored = pendingRestore.get(sid) ?? [];
				pendingRestore.delete(sid);
				dispatch({ type: "SERVER_ROWS", seq: at, generation, result, restored });
			},
			() => undefined,
		);
	};

	/** Runs one effect the reducer asked for. */
	const run = (e: SendEffect): void => {
		const viewer = view.getState().drafts.viewerId;
		switch (e.type) {
			case "save":
			case "dismiss-failed-send":
				return write(e.key, {
					send: () =>
						deps.transport.saveDraft({
							...e.key,
							baseRevision: e.base,
							content: e.content,
							tabId: deps.tabId,
							...(e.type === "save"
								? e.failedSend === null
									? {}
									: { failedSend: e.failedSend }
								: { dismissFailedSend: true }),
						}),
					answer: (s, result) => entry(e.key, { type: "SAVE_RESULT", seq: s, result }),
					// D32: an abandoned save is retried at the same base, as a transient failure (D27).
					fail: (s, f) =>
						entry(e.key, { type: "WRITE_REJECTED", seq: s, rejection: { network: f.kind === "timeout" || f.network } }),
				});
			case "restore":
				return write(e.key, {
					send: () => deps.transport.restoreDraft({ ...e.key, baseRevision: e.base }),
					answer: (s, result) => entry(e.key, { type: "RESTORE_RESULT", seq: s, result }),
					fail: (s, f) =>
						entry(e.key, { type: "WRITE_REJECTED", seq: s, rejection: { network: f.kind === "timeout" || f.network } }),
				});
			case "discard":
				return write(e.key, {
					send: () => deps.transport.discardDraft({ ...e.key, baseRevision: e.base }),
					answer: (s, result) => entry(e.key, { type: "DISCARD_RESULT", base: e.base, seq: s, result }),
					fail: () => entry(e.key, { type: "DISCARD_FAILED" }),
				});
			case "claim":
				return write(e.key, {
					send: () =>
						deps.transport.claimDraft({
							...e.key,
							baseRevision: e.base,
							content: e.content,
							turnId: e.turnId,
							token: e.token,
							kind: e.kind,
							tabId: deps.tabId,
						}),
					answer: (s, result) => entry(e.key, { type: "CLAIM_RESULT", attempt: e.attempt, seq: s, result }),
					fail: (s, failure) => entry(e.key, { type: "CLAIM_FAILED", attempt: e.attempt, seq: s, failure }),
				});
			case "start": {
				// An empty title: the server titles the thread from the turn it stores (§5.1).
				const base = { ...e.key, turnId: e.turnId, title: "" };
				let input: StartConversationInput;
				if (e.token !== null) input = { ...base, origin: "composer", token: e.token, revision: e.revision };
				else if (e.prompt !== null)
					input = {
						...base,
						origin: "external",
						revision: e.revision,
						text: e.prompt.text,
						mentions: e.prompt.mentions,
						cellTarget: e.prompt.cellTarget,
					};
				else return;
				return write(
					e.key,
					{
						send: () => deps.transport.startConversation(input),
						answer: (s, result) => entry(e.key, { type: "START_RESULT", attempt: e.attempt, seq: s, result }),
						fail: (s, failure) => entry(e.key, { type: "START_FAILED", attempt: e.attempt, seq: s, failure }),
					},
					START_TIMEOUT_MS,
				);
			}
			case "consume":
				return arm(`consume:${e.token}`, e.delayMs, () =>
					write(e.key, {
						send: () => deps.transport.consumeDraft({ ...e.key, token: e.token }),
						answer: (s, result) =>
							entry(e.key, { type: "CONSUME_RESULT", token: e.token, seq: s, retry: e.retry, result }),
						fail: (s, failure) =>
							entry(e.key, { type: "CONSUME_FAILED", token: e.token, seq: s, retry: e.retry, failure }),
					}),
				);
			case "release":
				return arm(`release:${e.token}`, e.delayMs, () =>
					write(e.key, {
						send: () =>
							deps.transport.releaseClaim({
								...e.key,
								token: e.token,
								error: e.error,
								uncertain: e.uncertain,
								...(e.freshTurnId === null ? {} : { freshTurnId: e.freshTurnId }),
							}),
						answer: (s, result) =>
							entry(e.key, { type: "RELEASE_RESULT", token: e.token, seq: s, retry: e.retry, result }),
						fail: (s, failure) =>
							entry(e.key, { type: "RELEASE_FAILED", token: e.token, seq: s, retry: e.retry, failure }),
					}),
				);
			case "schedule-save":
				// One timer per key and reason: a new debounce replaces the old one, and never a backoff.
				return arm(`save:${e.reason}:${keyId(e.key)}`, e.delayMs, () =>
					entry(e.key, { type: "SAVE_TRIGGER", reason: e.reason }),
				);
			case "list":
				return list(e.scope, e.generation);
			case "cache-remove": {
				const id = keyId(e.key);
				const t = cacheTimers.get(id);
				if (t !== undefined) clearTimeout(t);
				cacheTimers.delete(id);
				cached.delete(id);
				if (viewer !== null) cache.remove(viewer, e.key);
				return;
			}
			case "cache-clear":
				// D25: the viewer changed. Nothing of the old viewer is sent, kept or renewed.
				cache.clearAll();
				queue.clear();
				for (const t of [...timers.values(), ...cacheTimers.values()]) clearTimeout(t);
				timers.clear();
				cacheTimers.clear();
				cached.clear();
				pendingRestore.clear();
				heartbeats.stopAll();
				view.setState({ uncached: {}, notices: [] });
				return;
			case "notice":
				view.setState((s) => ({ notices: [...s.notices, { id: ++noticeId, key: e.key, notice: e.notice }] }));
				return;
			default:
				deps.ui?.(e);
		}
	};

	/** Writes one key's cache item now, and records whether the cache kept it. */
	const writeCache = (id: string): void => {
		cacheTimers.delete(id);
		const s = view.getState();
		const e = s.drafts.entries[id];
		const viewer = s.drafts.viewerId;
		if (e === undefined || viewer === null || !cacheable(e)) return;
		const kept = cache.write(viewer, e);
		if (kept === (s.uncached[id] === undefined)) return;
		const uncached = { ...s.uncached };
		if (kept) delete uncached[id];
		else uncached[id] = true;
		view.setState({ uncached });
	};

	/** After a dispatch: the cache items, the active-key mirror, the heartbeats, the poll and the queue. */
	const sync = (before: DraftsStore): void => {
		const now = view.getState().drafts;
		for (const [id, e] of Object.entries(now.entries)) {
			if (!cacheable(e) || cached.get(id) === e) continue;
			cached.set(id, e);
			const t = cacheTimers.get(id);
			if (t !== undefined) clearTimeout(t);
			cacheTimers.set(id, setTimeout(() => writeCache(id), CACHE_DEBOUNCE_MS));
		}
		if (now.viewerId !== null && now.activeKey !== before.activeKey) cache.writeActive(now.viewerId, now.activeKey);
		heartbeats.sync(
			Object.values(now.entries).flatMap((e) =>
				e.sending !== null && e.sending.token !== null ? [{ key: e.key, token: e.sending.token }] : [],
			),
		);
		const scope = now.scope;
		const claimedElsewhere =
			scope !== null &&
			Object.values(now.entries).some(
				(e) => e.conflict?.kind === "claimed" && scopeId(e.key) === scopeId(scope),
			);
		const ms = surfaceOpen && scope !== null ? (claimedElsewhere ? CLAIMED_POLL_MS : LIST_POLL_MS) : null;
		if ((poll?.ms ?? null) !== ms) {
			if (poll !== null) clearInterval(poll.timer);
			poll = ms === null ? null : { ms, timer: setInterval(listCurrent, ms) };
		}
		queue.pumpAll(); // D29: a held write goes once the page shows its org
	};

	/** `listDrafts` for the scope on screen (focus, the poll). */
	function listCurrent(): void {
		const s = view.getState().drafts;
		if (s.scope !== null) list(s.scope, s.generation);
	}

	/** Reduces one event, publishes the state and runs its effects. */
	function dispatch(event: DraftsStoreEvent): void {
		const before = view.getState().drafts;
		const t = reduce(before, event, {
			tabId: deps.tabId,
			now: new Date().toISOString(),
			fresh: { attempt: deps.mint(), token: deps.mint(), turnId: deps.mint(), conversationId: deps.mint() },
			mounted: surfaceOpen,
		});
		view.setState({ drafts: t.state });
		for (const e of t.effects) run(e);
		sync(before);
	}

	/** Flushes every pending cache write synchronously (`pagehide`, §7.5). */
	const flushCache = (): void => {
		for (const [id, t] of [...cacheTimers]) {
			clearTimeout(t);
			writeCache(id);
		}
	};

	return {
		view,
		dispatch,
		load(scope) {
			const viewer = view.getState().drafts.viewerId;
			if (viewer !== null) {
				cache.purgeForLoad(viewer);
				pendingRestore.set(scopeId(scope), cache.readScope(viewer, scope));
			}
			dispatch({ type: "SCOPE_CHANGE", scope });
		},
		setSurfaceOpen(open) {
			surfaceOpen = open;
			sync(view.getState().drafts);
		},
		connect(win, doc) {
			const onFocus = (): void => listCurrent();
			const onOnline = (): void => {
				for (const e of Object.values(view.getState().drafts.entries))
					if (e.save === "retrying") entry(e.key, { type: "SAVE_TRIGGER", reason: "online" });
			};
			const onVisibility = (): void => {
				if (doc.visibilityState === "visible") return heartbeats.beatAll();
				for (const e of Object.values(view.getState().drafts.entries))
					if (e.local !== null) entry(e.key, { type: "SAVE_TRIGGER", reason: "hidden" });
				flushCache();
			};
			win.addEventListener("focus", onFocus);
			win.addEventListener("online", onOnline);
			win.addEventListener("pagehide", flushCache);
			doc.addEventListener("visibilitychange", onVisibility);
			return () => {
				win.removeEventListener("focus", onFocus);
				win.removeEventListener("online", onOnline);
				win.removeEventListener("pagehide", flushCache);
				doc.removeEventListener("visibilitychange", onVisibility);
			};
		},
		ackNotices(ids) {
			const drop = new Set(ids);
			view.setState((s) => ({ notices: s.notices.filter((n) => !drop.has(n.id)) }));
		},
		readActive(scope) {
			const viewer = view.getState().drafts.viewerId;
			return viewer === null ? null : cache.readActive(viewer, scope);
		},
		dispose() {
			heartbeats.stopAll();
			queue.clear();
			for (const t of [...timers.values(), ...cacheTimers.values()]) clearTimeout(t);
			if (poll !== null) clearInterval(poll.timer);
			poll = null;
		},
	};
}
