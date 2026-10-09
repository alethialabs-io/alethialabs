// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 8: the effects layer of the Elench drafts store. The per-key queue with its client
// timeouts and abandonment (D32) and the page-org hold (D29); D27's backoff; the `sessionStorage`
// cache with its budget and the v1/v2 removal (§7.3, I4, D26); the heartbeat timer as a `fetch`
// (D34); the `listDrafts` calls; and the selectors. Every server action is a fake that answers only
// when the test says so (or never), every clock is a fake timer, and nothing touches the network.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftListEntry, ServerDraft } from "@/lib/elench/draft-outcomes";
import { CACHE_PREFIX } from "@/lib/stores/elench-drafts/cache";
import type { HeartbeatBody } from "@/lib/stores/elench-drafts/heartbeat";
import { DraftWriteQueue } from "@/lib/stores/elench-drafts/queue";
import { EMPTY_CONTENT, keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import { selectUnsent, useDraft, useUnsent } from "@/lib/stores/elench-drafts/selectors";
import {
	createDraftsStore,
	type DraftsStoreHandle,
	type DraftsTransport,
	type DraftUiEffect,
} from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftKey, DraftScope } from "@/lib/stores/elench-drafts/types";

const VIEWER = "00000000-0000-4000-8000-0000000000aa";
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const SCOPE_A: DraftScope = { orgId: ORG_A, projectId: null };
const SCOPE_B: DraftScope = { orgId: ORG_B, projectId: null };
const K: DraftKey = { ...SCOPE_A, conversationId: "00000000-0000-4000-8000-0000000000c1" };

/** One call to a fake action: its input, and the handles that answer it. */
interface Call<I, R> {
	input: I;
	resolve: (r: R) => void;
	reject: (e: unknown) => void;
}

/** A fake action that records each call and answers only when the test resolves it. */
function recorder<I, R>(): { calls: Call<I, R>[]; fn: (input: I) => Promise<R> } {
	const calls: Call<I, R>[] = [];
	return {
		calls,
		fn: (input) => new Promise<R>((resolve, reject) => calls.push({ input, resolve, reject })),
	};
}

/** A server row of key K. */
function row(text: string, revision: number, over: Partial<ServerDraft> = {}): ServerDraft {
	return {
		orgId: K.orgId,
		projectId: K.projectId,
		conversationId: K.conversationId,
		revision,
		state: "active",
		content: { ...EMPTY_CONTENT, text },
		claim: null,
		failedSend: null,
		lastSent: null,
		threadSeen: false,
		title: null,
		lastWriter: "tab-other",
		discardedAt: null,
		updatedAt: "2026-10-09T00:00:00.000Z",
		...over,
	};
}

/** A store over fake actions, a fake heartbeat and the given storage. */
function setup(storage: () => Storage | null = () => window.sessionStorage) {
	const list = recorder<Parameters<DraftsTransport["listDrafts"]>[0], Awaited<ReturnType<DraftsTransport["listDrafts"]>>>();
	const save = recorder<Parameters<DraftsTransport["saveDraft"]>[0], Awaited<ReturnType<DraftsTransport["saveDraft"]>>>();
	const claim = recorder<Parameters<DraftsTransport["claimDraft"]>[0], Awaited<ReturnType<DraftsTransport["claimDraft"]>>>();
	const consume = recorder<Parameters<DraftsTransport["consumeDraft"]>[0], Awaited<ReturnType<DraftsTransport["consumeDraft"]>>>();
	const release = recorder<Parameters<DraftsTransport["releaseClaim"]>[0], Awaited<ReturnType<DraftsTransport["releaseClaim"]>>>();
	const start = recorder<Parameters<DraftsTransport["startConversation"]>[0], Awaited<ReturnType<DraftsTransport["startConversation"]>>>();
	const never = (): Promise<never> => new Promise<never>(() => undefined);
	const transport: DraftsTransport = {
		listDrafts: list.fn,
		saveDraft: save.fn,
		restoreDraft: never,
		discardDraft: never,
		claimDraft: claim.fn,
		consumeDraft: consume.fn,
		releaseClaim: release.fn,
		startConversation: start.fn,
	};
	const beats: HeartbeatBody[] = [];
	let beatStatus = 200;
	const heartbeat = vi.fn((body: HeartbeatBody) => {
		beats.push(body);
		return Promise.resolve(new Response(JSON.stringify({ outcome: "touched" }), { status: beatStatus }));
	});
	const ui: DraftUiEffect[] = [];
	let n = 0;
	const store = createDraftsStore({
		viewerId: VIEWER,
		transport,
		heartbeat,
		storage,
		tabId: "tab-1",
		mint: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
		ui: (e) => ui.push(e),
	});
	return {
		store,
		list,
		save,
		claim,
		consume,
		release,
		start,
		beats,
		ui,
		setBeatStatus: (s: number) => {
			beatStatus = s;
		},
	};
}

type Harness = ReturnType<typeof setup>;

/** Lets every settled promise run, without moving the clock. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/** LOAD of scope A, answered with `drafts` in org A (which is also the page's org, D29). */
async function loadA(h: Harness, drafts: DraftListEntry[] = []): Promise<void> {
	h.store.load(SCOPE_A);
	h.list.calls.at(-1)?.resolve({ outcome: "ok", orgId: ORG_A, drafts });
	await flush();
}

/** K's entry, or a failure. */
function entryOf(store: DraftsStoreHandle, key: DraftKey = K): DraftEntry {
	const e = store.view.getState().drafts.entries[keyId(key)];
	if (e === undefined) throw new Error("no entry");
	return e;
}

/** Types `text` into the box of `key`. */
function type(store: DraftsStoreHandle, text: string, key: DraftKey = K): void {
	store.dispatch({
		type: "ENTRY",
		key,
		event: { type: "EDIT", epoch: entryOf(store, key).epoch, content: { text, mentions: [] } },
	});
}

/** `key` open as a new conversation (no thread yet). */
function openNew(store: DraftsStoreHandle, key: DraftKey = K): void {
	store.dispatch({ type: "SELECT", key, thread: "none" });
}

/** K open on a listed thread whose transcript is loaded, with `text` claimed for a later turn. */
async function submitLater(h: Harness, text = "deploy now"): Promise<void> {
	h.store.dispatch({ type: "SELECT", key: K, thread: "listed" });
	h.store.dispatch({ type: "ENTRY", key: K, event: { type: "TRANSCRIPT_LOADED" } });
	type(h.store, text);
	h.store.dispatch({ type: "ENTRY", key: K, event: { type: "SUBMIT", chatReady: true } });
	await flush();
}

/** Answers the pending claim `claimed-by-you`. */
async function grant(h: Harness): Promise<void> {
	const c = h.claim.calls.at(-1);
	if (c === undefined) throw new Error("no claim");
	c.resolve({ outcome: "claimed-by-you", revision: 2, content: c.input.content });
	await flush();
}

beforeEach(() => {
	vi.useFakeTimers();
	window.sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("the per-key queue (§7.1, D29, D32)", () => {
	it("holds at most one write per key on the wire, and sends the next when it settles", async () => {
		const sent: string[] = [];
		const answers: Array<() => void> = [];
		const q = new DraftWriteQueue(() => sent.length, () => ORG_A);
		for (const name of ["a", "b"])
			q.enqueue("k", {
				orgId: ORG_A,
				timeoutMs: 15_000,
				send: () => {
					sent.push(name);
					return new Promise<void>((resolve) => answers.push(resolve));
				},
				answer: () => undefined,
				fail: () => undefined,
			});
		expect(sent).toEqual(["a"]);
		answers[0]?.();
		await flush();
		expect(sent).toEqual(["a", "b"]);
	});

	it("sends nothing while the page shows another org, and sends on PAGE_ORG (D29)", async () => {
		let page: string | null = null;
		const send = vi.fn(() => Promise.resolve("ok"));
		const q = new DraftWriteQueue(() => 1, () => page);
		q.enqueue("k", { orgId: ORG_A, timeoutMs: 15_000, send, answer: () => undefined, fail: () => undefined });
		page = ORG_B;
		q.pumpAll();
		expect(send).not.toHaveBeenCalled();
		page = ORG_A;
		q.pumpAll();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("a save that never answers: after 15 s it is sent again at the same base, and the late landing is dropped (G32)", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		expect(h.save.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(entryOf(h.store).save).toBe("retrying");
		await vi.advanceTimersByTimeAsync(1_000); // D27's first backoff
		expect(h.save.calls).toHaveLength(2);
		expect(h.save.calls[1]?.input.baseRevision).toBe(0);
		h.save.calls[0]?.resolve({ outcome: "saved", revision: 1 }); // the abandoned one, late
		await flush();
		expect(entryOf(h.store).server).toBeNull();
		expect(entryOf(h.store).local?.text).toBe("deploy");
	});

	it("a start that never answers: after 30 s the release is sent, and a late created is ignored (G32)", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, "first message");
		h.store.dispatch({ type: "ENTRY", key: K, event: { type: "SUBMIT", chatReady: true } });
		await flush();
		await grant(h);
		expect(h.start.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(h.release.calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.release.calls).toHaveLength(1);
		expect(h.release.calls[0]?.input.token).toBe(h.claim.calls[0]?.input.token);
		h.start.calls[0]?.resolve({ outcome: "created", revision: 3, threadRevision: 1 });
		await flush();
		expect(entryOf(h.store).sending?.phase).toBe("releasing");
		expect(h.ui.some((e) => e.type === "send-message")).toBe(false);
	});
});

describe("answers are fed back (D8, D27)", () => {
	it("a save's answer acknowledges the entry and removes its cache item (I4)", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		expect(window.sessionStorage.getItem(`${CACHE_PREFIX}${VIEWER}:${keyId(K)}`)).not.toBeNull();
		h.save.calls[0]?.resolve({ outcome: "saved", revision: 1 });
		await flush();
		const e = entryOf(h.store);
		expect(e.local).toBeNull();
		expect(e.server?.revision).toBe(1);
		expect(e.save).toBe("idle");
		expect(window.sessionStorage.getItem(`${CACHE_PREFIX}${VIEWER}:${keyId(K)}`)).toBeNull();
	});

	it("a transient failure is retried after 1 s, then 2 s: never at once (D27)", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		h.save.calls[0]?.resolve({ outcome: "unavailable" });
		await vi.advanceTimersByTimeAsync(999);
		expect(h.save.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.save.calls).toHaveLength(2);
		h.save.calls[1]?.resolve({ outcome: "rate-limited" });
		await vi.advanceTimersByTimeAsync(1_999);
		expect(h.save.calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.save.calls).toHaveLength(3);
	});

	it("`online` retries a retrying key at once (D27)", async () => {
		const h = setup();
		const off = h.store.connect(window, document);
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		h.save.calls[0]?.reject(new TypeError("Failed to fetch"));
		await flush();
		expect(entryOf(h.store).save).toBe("retrying");
		window.dispatchEvent(new Event("online"));
		await flush();
		expect(h.save.calls).toHaveLength(2);
		off();
	});
});

describe("the heartbeat (D34)", () => {
	it("no heartbeat is sent while claiming", async () => {
		const h = setup();
		await loadA(h);
		await submitLater(h);
		expect(h.claim.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(14_000);
		expect(h.beats).toHaveLength(0);
	});

	it("a granted claim held through a 100 s action-queue stall is still renewed by fetch every 20 s", async () => {
		const h = setup();
		await loadA(h);
		await submitLater(h);
		await grant(h);
		const sent = h.ui.find((e) => e.type === "send-message");
		expect(sent?.type === "send-message" ? sent.turnId : null).toBe(h.claim.calls[0]?.input.turnId);
		h.store.dispatch({
			type: "ENTRY",
			key: K,
			event: { type: "ROUTE_HANDOFF", turnId: h.claim.calls[0]?.input.turnId ?? "" },
		});
		await flush();
		expect(h.consume.calls).toHaveLength(1); // and it never answers
		await vi.advanceTimersByTimeAsync(100_000);
		expect(h.beats).toHaveLength(5);
		expect(new Set(h.beats.map((b) => b.token))).toEqual(new Set([h.claim.calls[0]?.input.token]));
		expect(entryOf(h.store).sending?.phase).toBe("consuming");
	});

	it("stops when the send clears, and beats at once when the tab becomes visible", async () => {
		const h = setup();
		const off = h.store.connect(window, document);
		await loadA(h);
		await submitLater(h);
		await grant(h);
		document.dispatchEvent(new Event("visibilitychange")); // jsdom is "visible"
		await flush();
		expect(h.beats).toHaveLength(1);
		h.store.dispatch({
			type: "ENTRY",
			key: K,
			event: { type: "ROUTE_HANDOFF", turnId: h.claim.calls[0]?.input.turnId ?? "" },
		});
		await flush();
		h.consume.calls[0]?.resolve({ outcome: "consumed", revision: 3 });
		await flush();
		expect(entryOf(h.store).sending).toBeNull();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.beats).toHaveLength(1);
		off();
	});

	it("a heartbeat answered 403 stops the timer", async () => {
		const h = setup();
		h.setBeatStatus(403);
		await loadA(h);
		await submitLater(h);
		await grant(h);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.beats).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(80_000);
		expect(h.beats).toHaveLength(1);
	});
});

describe("the cache (§7.3, I4)", () => {
	it("with a storage getter that throws, drafts still save to the server and the key says the tab can't keep it", async () => {
		const h = setup(() => {
			throw new DOMException("denied", "SecurityError");
		});
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		expect(h.store.view.getState().uncached[keyId(K)]).toBe(true);
		h.save.calls[0]?.resolve({ outcome: "saved", revision: 1 });
		await flush();
		expect(entryOf(h.store).server?.content.text).toBe("deploy");
	});

	it("a cache write that throws breaks nothing: the save still goes", async () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, "deploy");
		await vi.advanceTimersByTimeAsync(800);
		expect(h.store.view.getState().uncached[keyId(K)]).toBe(true);
		expect(h.save.calls).toHaveLength(1);
	});

	it("at the budget a cache write is refused and a canvas-draft write still succeeds (G7)", async () => {
		const filler = `${CACHE_PREFIX}${VIEWER}:${ORG_A}:org:00000000-0000-4000-8000-0000000000ff`;
		window.sessionStorage.setItem(filler, "x".repeat(999_900));
		const h = setup();
		const kb: DraftKey = { ...SCOPE_B, conversationId: K.conversationId };
		h.store.load(SCOPE_B); // a scope without the filler, so LOAD restores nothing of it
		openNew(h.store, kb);
		type(h.store, "deploy", kb);
		await vi.advanceTimersByTimeAsync(300);
		expect(h.store.view.getState().uncached[keyId(kb)]).toBe(true);
		expect(window.sessionStorage.getItem(filler)).not.toBeNull();
		window.sessionStorage.setItem("alethia:canvas:draft", "y".repeat(10_000));
		expect(window.sessionStorage.getItem("alethia:canvas:draft")).toHaveLength(10_000);
	});

	it("a credential-looking draft is kept in the tab's cache and never saved (D36)", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		type(h.store, `${["pass", "word"].join("")} = ${"z".repeat(12)}`);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.save.calls).toHaveLength(0);
		expect(entryOf(h.store).blockedBy?.kind).toBe("credential");
		expect(window.sessionStorage.getItem(`${CACHE_PREFIX}${VIEWER}:${keyId(K)}`)).not.toBeNull();
	});

	it("LOAD removes v1, v2 and other viewers' items, keeps others' storage, and restores this scope's words (D26)", async () => {
		const s = window.sessionStorage;
		s.setItem("alethia:elench:drafts:v1", "{}");
		s.setItem("alethia:elench:draft:v2:x", "{}");
		s.setItem(`${CACHE_PREFIX}00000000-0000-4000-8000-0000000000bb:${keyId(K)}`, "{}");
		s.setItem("alethia:canvas:draft", "keep");
		const item = { base: 0, local: { ...EMPTY_CONTENT, text: "typed before reload" }, claiming: null, sending: null, abandoned: [], epoch: 0 };
		s.setItem(`${CACHE_PREFIX}${VIEWER}:${keyId(K)}`, JSON.stringify(item));
		const h = setup();
		await loadA(h);
		expect(s.getItem("alethia:elench:drafts:v1")).toBeNull();
		expect(s.getItem("alethia:elench:draft:v2:x")).toBeNull();
		expect(s.getItem(`${CACHE_PREFIX}00000000-0000-4000-8000-0000000000bb:${keyId(K)}`)).toBeNull();
		expect(s.getItem("alethia:canvas:draft")).toBe("keep");
		expect(h.save.calls[0]?.input.content.text).toBe("typed before reload");
		expect(h.save.calls[0]?.input.baseRevision).toBe(0);
	});

	it("LOAD releases a restored claim by its own token (D26)", async () => {
		const claiming = { attempt: "a", token: "tok-reload", turnId: "turn-reload", kind: "first", content: { ...EMPTY_CONTENT, text: "hi" } };
		const item = { base: 0, local: null, claiming, sending: null, abandoned: [], epoch: 0 };
		window.sessionStorage.setItem(`${CACHE_PREFIX}${VIEWER}:${keyId(K)}`, JSON.stringify(item));
		const h = setup();
		await loadA(h);
		expect(h.release.calls[0]?.input).toMatchObject({ token: "tok-reload", error: "reload" });
	});
});

describe("listDrafts (§6.4, D22, D23, D30)", () => {
	it("runs at LOAD, on focus, every 60 s while the surface is open, and on a scope change, with the last org as hint", async () => {
		const h = setup();
		const off = h.store.connect(window, document);
		await loadA(h);
		expect(h.list.calls[0]?.input).toEqual({ projectId: null });
		window.dispatchEvent(new Event("focus"));
		expect(h.list.calls).toHaveLength(2);
		expect(h.list.calls[1]?.input).toEqual({ projectId: null, orgHint: ORG_A });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.list.calls).toHaveLength(2); // the surface is closed: no poll
		h.store.setSurfaceOpen(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.list.calls).toHaveLength(3);
		h.store.dispatch({ type: "SCOPE_CHANGE", scope: SCOPE_B });
		expect(h.list.calls).toHaveLength(4);
		off();
	});

	it("a late answer for an older scope is dropped (D23)", async () => {
		const h = setup();
		h.store.load(SCOPE_A);
		h.store.dispatch({ type: "SCOPE_CHANGE", scope: SCOPE_B });
		h.list.calls[0]?.resolve({ outcome: "ok", orgId: ORG_A, drafts: [{ row: row("x", 1), thread: { status: "none", firstTurnId: null, hasTurn: false }, threadTitle: null }] });
		await flush();
		expect(h.store.view.getState().drafts.entries[keyId(K)]).toBeUndefined();
		expect(h.store.view.getState().drafts.pageOrg).toBeNull();
	});

	it("polls every 10 s while a row is being sent from another tab (D30)", async () => {
		const h = setup();
		const sending = row("frozen", 4, {
			state: "sending",
			claim: { token: "tok-other", turnId: "turn-other", kind: "later", claimedAt: "2026-10-09T00:00:00.000Z" },
		});
		await loadA(h, [{ row: sending, thread: { status: "listed", firstTurnId: null, hasTurn: false }, threadTitle: null }]);
		expect(entryOf(h.store).conflict?.kind).toBe("claimed");
		h.store.setSurfaceOpen(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.list.calls).toHaveLength(2);
	});
});

describe("selectors", () => {
	it("useUnsent lists the scope's keys with unsent words; useDraft reads one key", async () => {
		const h = setup();
		await loadA(h);
		openNew(h.store);
		const { result } = renderHook(() => ({ unsent: useUnsent(h.store, SCOPE_A), draft: useDraft(h.store, K) }));
		expect(result.current.unsent).toEqual([]);
		act(() => type(h.store, "deploy"));
		expect(result.current.unsent.map((e) => e.key.conversationId)).toEqual([K.conversationId]);
		expect(result.current.draft?.local?.text).toBe("deploy");
		expect(selectUnsent(h.store.view.getState(), SCOPE_B)).toEqual([]);
	});
});
