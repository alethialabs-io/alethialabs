// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench drafts reducer (ADR 0001 §7.2): the drafting half (reducer-drafting.ts) and the sending
// half (reducer-sending.ts) composed into one pure `reduce(state, event, env)`. Every event of either
// half reaches it; a key's own events touch that key alone, except D18's FORK, which moves a send's
// words into a new key of the same scope, and D22's list, which reads every key of its scope.
//
// The store adds two maps to the drafting state, both keyed by `keyId`: D18's pending forks (the new
// key's save must be acknowledged before the old row is discarded, so the words always live in one
// row) and D10f's fences.
//
// No caller yet: the effects layer will be slice 8's.

import type { DraftListOk } from "@/lib/elench/draft-outcomes";
import {
	contentEquals,
	type DraftsEnv,
	initialDraftsState,
	keyId,
	newEntry,
	reduceDrafts,
	scopeId,
	shownContent,
} from "@/lib/stores/elench-drafts/reducer-drafting";
import {
	afterDrafting,
	type CachedDraft,
	type DraftFence,
	type DraftFork,
	type DraftSendEvent,
	type FreshIds,
	interceptDraftingEvent,
	isSendEvent,
	reduceDraftingEvent,
	reduceSendEntry,
	restoreFromCache,
	type SendContext,
	type SendEffect,
	type SendEntryTransition,
} from "@/lib/stores/elench-drafts/reducer-sending";
import type {
	DraftEntry,
	DraftEntryEvent,
	DraftKey,
	DraftScope,
	DraftsEvent,
	DraftsState,
} from "@/lib/stores/elench-drafts/types";

/** The store: the drafting state plus D18's pending forks and D10f's fences. */
export interface DraftsStore extends DraftsState {
	/** `keyId(k'')` → the key it was forked from and the revision to discard once k'' is saved (D18). */
	forks: Record<string, { from: DraftKey; revision: number }>;
	/** `keyId(k)` → the external send whose failed prompt a save put into k's box (D10f). */
	fences: Record<string, DraftFence>;
}

/** The facts each dispatch needs from the caller: the tab, the time, fresh ids and the surface. */
export interface DraftsStoreEnv extends DraftsEnv {
	fresh: FreshIds;
	/** Whether the Elench surface is showing its active conversation (D12, D22). */
	mounted: boolean;
}

/** Every event of the store. */
export type DraftsStoreEvent =
	| Exclude<DraftsEvent, { type: "ENTRY" }>
	| { type: "ENTRY"; key: DraftKey; event: DraftEntryEvent | DraftSendEvent }
	/**
	 * D22 / D26: a `listDrafts` answer requested at `seq` for scope generation `generation`, with the
	 * cache items `LOAD` restored for that scope (empty on any other list).
	 */
	| { type: "SERVER_ROWS"; seq: number; generation: number; result: DraftListOk; restored: CachedDraft[] };

/** One store reduction. */
export interface DraftsStoreTransition {
	state: DraftsStore;
	effects: SendEffect[];
}

/** The empty store of a viewer. */
export function initialDraftsStore(viewerId: string | null): DraftsStore {
	return { ...initialDraftsState(viewerId), forks: {}, fences: {} };
}

/** True while I4 lets this key keep a `sessionStorage` item: something is unacknowledged. */
function holdsCache(entry: DraftEntry | null): boolean {
	return (
		entry !== null &&
		(entry.local !== null ||
			entry.claiming !== null ||
			entry.sending !== null ||
			entry.pendingFailedSend !== null)
	);
}

/** True when two scopes are the same org and the same anchor. */
function sameScope(a: DraftScope, b: DraftScope): boolean {
	return a.orgId === b.orgId && a.projectId === b.projectId;
}

/** The context a key's own reduction gets from the store. */
function contextFor(state: DraftsStore, key: DraftKey, env: DraftsStoreEnv): SendContext {
	return {
		pageOrg: state.pageOrg,
		tabId: env.tabId,
		active: state.activeKey[scopeId(key)] === key.conversationId,
		now: env.now,
		fresh: env.fresh,
		mounted: env.mounted,
		fence: state.fences[keyId(key)] ?? null,
	};
}

/**
 * One key's event through both halves: the sending half's own events, the drafting answers it
 * reads (D18, D30, D33, D10f), and everything else through the drafting half. The cache rule (I4) is
 * applied once, to the whole reduction.
 */
export function reduceEntry(
	entry: DraftEntry,
	event: DraftEntryEvent | DraftSendEvent,
	ctx: SendContext,
): SendEntryTransition {
	let t: SendEntryTransition;
	if (isSendEvent(event)) t = reduceSendEntry(entry, event, ctx);
	else t = afterDrafting(entry, interceptDraftingEvent(entry, event, ctx) ?? reduceDraftingEvent(entry, event, ctx));
	// I6: a box that changes for any reason but the user's own EDIT was replaced from outside, so the
	// editor must reseed. Each transition bumps the epoch itself; this makes it structural.
	const after = t.entry;
	if (
		event.type !== "EDIT" &&
		after !== null &&
		after.epoch === entry.epoch &&
		!contentEquals(shownContent(entry), shownContent(after))
	)
		t = { ...t, entry: { ...after, epoch: entry.epoch + 1 } };
	const effects: SendEffect[] = t.effects.filter((x) => x.type !== "cache-remove");
	const kept = t.fork === undefined ? t.entry : null;
	if (holdsCache(entry) && !holdsCache(kept)) effects.push({ type: "cache-remove", key: entry.key });
	return { ...t, effects };
}

/** Puts one entry back into the store (or removes it), with its fence update. */
function putEntry(
	state: DraftsStore,
	key: DraftKey,
	entry: DraftEntry | null,
	fence: DraftFence | null | undefined,
): DraftsStore {
	const id = keyId(key);
	const entries = { ...state.entries };
	if (entry === null) delete entries[id];
	else entries[id] = entry;
	let fences = state.fences;
	if (fence !== undefined || entry === null) {
		fences = { ...fences };
		if (fence === null || fence === undefined) delete fences[id];
		else fences[id] = fence;
	}
	return { ...state, entries, fences };
}

/**
 * D18: FORK. Mints `k''` in the same scope from `env.fresh.conversationId`, carries the words there
 * and saves them at base 0; once that save is acknowledged the old row is discarded (`forks`). The
 * old key's entry is removed, and `activeKey` moves only if it was that key. An id this tab already
 * holds is not fresh: then the words stay in the old key's box, which `fallback` already holds.
 */
function applyFork(
	state: DraftsStore,
	from: DraftKey,
	fork: DraftFork,
	fallback: DraftEntry | null,
	env: DraftsStoreEnv,
): DraftsStoreTransition {
	const to: DraftKey = {
		orgId: from.orgId,
		projectId: from.projectId,
		conversationId: env.fresh.conversationId,
	};
	if (state.entries[keyId(to)] !== undefined || to.conversationId === from.conversationId)
		return { state: putEntry(state, from, fallback, null), effects: [] };
	let next = putEntry(state, from, null, null);
	const sid = scopeId(from);
	if (next.activeKey[sid] === from.conversationId)
		next = { ...next, activeKey: { ...next.activeKey, [sid]: to.conversationId } };
	if (fork.discard !== null)
		next = { ...next, forks: { ...next.forks, [keyId(to)]: { from, revision: fork.discard } } };
	const seeded: DraftEntry = { ...newEntry(to, "none"), local: fork.content };
	next = putEntry(next, to, seeded, undefined);
	const t = reduceEntry(seeded, { type: "SAVE_TRIGGER", reason: "before-submit" }, contextFor(next, to, env));
	next = putEntry(next, to, t.entry, t.fence);
	return {
		state: next,
		effects: [...t.effects, { type: "notice", key: to, notice: fork.notice }],
	};
}

/** Writes one key's transition back: the entry, its fence, a fork, and the active key (D16, D18). */
function commit(
	state: DraftsStore,
	key: DraftKey,
	t: SendEntryTransition,
	env: DraftsStoreEnv,
): DraftsStoreTransition {
	if (t.fork !== undefined) {
		const f = applyFork(state, key, t.fork, t.entry, env);
		// A fork that could not mint a fresh key leaves the words in this key's box: keep its cache item.
		const kept = f.state.entries[keyId(key)] !== undefined;
		const own = kept ? t.effects.filter((x) => x.type !== "cache-remove") : t.effects;
		return { state: f.state, effects: [...own, ...f.effects] };
	}
	const next = putEntry(state, key, t.entry, t.fence);
	const sid = scopeId(key);
	if (t.entry !== null || next.activeKey[sid] !== key.conversationId)
		return { state: next, effects: t.effects };
	// The active key's entry was removed: the scope has no active key, so the next New chat mints one.
	const activeKey = { ...next.activeKey };
	delete activeKey[sid];
	return { state: { ...next, activeKey }, effects: t.effects };
}

/** Runs one key's event and writes back that key alone (or its fork). */
function applyToEntry(
	state: DraftsStore,
	key: DraftKey,
	event: DraftEntryEvent | DraftSendEvent,
	env: DraftsStoreEnv,
): DraftsStoreTransition {
	const id = keyId(key);
	const entry = state.entries[id];
	if (entry === undefined) return { state, effects: [] };
	const t = reduceEntry(entry, event, contextFor(state, entry.key, env));
	const out = commit(state, entry.key, t, env);
	// D18: the forked words are acknowledged under k'', so the old row is discarded (soft, 24 h).
	const pending = state.forks[id];
	if (
		pending === undefined ||
		event.type !== "SAVE_RESULT" ||
		event.result.outcome !== "saved" ||
		entry.inflight === null
	)
		return out;
	const forks = { ...out.state.forks };
	delete forks[id];
	return {
		state: { ...out.state, forks },
		effects: [...out.effects, { type: "discard", key: pending.from, base: pending.revision }],
	};
}

/** D22 / D26: a `listDrafts` answer for the current scope generation. */
function serverRows(
	state: DraftsStore,
	event: Extract<DraftsStoreEvent, { type: "SERVER_ROWS" }>,
	env: DraftsStoreEnv,
): DraftsStoreTransition {
	const scope = state.scope;
	if (scope === null || event.generation !== state.generation) return { state, effects: [] };
	// D29: the page's org arrives with the list of the new scope generation.
	const paged = reduce(state, { type: "PAGE_ORG", orgId: event.result.orgId }, env);
	let next = paged.state;
	const effects: SendEffect[] = [...paged.effects];
	const seen = new Set<string>();
	const restored = new Map<string, CachedDraft>();
	for (const c of event.restored) if (sameScope(c.key, scope)) restored.set(keyId(c.key), c);
	for (const item of event.result.drafts) {
		const key: DraftKey = {
			orgId: item.row.orgId,
			projectId: item.row.projectId,
			conversationId: item.row.conversationId,
		};
		if (!sameScope(key, scope)) continue; // only keys of the list's own scope are read
		const id = keyId(key);
		seen.add(id);
		const cached = restored.get(id);
		if (next.entries[id] === undefined && cached !== undefined) {
			const t = restoreFromCache(cached, item, contextFor(next, key, env));
			const out = commit(next, key, t, env);
			next = out.state;
			effects.push(...out.effects);
			continue;
		}
		if (next.entries[id] === undefined)
			next = putEntry(next, key, newEntry(key, item.thread.status), undefined);
		const out = applyToEntry(next, key, { type: "LISTED", seq: event.seq, listed: item }, env);
		next = out.state;
		effects.push(...out.effects);
	}
	for (const [id, cached] of restored) {
		if (seen.has(id) || next.entries[id] !== undefined) continue;
		const out = commit(next, cached.key, restoreFromCache(cached, null, contextFor(next, cached.key, env)), env);
		next = out.state;
		effects.push(...out.effects);
	}
	// D19L: keys of this scope the list no longer holds.
	for (const [id, entry] of Object.entries(next.entries)) {
		if (seen.has(id) || !sameScope(entry.key, scope) || restored.has(id)) continue;
		const out = applyToEntry(next, entry.key, { type: "NOT_LISTED", seq: event.seq }, env);
		next = out.state;
		effects.push(...out.effects);
	}
	return { state: next, effects };
}

/**
 * The store reduction. The drafting half's store events (D1-D4, D23, D25, D29) run through
 * `reduceDrafts`, and every key-addressed event through `reduceEntry` for that key.
 */
export function reduce(
	state: DraftsStore,
	event: DraftsStoreEvent,
	env: DraftsStoreEnv,
): DraftsStoreTransition {
	switch (event.type) {
		case "ENTRY":
			return applyToEntry(state, event.key, event.event, env);
		case "SERVER_ROWS":
			return serverRows(state, event, env);
		case "VIEWER_CHANGE": {
			const t = reduceDrafts(state, event, env);
			if (t.state === state) return { state, effects: [] };
			return { state: { ...t.state, forks: {}, fences: {} }, effects: t.effects }; // D25
		}
		case "PAGE_ORG": {
			// D29's resume runs each key's save through the composed entry reduction.
			let next: DraftsStore = { ...state, pageOrg: event.orgId };
			const effects: SendEffect[] = [];
			if (event.orgId === null) return { state: next, effects };
			for (const entry of Object.values(state.entries)) {
				if (entry.key.orgId !== event.orgId) continue;
				const reason = entry.blockedBy?.kind;
				const resumable =
					(entry.save === "held" && reason === "other-org") ||
					(entry.save === "blocked" && reason === "address");
				if (!resumable) continue;
				next = putEntry(next, entry.key, { ...entry, save: "idle", blockedBy: null }, undefined);
				const out = applyToEntry(next, entry.key, { type: "SAVE_TRIGGER", reason: "timer" }, env);
				next = out.state;
				effects.push(...out.effects);
			}
			return { state: next, effects };
		}
		default: {
			const t = reduceDrafts(state, event, env);
			return { state: { ...t.state, forks: state.forks, fences: state.fences }, effects: t.effects };
		}
	}
}
