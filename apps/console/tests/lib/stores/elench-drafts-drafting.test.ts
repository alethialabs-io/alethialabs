// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 7a: the drafting half of the Elench drafts reducer. One test per transition, each
// citing its D-number, and the property tests of I3, I5 and I6 over these events.
//
// The property tests use a seeded generator loop rather than fast-check, which is not a dependency
// of the console: a failure names its seed and step, and the same seed replays it.

import { describe, expect, it } from "vitest";
import { type DraftContent, normalizeDraftText } from "@/lib/elench/draft-content";
import type { ServerDraft } from "@/lib/elench/draft-outcomes";
import {
	EMPTY_CONTENT,
	initialDraftsState,
	keyId,
	looksLikeCredential,
	newEntry,
	reduceDraftEntry,
	reduceDrafts,
	retryDelayMs,
	SAVE_DEBOUNCE_MS,
	scopeId,
	shownContent,
} from "@/lib/stores/elench-drafts/reducer-drafting";
import type {
	DraftEffect,
	DraftEntry,
	DraftEntryContext,
	DraftEntryEvent,
	DraftKey,
	DraftScope,
	DraftsEvent,
	DraftsState,
} from "@/lib/stores/elench-drafts/types";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const SCOPE_A: DraftScope = { orgId: ORG_A, projectId: null };
const SCOPE_B: DraftScope = { orgId: ORG_B, projectId: null };
const K: DraftKey = { ...SCOPE_A, conversationId: "c-1" };
const TAB = "tab-1";
const NOW = "2026-10-09T00:00:00.000Z";
const ENV = { tabId: TAB, now: NOW };
const CTX: DraftEntryContext = { pageOrg: ORG_A, tabId: TAB, active: true, now: NOW };
const SECRET = "AKIAABCDEFGHIJKLMNOP";

/** A content holding only `text`. */
function c(text: string): DraftContent {
	return { ...EMPTY_CONTENT, text };
}

/** A server row of key K at `revision` holding `content`. */
function row(content: DraftContent, revision: number, over: Partial<ServerDraft> = {}): ServerDraft {
	return {
		orgId: K.orgId,
		projectId: K.projectId,
		conversationId: K.conversationId,
		revision,
		state: "active",
		content,
		claim: null,
		failedSend: null,
		lastSent: null,
		threadSeen: false,
		title: null,
		lastWriter: "tab-other",
		discardedAt: null,
		updatedAt: NOW,
		...over,
	};
}

const THREAD = { status: "none" as const, firstTurnId: null, hasTurn: false };

/** An entry of key K with the given fields. */
function entry(over: Partial<DraftEntry> = {}): DraftEntry {
	return { ...newEntry(K, "none"), ...over };
}

/** An entry with `local` and a save of it in flight at `base`. */
function saving(local: DraftContent, base = 0, over: Partial<DraftEntry> = {}): DraftEntry {
	return entry({
		local,
		save: "saving",
		inflight: { op: "save", base, content: local, failedSend: null },
		...over,
	});
}

/** Reduces one entry event with CTX (or `ctx`). */
function step(e: DraftEntry, ev: DraftEntryEvent, ctx: DraftEntryContext = CTX) {
	return reduceDraftEntry(e, ev, ctx);
}

/** The effects of one type. */
function ofType<T extends DraftEffect["type"]>(effects: DraftEffect[], type: T) {
	return effects.filter((x): x is Extract<DraftEffect, { type: T }> => x.type === type);
}

/** The editor's yield for `text`, with no pills. */
function edit(epoch: number, text: string): DraftEntryEvent {
	return { type: "EDIT", epoch, content: { text, mentions: [] } };
}

/** A store showing scope A, on org A's page. */
function storeA(): DraftsState {
	const s = reduceDrafts(initialDraftsState("viewer-1"), { type: "SCOPE_CHANGE", scope: SCOPE_A }, ENV).state;
	return reduceDrafts(s, { type: "PAGE_ORG", orgId: ORG_A }, ENV).state;
}

describe("D1 / D2 OPEN_NEW", () => {
	it("D2 › with no active key, New chat mints one and makes it active", () => {
		const s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		expect(s.activeKey[scopeId(SCOPE_A)]).toBe("n1");
		expect(s.entries[keyId({ ...SCOPE_A, conversationId: "n1" })]?.thread).toBe("none");
	});

	it("D1 › New chat on an active key with no content and no row does nothing (no clutter)", () => {
		const s1 = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const t = reduceDrafts(s1, { type: "OPEN_NEW", conversationId: "n2" }, ENV);
		expect(t.state).toBe(s1);
		expect(t.effects).toEqual([]);
	});

	it("D2 › New chat on a key with words mints a new key and leaves the old entry untouched", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const k1 = { ...SCOPE_A, conversationId: "n1" };
		s = reduceDrafts(s, { type: "ENTRY", key: k1, event: edit(0, "hello") }, ENV).state;
		const before = s.entries[keyId(k1)];
		s = reduceDrafts(s, { type: "OPEN_NEW", conversationId: "n2" }, ENV).state;
		expect(s.activeKey[scopeId(SCOPE_A)]).toBe("n2");
		expect(s.entries[keyId(k1)]).toBe(before);
	});

	it("D1 › an open conversation with no draft is not `none`: New chat mints a new key", () => {
		let s = reduceDrafts(storeA(), { type: "SELECT", key: K, thread: "listed" }, ENV).state;
		s = reduceDrafts(s, { type: "OPEN_NEW", conversationId: "n2" }, ENV).state;
		expect(s.activeKey[scopeId(SCOPE_A)]).toBe("n2");
		expect(s.entries[keyId({ ...SCOPE_A, conversationId: "n2" })]?.thread).toBe("none");
	});

	it("D1 with an artifacts-only draft mints a new key (A4)", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_ARTIFACT_NEW", conversationId: "n1", artifactId: "art" }, ENV).state;
		s = reduceDrafts(s, { type: "OPEN_NEW", conversationId: "n2" }, ENV).state;
		expect(s.activeKey[scopeId(SCOPE_A)]).toBe("n2");
	});
});

describe("D3 OPEN_ARTIFACT_NEW", () => {
	it("D3 › mints a key whose content is the placement, saves it, and creates no thread", () => {
		const t = reduceDrafts(storeA(), { type: "OPEN_ARTIFACT_NEW", conversationId: "n1", artifactId: "art" }, ENV);
		const k1 = { ...SCOPE_A, conversationId: "n1" };
		expect(t.state.activeKey[scopeId(SCOPE_A)]).toBe("n1");
		expect(t.state.entries[keyId(k1)]?.local).toEqual({ ...EMPTY_CONTENT, artifacts: ["art"] });
		expect(ofType(t.effects, "save")).toEqual([
			{ type: "save", key: k1, base: 0, content: { ...EMPTY_CONTENT, artifacts: ["art"] }, failedSend: null },
		]);
		expect(t.state.entries[keyId(k1)]?.thread).toBe("none");
	});
});

describe("D4 SELECT", () => {
	it("D4 › a listed thread is loaded (transcript loading, then loaded)", () => {
		const t = reduceDrafts(storeA(), { type: "SELECT", key: K, thread: "listed" }, ENV);
		expect(t.state.activeKey[scopeId(SCOPE_A)]).toBe(K.conversationId);
		expect(t.state.entries[keyId(K)]?.transcript).toBe("loading");
		expect(t.effects).toEqual([{ type: "load-transcript", key: K }]);
		const s = reduceDrafts(t.state, { type: "ENTRY", key: K, event: { type: "TRANSCRIPT_LOADED" } }, ENV).state;
		expect(s.entries[keyId(K)]?.transcript).toBe("loaded");
	});

	it("D4 › a none/deleted key opens without getThread (G21)", () => {
		const t = reduceDrafts(storeA(), { type: "SELECT", key: K, thread: "deleted" }, ENV);
		expect(t.effects).toEqual([]);
		expect(t.state.entries[keyId(K)]?.transcript).toBe("loaded");
	});

	it("D4 › a key of another scope is not selected", () => {
		const s = storeA();
		const t = reduceDrafts(s, { type: "SELECT", key: { ...SCOPE_B, conversationId: "x" }, thread: "listed" }, ENV);
		expect(t.state).toBe(s);
	});
});

describe("D5 / D6 EDIT", () => {
	it("D5 › an edit at the current epoch becomes local and schedules a save after 800 ms", () => {
		const t = step(entry(), edit(0, "deploy"));
		expect(t.entry?.local).toEqual(c("deploy"));
		expect(t.effects).toEqual([{ type: "schedule-save", key: K, delayMs: SAVE_DEBOUNCE_MS, reason: "timer" }]);
	});

	it("D5 › the text is normalized, and artifacts and the cell target are carried over", () => {
		const shown: DraftContent = { ...c("x"), artifacts: ["a1"], cellTarget: { x: 1, y: 2 } };
		const t = step(entry({ server: row(shown, 3) }), edit(0, "a\u0000b"));
		expect(t.entry?.local).toEqual({ ...shown, text: "ab" });
	});

	it("D5 › an edit back to the server content clears local", () => {
		const t = step(entry({ server: row(c("same"), 2), local: c("diff") }), edit(0, "same"));
		expect(t.entry?.local).toBeNull();
	});

	it("D5 › the box is read-only while a claim is pending", () => {
		const e = entry({ claiming: { attempt: "a", token: "t", turnId: "u", kind: "first", content: c("x") } });
		expect(step(e, edit(0, "typed")).entry).toBe(e);
	});

	it("D6 › an edit stamped with an older epoch is dropped", () => {
		const e = entry({ epoch: 3, local: c("kept") });
		const t = step(e, edit(2, "stale"));
		expect(t.entry).toBe(e);
		expect(t.effects).toEqual([]);
	});

	it("an EDIT after a save ack in the same tick is kept (G16)", () => {
		let e = step(saving(c("a")), { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 1 } }).entry;
		if (e === null) throw new Error("removed");
		e = step(e, edit(0, "ab")).entry;
		expect(e?.local).toEqual(c("ab"));
	});
});

describe("D7 save trigger", () => {
	it("D7 › a dirty key sends saveDraft at its base", () => {
		const t = step(entry({ server: row(c("a"), 4), local: c("ab") }), { type: "SAVE_TRIGGER", reason: "timer" });
		expect(t.effects).toEqual([{ type: "save", key: K, base: 4, content: c("ab"), failedSend: null }]);
		expect(t.entry?.save).toBe("saving");
	});

	it("D7 › never while a request is in flight, a send is live, or a conflict is open", () => {
		const trig: DraftEntryEvent = { type: "SAVE_TRIGGER", reason: "blur" };
		expect(step(saving(c("x")), trig).effects).toEqual([]);
		const sending = entry({
			local: c("x"),
			sending: {
				attempt: "a", token: "t", turnId: "u", kind: "later", text: "s", mentions: [],
				cellTarget: null, origin: "composer", at: 0, phase: "routing",
			},
		});
		expect(step(sending, trig).effects).toEqual([]);
		expect(step(entry({ local: c("x"), conflict: { kind: "edited", row: row(c("y"), 2) } }), trig).effects).toEqual([]);
	});

	it("D7 › a clean key sends nothing", () => {
		expect(step(entry(), { type: "SAVE_TRIGGER", reason: "hidden" }).effects).toEqual([]);
	});
});

describe("D8 saved", () => {
	it("D8 › the ack becomes the server row and local is cleared when it still equals what was sent", () => {
		const t = step(saving(c("a")), { type: "SAVE_RESULT", seq: 5, result: { outcome: "saved", revision: 1 } });
		expect(t.entry?.local).toBeNull();
		expect(t.entry?.server?.revision).toBe(1);
		expect(t.entry?.server?.content).toEqual(c("a"));
		expect(t.entry?.ackSeq).toBe(5);
		expect(t.effects).toEqual([{ type: "cache-remove", key: K }]);
	});

	it("D8 › words typed while the save flew are saved again at the new revision, never overwritten", () => {
		const e = saving(c("a"), 0, { local: c("ab") });
		const t = step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 1 } });
		expect(t.entry?.local).toEqual(c("ab"));
		expect(t.effects).toEqual([{ type: "save", key: K, base: 1, content: c("ab"), failedSend: null }]);
	});

	it("I5 › an edit back to the saved text while a save flies is kept, and saved after the ack", () => {
		// The server holds "A"; "AB" is sent; the B is deleted while it flies.
		let e: DraftEntry | null = entry({ server: row(c("A"), 1) });
		e = step(e, edit(0, "AB")).entry;
		if (e === null) throw new Error("removed");
		e = step(e, { type: "SAVE_TRIGGER", reason: "timer" }).entry;
		if (e === null) throw new Error("removed");
		e = step(e, edit(0, "A")).entry;
		if (e === null) throw new Error("removed");
		expect(shownContent(e).text).toBe("A");
		const t = step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 2 } });
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("A");
		expect(t.entry.server?.content.text).toBe("AB");
		expect(ofType(t.effects, "save")).toEqual([
			{ type: "save", key: K, base: 2, content: c("A"), failedSend: null },
		]);
	});

	it("D8 › a carried failed-send marker is cleared once acknowledged", () => {
		const marker = { turnId: "u", kind: "first" as const, error: "x", uncertain: false };
		const e = entry({
			local: c("a"), pendingFailedSend: marker, save: "saving",
			inflight: { op: "save", base: 0, content: c("a"), failedSend: marker },
		});
		const t = step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 1 } });
		expect(t.entry?.pendingFailedSend).toBeNull();
		expect(t.entry?.server?.failedSend).toEqual({ ...marker, at: NOW });
	});

	it("an answer with nothing in flight changes nothing", () => {
		const e = entry({ local: c("a") });
		expect(step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 9 } }).entry).toBe(e);
	});
});

describe("D14 / D14s / D15 conflict", () => {
	it("D14 › a row that already holds the unsaved words is adopted", () => {
		const r = row(c("ab"), 3);
		const t = step(saving(c("ab"), 1), { type: "SAVE_RESULT", seq: 1, result: { outcome: "conflict", row: r, thread: THREAD } });
		expect(t.entry?.server).toBe(r);
		expect(t.entry?.local).toBeNull();
		expect(t.entry?.conflict).toBeNull();
	});

	it("D14s › this tab's own abandoned save landed: rebase silently and save at the row's revision", () => {
		const r = row(c("a"), 3, { lastWriter: TAB });
		const t = step(saving(c("ab"), 1), { type: "SAVE_RESULT", seq: 1, result: { outcome: "conflict", row: r, thread: THREAD } });
		expect(t.entry?.conflict).toBeNull();
		expect(t.effects).toEqual([{ type: "save", key: K, base: 3, content: c("ab"), failedSend: null }]);
	});

	it("D15 › another tab's edit opens the bar and keeps the unsaved words; no autosave runs", () => {
		const r = row(c("theirs"), 3);
		const t = step(saving(c("mine"), 1), { type: "SAVE_RESULT", seq: 1, result: { outcome: "conflict", row: r, thread: THREAD } });
		expect(t.entry?.local).toEqual(c("mine"));
		expect(t.entry?.conflict).toEqual({ kind: "edited", row: r });
		expect(t.effects).toEqual([]);
		if (t.entry === null) throw new Error("removed");
		expect(step(t.entry, { type: "SAVE_TRIGGER", reason: "timer" }).effects).toEqual([]);
	});

	it("D15 › Keep mine saves at the row's revision", () => {
		const r = row(c("theirs"), 3);
		const e = entry({ local: c("mine"), conflict: { kind: "edited", row: r } });
		const t = step(e, { type: "CONFLICT_KEEP_MINE" });
		expect(t.effects).toEqual([{ type: "save", key: K, base: 3, content: c("mine"), failedSend: null }]);
	});

	it("D15 › Use theirs replaces the box from outside and bumps the epoch", () => {
		const r = row(c("theirs"), 3);
		const e = entry({ local: c("mine"), conflict: { kind: "edited", row: r }, epoch: 2 });
		const t = step(e, { type: "CONFLICT_USE_THEIRS" });
		expect(t.entry?.local).toBeNull();
		expect(t.entry?.server).toBe(r);
		expect(t.entry?.epoch).toBe(3);
	});
});

describe("D16 discarded", () => {
	const r = row(c("old"), 4, { state: "discarded", discardedAt: NOW });

	it("D16 › discarded elsewhere: the box keeps local and the bar opens", () => {
		const t = step(saving(c("mine"), 3), { type: "SAVE_RESULT", seq: 1, result: { outcome: "discarded", row: r, thread: THREAD } });
		expect(t.entry?.local).toEqual(c("mine"));
		expect(t.entry?.conflict).toEqual({ kind: "discarded", row: r });
	});

	it("D16 › Restore calls restoreDraft, then saves the words on the restored row", () => {
		const e = entry({ local: c("mine"), conflict: { kind: "discarded", row: r } });
		const t1 = step(e, { type: "CONFLICT_RESTORE" });
		expect(t1.effects).toEqual([{ type: "restore", key: K, base: 4 }]);
		if (t1.entry === null) throw new Error("removed");
		const t2 = step(t1.entry, { type: "RESTORE_RESULT", seq: 2, result: { outcome: "saved", revision: 5 } });
		expect(t2.entry?.server?.state).toBe("active");
		expect(t2.effects).toEqual([{ type: "save", key: K, base: 5, content: c("mine"), failedSend: null }]);
	});

	it("D16 › Let it go on the active key clears it, so New chat and later edits work", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const k1 = { ...SCOPE_A, conversationId: "n1" };
		const id = keyId(k1);
		const e1 = s.entries[id];
		if (e1 === undefined) throw new Error("missing");
		s = { ...s, entries: { ...s.entries, [id]: { ...e1, local: c("mine"), conflict: { kind: "discarded", row: { ...r, ...k1 } } } } };
		s = reduceDrafts(s, { type: "ENTRY", key: k1, event: { type: "CONFLICT_LET_GO" } }, ENV).state;
		expect(s.entries[id]).toBeUndefined();
		expect(s.activeKey[scopeId(SCOPE_A)]).toBeUndefined();
		s = reduceDrafts(s, { type: "OPEN_NEW", conversationId: "n2" }, ENV).state;
		const k2 = { ...SCOPE_A, conversationId: "n2" };
		expect(s.activeKey[scopeId(SCOPE_A)]).toBe("n2");
		s = reduceDrafts(s, { type: "ENTRY", key: k2, event: edit(0, "next") }, ENV).state;
		expect(s.entries[keyId(k2)]?.local).toEqual(c("next"));
	});

	it("D16 › Let it go removes the entry", () => {
		const e = entry({ local: c("mine"), conflict: { kind: "discarded", row: r } });
		expect(step(e, { type: "CONFLICT_LET_GO" }).entry).toBeNull();
	});
});

describe("D19 / D19L gone", () => {
	const deleted = { status: "deleted" as const, firstTurnId: null, hasTurn: false };

	it("D19 › gone with nothing unsaved: a non-active key is removed with the deleted notice", () => {
		const e = entry({ server: row(c("a"), 1), save: "saving", inflight: { op: "save", base: 1, content: c("b"), failedSend: null } });
		const t = step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "gone", thread: deleted } }, { ...CTX, active: false });
		expect(t.entry).toBeNull();
		expect(t.effects).toEqual([{ type: "notice", key: K, notice: "deleted-unsent-removed" }]);
	});

	it("D19 › the active key stays, emptied, with the epoch bumped", () => {
		const e = entry({ server: row(c("a"), 1), save: "saving", inflight: { op: "save", base: 1, content: c("b"), failedSend: null } });
		const t = step(e, { type: "SAVE_RESULT", seq: 1, result: { outcome: "gone", thread: deleted } });
		expect(t.entry?.server).toBeNull();
		expect(t.entry?.epoch).toBe(1);
	});

	it("gone while the box holds unsaved words keeps them (D18 is slice 7b's)", () => {
		const t = step(saving(c("mine"), 1), { type: "SAVE_RESULT", seq: 1, result: { outcome: "gone", thread: deleted } });
		expect(t.entry?.local).toEqual(c("mine"));
	});

	it("D19L › a list that no longer lists an acknowledged clean key removes it", () => {
		const e = entry({ server: row(c("a"), 1), ackSeq: 3 });
		expect(step(e, { type: "NOT_LISTED", seq: 4 }, { ...CTX, active: false }).entry).toBeNull();
	});

	it("D19L › never a key with local, no row seen, or a write answered after the list was requested", () => {
		const ev: DraftEntryEvent = { type: "NOT_LISTED", seq: 4 };
		const ctx = { ...CTX, active: false };
		const withLocal = entry({ server: row(c("a"), 1), local: c("b") });
		expect(step(withLocal, ev, ctx).entry).toBe(withLocal);
		const neverSeen = entry();
		expect(step(neverSeen, ev, ctx).entry).toBe(neverSeen);
		const later = entry({ server: row(c("a"), 1), ackSeq: 4 });
		expect(step(later, ev, ctx).entry).toBe(later);
	});
});

describe("D23 SCOPE_CHANGE", () => {
	it("D23 › the scope moves, the generation bumps, the list runs, and an org change clears the page org", () => {
		const s = storeA();
		const t = reduceDrafts(s, { type: "SCOPE_CHANGE", scope: SCOPE_B }, ENV);
		expect(t.state.scope).toEqual(SCOPE_B);
		expect(t.state.generation).toBe(s.generation + 1);
		expect(t.state.pageOrg).toBeNull();
		expect(t.effects).toEqual([{ type: "list", scope: SCOPE_B, generation: s.generation + 1 }]);
	});

	it("D23 › an anchor change in the same org keeps the page org and every entry", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const entries = s.entries;
		s = reduceDrafts(s, { type: "SCOPE_CHANGE", scope: { orgId: ORG_A, projectId: "p1" } }, ENV).state;
		expect(s.pageOrg).toBe(ORG_A);
		expect(s.entries).toBe(entries);
	});
});

describe("D24 scope-changed", () => {
	it("D24 › other-org holds the key (not blocked) and keeps the words", () => {
		const t = step(saving(c("mine")), { type: "SAVE_RESULT", seq: 1, result: { outcome: "scope-changed", reason: "other-org" } });
		expect(t.entry?.save).toBe("held");
		expect(t.entry?.blockedBy).toEqual({ kind: "other-org" });
		expect(t.entry?.local).toEqual(c("mine"));
		expect(t.effects).toEqual([{ type: "notice", key: K, notice: "held-other-org" }]);
	});

	it("D24 › address blocks with the new slug", () => {
		const t = step(saving(c("mine")), { type: "SAVE_RESULT", seq: 1, result: { outcome: "scope-changed", reason: "address", slug: "new" } });
		expect(t.entry?.save).toBe("blocked");
		expect(t.entry?.blockedBy).toEqual({ kind: "address", slug: "new" });
	});
});

describe("D25 VIEWER_CHANGE", () => {
	it("D25 › memory and every cache item are cleared", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const t = reduceDrafts(s, { type: "VIEWER_CHANGE", viewerId: "viewer-2" }, ENV);
		s = t.state;
		expect(s.entries).toEqual({});
		expect(s.activeKey).toEqual({});
		expect(t.effects).toEqual([{ type: "cache-clear" }]);
	});
});

describe("D27 / D28 failures", () => {
	it("D27 › a transient failure retries with backoff 1, 2, 4 … 60 s", () => {
		expect([1, 2, 3, 7, 8].map(retryDelayMs)).toEqual([1000, 2000, 4000, 60000, 60000]);
		const t = step(saving(c("a")), { type: "SAVE_RESULT", seq: 1, result: { outcome: "unavailable" } });
		expect(t.entry?.save).toBe("retrying");
		expect(ofType(t.effects, "schedule-save")).toEqual([{ type: "schedule-save", key: K, delayMs: 1000, reason: "retry" }]);
	});

	it("fail, recover, fail raises two notices (G19)", () => {
		let e: DraftEntry | null = saving(c("a"));
		const notices: DraftEffect[] = [];
		const run = (ev: DraftEntryEvent) => {
			if (e === null) throw new Error("removed");
			const t = step(e, ev);
			e = t.entry;
			notices.push(...ofType(t.effects, "notice"));
		};
		run({ type: "WRITE_REJECTED", seq: 1, rejection: { network: true } });
		run({ type: "SAVE_TRIGGER", reason: "retry" });
		run({ type: "WRITE_REJECTED", seq: 2, rejection: { network: true } }); // still retrying: no new notice
		run({ type: "SAVE_TRIGGER", reason: "online" });
		run({ type: "SAVE_RESULT", seq: 3, result: { outcome: "saved", revision: 1 } });
		run(edit(0, "b"));
		run({ type: "SAVE_TRIGGER", reason: "timer" });
		run({ type: "SAVE_RESULT", seq: 4, result: { outcome: "rate-limited" } });
		expect(notices).toHaveLength(2);
	});

	it("D27 › while retrying, an edit's debounce does not defeat the backoff", () => {
		const e = entry({ local: c("a"), save: "retrying", transientFailures: 1 });
		expect(step(e, { type: "SAVE_TRIGGER", reason: "timer" }).effects).toEqual([]);
		expect(ofType(step(e, { type: "SAVE_TRIGGER", reason: "online" }).effects, "save")).toHaveLength(1);
	});

	it("D27 → D28 › a rejected call that is not a network failure is retried three times, then blocked", () => {
		let e = saving(c("a"));
		for (let i = 1; i <= 3; i += 1) {
			const t = step(e, { type: "WRITE_REJECTED", seq: i, rejection: { network: false } });
			expect(t.entry?.save).toBe("retrying");
			const again = t.entry === null ? null : step(t.entry, { type: "SAVE_TRIGGER", reason: "retry" }).entry;
			if (again === null) throw new Error("removed");
			e = again;
		}
		const last = step(e, { type: "WRITE_REJECTED", seq: 4, rejection: { network: false } });
		expect(last.entry?.save).toBe("blocked");
		expect(last.entry?.blockedBy).toEqual({ kind: "error" });
	});

	it("D28 › unauthorized / forbidden / limit / invalid block, keep the words, and are not retried", () => {
		for (const result of [
			{ outcome: "unauthorized" as const },
			{ outcome: "forbidden" as const, reason: "membership" as const },
			{ outcome: "limit" as const },
			{ outcome: "invalid" as const },
		]) {
			const t = step(saving(c("a")), { type: "SAVE_RESULT", seq: 1, result });
			expect(t.entry?.save).toBe("blocked");
			expect(t.entry?.local).toEqual(c("a"));
			if (t.entry === null) throw new Error("removed");
			expect(step(t.entry, { type: "SAVE_TRIGGER", reason: "retry" }).effects).toEqual([]);
		}
	});

	it("D28 › unauthorized retries once after a sign-in; limit when room frees", () => {
		const u = entry({ local: c("a"), save: "blocked", blockedBy: { kind: "unauthorized" } });
		expect(ofType(step(u, { type: "UNBLOCK", reason: "signed-in" }).effects, "save")).toHaveLength(1);
		expect(step(u, { type: "UNBLOCK", reason: "limit-freed" }).entry).toBe(u);
		const l = entry({ local: c("a"), save: "blocked", blockedBy: { kind: "limit" } });
		expect(ofType(step(l, { type: "UNBLOCK", reason: "limit-freed" }).effects, "save")).toHaveLength(1);
	});
});

describe("D29 PAGE_ORG", () => {
	it("D29 › a write is never sent for a key of another org's page: it is held", () => {
		const t = step(entry({ local: c("a") }), { type: "SAVE_TRIGGER", reason: "timer" }, { ...CTX, pageOrg: ORG_B });
		expect(t.entry?.save).toBe("held");
		expect(ofType(t.effects, "save")).toEqual([]);
	});

	it("D29 › with null (before a navigation) nothing is sent", () => {
		const t = step(entry({ local: c("a") }), { type: "SAVE_TRIGGER", reason: "timer" }, { ...CTX, pageOrg: null });
		expect(ofType(t.effects, "save")).toEqual([]);
	});

	it("D29 › returning to the org resumes held and address-blocked keys and saves them", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const k1 = { ...SCOPE_A, conversationId: "n1" };
		s = reduceDrafts(s, { type: "ENTRY", key: k1, event: edit(0, "words") }, ENV).state;
		s = reduceDrafts(s, { type: "PAGE_ORG", orgId: null }, ENV).state;
		s = reduceDrafts(s, { type: "ENTRY", key: k1, event: { type: "SAVE_TRIGGER", reason: "timer" } }, ENV).state;
		expect(s.entries[keyId(k1)]?.save).toBe("held");
		const t = reduceDrafts(s, { type: "PAGE_ORG", orgId: ORG_A }, ENV);
		expect(ofType(t.effects, "save")).toEqual([{ type: "save", key: k1, base: 0, content: c("words"), failedSend: null }]);
	});

	it("D29 › another org's id resumes nothing of this org", () => {
		const s = storeA();
		const held = { ...entry({ local: c("a"), save: "held", blockedBy: { kind: "other-org" } }) };
		const s2: DraftsState = { ...s, entries: { [keyId(K)]: held } };
		const t = reduceDrafts(s2, { type: "PAGE_ORG", orgId: ORG_B }, ENV);
		expect(t.state.entries[keyId(K)]).toBe(held);
		expect(t.effects).toEqual([]);
	});
});

describe("D36 credential hold", () => {
	it("the detector matches common credential shapes and not ordinary prose", () => {
		expect(looksLikeCredential(`aws key ${SECRET}`)).toBe(true);
		expect(looksLikeCredential("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
		expect(looksLikeCredential("password=hunter22hunter")).toBe(true);
		expect(looksLikeCredential("why is my pod crashlooping in namespace prod?")).toBe(false);
	});

	it("D36 › a pasted credential holds the autosave: no save is sent, and the notice is raised once", () => {
		const t = step(entry(), edit(0, `key ${SECRET}`));
		expect(t.entry?.save).toBe("held");
		expect(t.entry?.blockedBy).toEqual({ kind: "credential" });
		expect(t.effects).toEqual([{ type: "notice", key: K, notice: "credential" }]);
		if (t.entry === null) throw new Error("removed");
		for (const reason of ["timer", "blur", "hidden", "retry", "online"] as const) {
			expect(ofType(step(t.entry, { type: "SAVE_TRIGGER", reason }).effects, "save")).toEqual([]);
		}
		const more = step(t.entry, edit(0, `key ${SECRET} more`));
		expect(more.effects).toEqual([]);
	});

	it("D36 › a page-org resume does not lift the credential hold", () => {
		let s = reduceDrafts(storeA(), { type: "OPEN_NEW", conversationId: "n1" }, ENV).state;
		const k1 = { ...SCOPE_A, conversationId: "n1" };
		s = reduceDrafts(s, { type: "ENTRY", key: k1, event: edit(0, SECRET) }, ENV).state;
		const t = reduceDrafts(s, { type: "PAGE_ORG", orgId: ORG_A }, ENV);
		expect(ofType(t.effects, "save")).toEqual([]);
	});

	it("D36 › Save to my account lifts the hold and saves", () => {
		const held = step(entry(), edit(0, SECRET)).entry;
		if (held === null) throw new Error("removed");
		const t = step(held, { type: "CREDENTIAL_ACK" });
		expect(t.entry?.credentialAck).toBe(true);
		expect(ofType(t.effects, "save")).toEqual([{ type: "save", key: K, base: 0, content: c(SECRET), failedSend: null }]);
	});

	it("D36 › editing the match away lifts the hold", () => {
		const held = step(entry(), edit(0, SECRET)).entry;
		if (held === null) throw new Error("removed");
		const t = step(held, edit(0, "nothing secret"));
		expect(t.entry?.save).toBe("idle");
		expect(t.entry?.blockedBy).toBeNull();
		expect(t.effects).toEqual([{ type: "schedule-save", key: K, delayMs: SAVE_DEBOUNCE_MS, reason: "timer" }]);
	});

	it("D36 › a save already in flight when the paste lands is followed by no save of the secret", () => {
		const e = saving(c("a"));
		const pasted = step(e, edit(0, SECRET)).entry;
		if (pasted === null) throw new Error("removed");
		const t = step(pasted, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 1 } });
		expect(ofType(t.effects, "save")).toEqual([]);
		expect(t.entry?.save).toBe("held");
	});
});

// ── Property tests: I3, I5, I6 over the drafting events ──────────────────────────────────────────

/** A deterministic PRNG (mulberry32): the same seed gives the same sequence. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TEXTS = ["", "a", "deploy", "deploy now", `token ${SECRET}`, "x\u0000y"];
const KEYS: DraftKey[] = [
	{ ...SCOPE_A, conversationId: "p1" },
	{ ...SCOPE_A, conversationId: "p2" },
	{ ...SCOPE_B, conversationId: "p3" },
];

/** A random drafting event against `state`. */
function randomEvent(r: () => number, state: DraftsState, seq: () => number): DraftsEvent {
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
	const key = pick(KEYS);
	const e = state.entries[keyId(key)];
	const text = pick(TEXTS);
	const otherRow = row({ ...c(pick(TEXTS)) }, Math.floor(r() * 6) + 1, {
		...key,
		lastWriter: r() < 0.3 ? TAB : "tab-other",
		state: r() < 0.2 ? "discarded" : "active",
	});
	const thread = { status: pick(["none", "listed", "deleted"] as const), firstTurnId: null, hasTurn: false };
	const roll = r();
	if (roll < 0.03) return { type: "OPEN_NEW", conversationId: pick(KEYS).conversationId };
	if (roll < 0.05) return { type: "OPEN_ARTIFACT_NEW", conversationId: pick(KEYS).conversationId, artifactId: "art" };
	if (roll < 0.08) return { type: "SELECT", key, thread: pick(["none", "listed"] as const) };
	if (roll < 0.1) return { type: "SCOPE_CHANGE", scope: pick([SCOPE_A, SCOPE_B]) };
	if (roll < 0.14) return { type: "PAGE_ORG", orgId: pick([ORG_A, ORG_B, null]) };
	if (roll < 0.145) return { type: "VIEWER_CHANGE", viewerId: pick(["viewer-1", "viewer-2"]) };
	const epoch = (e?.epoch ?? 0) + (r() < 0.75 ? 0 : pick([-1, 1]));
	const events: DraftEntryEvent[] = [
		{ type: "EDIT", epoch, content: { text, mentions: [] } },
		{ type: "EDIT", epoch, content: { text, mentions: [] } },
		{ type: "SAVE_TRIGGER", reason: pick(["timer", "blur", "hidden", "retry", "online", "before-submit"] as const) },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "saved", revision: Math.floor(r() * 6) + 1 } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "conflict", row: otherRow, thread } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "discarded", row: otherRow, thread } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "claimed", row: otherRow, thread } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "gone", thread } },
		{ type: "SAVE_RESULT", seq: seq(), result: pick([
			{ outcome: "limit" }, { outcome: "invalid" }, { outcome: "unauthorized" }, { outcome: "forbidden" },
			{ outcome: "scope-changed", reason: "other-org" }, { outcome: "scope-changed", reason: "address", slug: "s" },
			{ outcome: "rate-limited" }, { outcome: "unavailable" },
		] as const) },
		{ type: "RESTORE_RESULT", seq: seq(), result: { outcome: "saved", revision: Math.floor(r() * 6) + 1 } },
		{ type: "WRITE_REJECTED", seq: seq(), rejection: { network: r() < 0.5 } },
		{ type: "CONFLICT_KEEP_MINE" },
		{ type: "CONFLICT_USE_THEIRS" },
		{ type: "CONFLICT_RESTORE" },
		{ type: "CONFLICT_LET_GO" },
		{ type: "NOT_LISTED", seq: seq() },
		{ type: "CREDENTIAL_ACK" },
		{ type: "UNBLOCK", reason: pick(["signed-in", "limit-freed"] as const) },
		{ type: "TRANSCRIPT_LOADED" },
	];
	return { type: "ENTRY", key, event: pick(events) };
}

/** The texts an entry still holds anywhere: unsaved, acknowledged, or in an open conflict's row. */
function heldTexts(e: DraftEntry | undefined): string[] {
	if (e === undefined) return [];
	const out: string[] = [];
	if (e.local !== null) out.push(e.local.text);
	if (e.server !== null) out.push(e.server.content.text);
	if (e.conflict?.row) out.push(e.conflict.row.content.text);
	return out;
}

/** The entry event of a store event, if it is one. */
function entryEvent(ev: DraftsEvent): DraftEntryEvent | null {
	return ev.type === "ENTRY" ? ev.event : null;
}

/** True when `ev` is one of I3's listed word-removing events for that key's answer. */
function isListedRemoval(ev: DraftsEvent, key: DraftKey): boolean {
	if (ev.type === "VIEWER_CHANGE") return true; // D25
	if (ev.type !== "ENTRY" || keyId(ev.key) !== keyId(key)) return false;
	const x = ev.event;
	return (
		x.type === "CONFLICT_USE_THEIRS" || // D15
		x.type === "CONFLICT_LET_GO" || // D16
		x.type === "NOT_LISTED" || // D19L
		((x.type === "SAVE_RESULT" || x.type === "RESTORE_RESULT") && x.result.outcome === "gone") // D19
	);
}

/** How often the generator reached each interesting case, so a vacuous run cannot pass. */
const reached = { staleEdit: 0, unsavedKept: 0, ack: 0, conflictOpened: 0, credentialHeld: 0, removed: 0 };

/** Runs the generator for `seed` and checks every property at every step. */
function runSeed(seed: number, steps: number): void {
	const r = rng(seed);
	const boxModel = new Map<string, string>();
	let n = 0;
	const seq = () => (n += 1);
	let state = reduceDrafts(initialDraftsState("viewer-1"), { type: "SCOPE_CHANGE", scope: SCOPE_A }, ENV).state;
	state = reduceDrafts(state, { type: "PAGE_ORG", orgId: ORG_A }, ENV).state;
	for (const k of KEYS) state = { ...state, entries: { ...state.entries, [keyId(k)]: newEntry(k, "none") } };
	for (let i = 0; i < steps; i += 1) {
		const ev = randomEvent(r, state, seq);
		// A failure names its seed, step and event; the label is built only when a check fails, so a
		// green run pays for no JSON (this loop runs 45,000 steps under coverage on a shared CI runner).
		const check = (ok: boolean, what: string): void => {
			if (!ok) throw new Error(`seed ${seed} step ${i} ${JSON.stringify(ev)}: ${what}`);
		};
		const t = reduceDrafts(state, ev, ENV);
		const x = entryEvent(ev);
		// I5, model-based: what the box shows is the last applied EDIT, unless a listed event replaced
		// it from outside (the epoch moved) or the entry is new to this step.
		for (const [id, after] of Object.entries(t.state.entries)) {
			const before = state.entries[id];
			const shown = shownContent(after).text;
			const own = ev.type === "ENTRY" && keyId(ev.key) === id;
			const model = boxModel.get(id);
			if (before === undefined || model === undefined || after.epoch !== before.epoch) {
				boxModel.set(id, shown);
				continue;
			}
			if (own && x?.type === "EDIT" && x.epoch === before.epoch && before.claiming === null) {
				const typed = normalizeDraftText(x.content.text);
				check(shown === typed, `box is not the edit just applied: ${JSON.stringify(shown)}`);
				boxModel.set(id, typed);
				continue;
			}
			check(shown === model, `box changed without an outside replacement: ${JSON.stringify(shown)} ≠ ${JSON.stringify(model)}`);
		}
		for (const id of [...boxModel.keys()]) if (t.state.entries[id] === undefined) boxModel.delete(id);
		for (const [id, before] of Object.entries(state.entries)) {
			const after = t.state.entries[id];
			const own = ev.type === "ENTRY" && keyId(ev.key) === id;
			// U › no event writes a key other than its own (AC17).
			if (ev.type === "ENTRY" && !own) check(after === before, "another key written");
			const listed = isListedRemoval(ev, before.key);
			const userEdit = own && x?.type === "EDIT";
			// I3: no event removes words except the listed ones.
			if (after === undefined) {
				reached.removed += 1;
				check(listed, "entry removed");
				continue;
			}
			if (!listed && !userEdit) {
				if (before.local !== null)
					check(heldTexts(after).includes(before.local.text), "unsaved words lost");
				// Only a server answer (or the user's choice of one) may replace the acknowledged row.
				const answer =
					x !== null &&
					(x.type === "SAVE_RESULT" || x.type === "RESTORE_RESULT" || x.type === "CONFLICT_KEEP_MINE" || x.type === "CONFLICT_RESTORE");
				if (!(own && answer)) check(after.server === before.server, "saved row replaced");
			}
			// I5: unsaved edits are never overwritten (only acknowledged, or replaced by the user's choice).
			if (before.local !== null && !listed && !userEdit) {
				const kept = after.local !== null && after.local.text === before.local.text;
				const acked = after.local === null && after.server?.content.text === before.local.text;
				check(kept || acked, "unsaved edit overwritten");
			}
			if (before.local !== null && own && x !== null && x.type !== "EDIT") reached.unsavedKept += 1;
			if (before.inflight !== null && after.inflight === null && after.server !== before.server) reached.ack += 1;
			if (before.conflict === null && after.conflict !== null) reached.conflictOpened += 1;
			if (before.blockedBy?.kind !== "credential" && after.blockedBy?.kind === "credential") reached.credentialHeld += 1;
			// I6: an EDIT with a stale epoch changes nothing; the epoch moves only on a listed replacement.
			if (own && x?.type === "EDIT" && x.epoch !== before.epoch) {
				reached.staleEdit += 1;
				check(after === before, "stale edit applied");
				check(t.effects.length === 0, "stale edit had effects");
			}
			const restore = own && x?.type === "CONFLICT_RESTORE"; // D16, in D6's list
			if (after.epoch !== before.epoch) check(listed || restore, "epoch moved");
		}
		// D36: no save ever carries a credential the key has not acknowledged.
		for (const fx of ofType(t.effects, "save")) {
			const e = t.state.entries[keyId(fx.key)];
			if (looksLikeCredential(fx.content.text))
				check(e?.credentialAck === true, "credential saved unasked");
		}
		state = t.state;
	}
}

describe("properties over the drafting events (seeded)", () => {
	// 300 seeds × 150 steps, in six batches so no single test carries the whole budget.
	for (let batch = 0; batch < 6; batch += 1) {
		const first = batch * 50 + 1;
		it(`no event removes words except the listed ones (I3); unsaved edits are never overwritten (I5); a stale-epoch edit is dropped (I6) — seeds ${first}-${first + 49}`, () => {
			expect(() => {
				for (let seed = first; seed < first + 50; seed += 1) runSeed(seed, 150);
			}).not.toThrow();
		});
	}

	it("the generator reached every case it checks (the batches above ran first)", () => {
		for (const [name, count] of Object.entries(reached)) expect(count, `reached ${name}`).toBeGreaterThan(20);
	});
});
