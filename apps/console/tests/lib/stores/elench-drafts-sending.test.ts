// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 7b: the sending half of the Elench drafts reducer, and the composed reducer. One
// test per transition, each citing its D-number; the U tests §11.6 names for this slice; and 7a's
// property tests of I3, I5 and I6 (plus AC17) run over EVERY event of both halves.
//
// The property tests use a seeded generator loop, as 7a's do: a failure names its seed and step.

import { describe, expect, it } from "vitest";
import type { TurnRefusal } from "@/lib/agent/turn-claims";
import { type DraftContent, normalizeDraftText } from "@/lib/elench/draft-content";
import type { DraftListEntry, DraftThread, ServerDraft } from "@/lib/elench/draft-outcomes";
import {
	type DraftsStore,
	type DraftsStoreEnv,
	type DraftsStoreEvent,
	initialDraftsStore,
	reduce,
	reduceEntry,
} from "@/lib/stores/elench-drafts/reducer";
import {
	EMPTY_CONTENT,
	keyId,
	newEntry,
	scopeId,
	shownContent,
} from "@/lib/stores/elench-drafts/reducer-drafting";
import {
	appendContent,
	type CachedDraft,
	classifyRouteFailure,
	type DraftSendEvent,
	type RouteFailure,
	restoreFromCache,
	type SendContext,
	type SendEffect,
} from "@/lib/stores/elench-drafts/reducer-sending";
import type {
	DraftClaiming,
	DraftEntry,
	DraftEntryEvent,
	DraftKey,
	DraftScope,
	DraftSending,
} from "@/lib/stores/elench-drafts/types";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const SCOPE_A: DraftScope = { orgId: ORG_A, projectId: null };
const SCOPE_B: DraftScope = { orgId: ORG_B, projectId: null };
const K: DraftKey = { ...SCOPE_A, conversationId: "c-1" };
const TAB = "tab-1";
const NOW = "2026-10-09T00:00:00.000Z";
const FRESH = { attempt: "att-new", token: "tok-new", turnId: "turn-new", conversationId: "fork-1" };
const CTX: SendContext = {
	pageOrg: ORG_A,
	tabId: TAB,
	active: true,
	now: NOW,
	fresh: FRESH,
	mounted: true,
	fence: null,
};
const ENV: DraftsStoreEnv = { tabId: TAB, now: NOW, fresh: FRESH, mounted: true };

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

/** A thread read. */
function thread(over: Partial<DraftThread> = {}): DraftThread {
	return { status: "listed", firstTurnId: null, hasTurn: false, ...over };
}

/** An entry of key K with the given fields. */
function entry(over: Partial<DraftEntry> = {}): DraftEntry {
	return { ...newEntry(K, "none"), ...over };
}

/** A listed, loaded entry whose row holds `text` at revision 3. */
function listedEntry(text = "deploy", over: Partial<DraftEntry> = {}): DraftEntry {
	return entry({ thread: "listed", transcript: "loaded", server: row(c(text), 3), ...over });
}

/** A pending claim. */
function claimingOf(kind: "first" | "later", content: DraftContent = c("hello")): DraftClaiming {
	return { attempt: "att-1", token: "tok-1", turnId: "turn-1", kind, content };
}

/** A send this tab owns. */
function sendingOf(over: Partial<DraftSending> = {}): DraftSending {
	return {
		attempt: "att-1",
		token: "tok-1",
		turnId: "turn-1",
		kind: "later",
		text: "deploy",
		mentions: [],
		cellTarget: null,
		origin: "composer",
		at: 0,
		phase: "routing",
		...over,
	};
}

/** Reduces one key event through the composed reducer. */
function step(e: DraftEntry, ev: DraftEntryEvent | DraftSendEvent, ctx: SendContext = CTX) {
	return reduceEntry(e, ev, ctx);
}

/** Reduces, and fails the test when the entry was removed or forked. */
function stay(e: DraftEntry, ev: DraftEntryEvent | DraftSendEvent, ctx: SendContext = CTX): DraftEntry {
	const t = step(e, ev, ctx);
	if (t.entry === null || t.fork !== undefined) throw new Error("entry removed or forked");
	return t.entry;
}

/** The effects of one type. */
function ofType<T extends SendEffect["type"]>(effects: SendEffect[], type: T) {
	return effects.filter((x): x is Extract<SendEffect, { type: T }> => x.type === type);
}

/** The notices among `effects`. */
function notices(effects: SendEffect[]): string[] {
	return ofType(effects, "notice").map((x) => x.notice);
}

/** A typed route refusal. */
function refusal(code: TurnRefusal["refusal"], committed: boolean, textCommitted = committed): RouteFailure {
	const status = code === "thread-deleted" ? 410 : code === "org-forbidden" ? 403 : code.endsWith("not-found") ? 404 : 409;
	return {
		kind: "status",
		status,
		refusal: { refusal: code, turnId: "turn-1", committed, textCommitted, answered: false, revision: null, answerId: null },
	};
}

/** A store showing scope A on org A's page, holding `entries`. */
function storeWith(...entries: DraftEntry[]): DraftsStore {
	let s = reduce(initialDraftsStore("viewer-1"), { type: "SCOPE_CHANGE", scope: SCOPE_A }, ENV).state;
	s = reduce(s, { type: "PAGE_ORG", orgId: ORG_A }, ENV).state;
	for (const e of entries) s = { ...s, entries: { ...s.entries, [keyId(e.key)]: e } };
	if (entries[0] !== undefined) s = { ...s, activeKey: { ...s.activeKey, [scopeId(SCOPE_A)]: entries[0].key.conversationId } };
	return s;
}

// ── D9 / D9a / D10 / D10z: SUBMIT ────────────────────────────────────────────────────────────────

describe("D9 / D9a / D10 / D10z SUBMIT", () => {
	it("D9 › a listed, loaded thread claims the box at its revision as a later turn; the box is read-only", () => {
		const t = step(listedEntry("deploy", { local: c("deploy now") }), { type: "SUBMIT", chatReady: true });
		expect(t.entry?.claiming).toEqual({ attempt: "att-new", token: "tok-new", turnId: "turn-new", kind: "later", content: c("deploy now") });
		expect(t.entry?.local).toBeNull();
		expect(ofType(t.effects, "claim")).toEqual([
			{ type: "claim", key: K, attempt: "att-new", base: 3, content: c("deploy now"), turnId: "turn-new", token: "tok-new", kind: "later" },
		]);
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("deploy now");
		expect(step(t.entry, { type: "EDIT", epoch: t.entry.epoch, content: { text: "x", mentions: [] } }).entry).toBe(t.entry);
	});

	it("D9 / D31 › a released send's turn id is reused, so a re-send names one turn", () => {
		const failed = row(c("deploy"), 3, { failedSend: { turnId: "turn-old", kind: "later", error: "x", at: NOW, uncertain: true } });
		const t = step(listedEntry("deploy", { server: failed }), { type: "SUBMIT", chatReady: true });
		expect(t.entry?.claiming?.turnId).toBe("turn-old");
	});

	it("D9 › a released send whose text was edited (not yet saved) is re-sent under a FRESH turn id", () => {
		const failed = row(c("deploy"), 3, { failedSend: { turnId: "turn-old", kind: "later", error: "x", at: NOW, uncertain: false } });
		const edited = listedEntry("deploy", { server: failed, local: c("deploy now") });
		expect(step(edited, { type: "SUBMIT", chatReady: true }).entry?.claiming?.turnId).toBe(FRESH.turnId);
		// The same text, unedited, still names the failed turn.
		expect(step(listedEntry("deploy", { server: failed }), { type: "SUBMIT", chatReady: true }).entry?.claiming?.turnId).toBe("turn-old");
	});

	it("D9a › a stored thread whose transcript is not loaded is loaded, and nothing is claimed", () => {
		const e = listedEntry("deploy", { transcript: "unloaded" });
		const t = step(e, { type: "SUBMIT", chatReady: true });
		expect(t.entry?.claiming).toBeNull();
		expect(t.entry?.transcript).toBe("loading");
		expect(t.effects).toEqual([{ type: "load-transcript", key: K }, { type: "notice", key: K, notice: "transcript-shown" }]);
	});

	it("D10 › a conversation with no thread claims as a first turn", () => {
		const t = step(entry({ local: c("hi") }), { type: "SUBMIT", chatReady: false });
		expect(t.entry?.claiming?.kind).toBe("first");
		expect(ofType(t.effects, "claim")[0]?.base).toBe(0);
	});

	it("D10z › while a claim or a send is live, Enter is refused", () => {
		for (const e of [entry({ claiming: claimingOf("first") }), listedEntry("x", { sending: sendingOf() })]) {
			const t = step(e, { type: "SUBMIT", chatReady: true });
			expect(t.entry).toBe(e);
			expect(notices(t.effects)).toEqual(["wait-for-send"]);
		}
	});

	it("D9 › an empty box sends nothing and says so; a busy chat (R3) or another org's page (D29) sends nothing", () => {
		expect(notices(step(listedEntry(""), { type: "SUBMIT", chatReady: true }).effects)).toEqual(["empty-box"]);
		expect(step(listedEntry("x"), { type: "SUBMIT", chatReady: false }).effects).toEqual([]);
		expect(step(listedEntry("x"), { type: "SUBMIT", chatReady: true }, { ...CTX, pageOrg: ORG_B }).effects).toEqual([]);
	});

	it("D9 › Enter while a save flies claims after its answer, at the base it acknowledged", () => {
		const e = listedEntry("a", { local: c("ab"), save: "saving", inflight: { op: "save", base: 3, content: c("ab"), failedSend: null } });
		const t1 = step(e, { type: "SUBMIT", chatReady: true });
		expect(ofType(t1.effects, "claim")).toEqual([]);
		if (t1.entry === null) throw new Error("removed");
		const t2 = step(t1.entry, { type: "SAVE_RESULT", seq: 1, result: { outcome: "saved", revision: 4 } });
		expect(ofType(t2.effects, "claim").map((x) => [x.base, x.content.text])).toEqual([[4, "ab"]]);
	});
});

// ── D9b / D10b / D10c: the claim's answer ────────────────────────────────────────────────────────

describe("D9b / D10b / D10c the claim's answer", () => {
	it("D9b › claimed-by-you: the box empties and the turn is sent with turnId as the message id, the claimed text trimmed", () => {
		const e = listedEntry("x", { claiming: claimingOf("later", c("  deploy now\n")) });
		const t = step(e, { type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result: { outcome: "claimed-by-you", revision: 4, content: c("  deploy now\n") } });
		expect(t.entry?.sending).toMatchObject({ token: "tok-1", turnId: "turn-1", phase: "routing", text: "  deploy now\n" });
		expect(t.entry?.server?.state).toBe("sending");
		expect(t.entry?.epoch).toBe(e.epoch + 1);
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry)).toEqual(EMPTY_CONTENT);
		expect(ofType(t.effects, "send-message")).toEqual([
			{ type: "send-message", key: K, turnId: "turn-1", text: "deploy now", mentions: [], cellTarget: null },
		]);
	});

	it("D9b › the cell target sent is the CLAIMED content's, never another source's (D10f's Retry carries it)", () => {
		const claimed: DraftContent = { ...c("make a chart"), cellTarget: { x: 1, y: 2 } };
		const e = listedEntry("x", {
			server: row({ ...c("make a chart"), cellTarget: { x: 4, y: 9 } }, 3),
			claiming: claimingOf("later", claimed),
		});
		const t = step(e, { type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result: { outcome: "claimed-by-you", revision: 4, content: claimed } });
		expect(ofType(t.effects, "send-message").map((x) => x.cellTarget)).toEqual([{ x: 1, y: 2 }]);
		// An ordinary composer turn carries none.
		const plain = step(listedEntry("x", { claiming: claimingOf("later") }), {
			type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result: { outcome: "claimed-by-you", revision: 4, content: c("hello") },
		});
		expect(ofType(plain.effects, "send-message").map((x) => x.cellTarget)).toEqual([null]);
	});

	it("D10b › a first claim starts the conversation from the frozen row (no text on the wire)", () => {
		const t = step(entry({ claiming: claimingOf("first") }), { type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result: { outcome: "claimed-by-you", revision: 1, content: c("hello") } });
		expect(t.entry?.sending?.phase).toBe("starting");
		expect(ofType(t.effects, "start")).toEqual([
			{ type: "start", key: K, attempt: "att-1", turnId: "turn-1", revision: 1, origin: "composer", token: "tok-1", prompt: null },
		]);
	});

	it("every claim outcome × SUBMIT: only claimed-by-you starts, and every other answer keeps the words (D10c, G27)", () => {
		const other = row(c("theirs"), 5, { claim: { token: "tok-x", turnId: "turn-x", kind: "later", claimedAt: NOW }, state: "sending" });
		const outcomes = [
			{ outcome: "claimed", row: other, thread: thread() },
			{ outcome: "conflict", row: row(c("theirs"), 5), thread: thread() },
			{ outcome: "discarded", row: row(c("theirs"), 5, { state: "discarded", discardedAt: NOW }), thread: thread() },
			{ outcome: "gone", thread: thread({ status: "deleted" }) },
			{ outcome: "wrong-kind", thread: thread() },
			{ outcome: "empty" },
			{ outcome: "limit" },
			{ outcome: "invalid" },
			{ outcome: "unauthorized" },
			{ outcome: "forbidden", reason: "membership" },
			{ outcome: "scope-changed", reason: "other-org" },
			{ outcome: "scope-changed", reason: "address", slug: "s" },
			{ outcome: "rate-limited" },
			{ outcome: "unavailable" },
		] as const;
		for (const result of outcomes) {
			const e = entry({ server: row(c("old"), 2), claiming: claimingOf("first") });
			const t = step(e, { type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result });
			if (t.entry === null) throw new Error("removed");
			const held = t.fork !== undefined ? t.fork.content.text : shownContent(t.entry).text;
			const said = result.outcome === "gone" || notices(t.effects).includes("not-sent");
			expect({
				outcome: result.outcome,
				sent: [...ofType(t.effects, "start"), ...ofType(t.effects, "send-message")],
				claiming: t.entry.claiming,
				held,
				said,
			}).toEqual({ outcome: result.outcome, sent: [], claiming: null, held: "hello", said: true });
		}
	});

	it("D10c / D32 › a claim that times out is abandoned and released, because it may have landed", () => {
		const t = step(entry({ claiming: claimingOf("first") }), { type: "CLAIM_FAILED", attempt: "att-1", seq: 1, failure: { kind: "timeout" } });
		expect(t.entry?.local).toEqual(c("hello"));
		expect(t.entry?.abandoned).toEqual(["tok-1"]);
		expect(ofType(t.effects, "release")).toMatchObject([{ token: "tok-1", uncertain: false, retry: 0 }]);
	});

	it("D33 › the abandoned claim's release answers released: the token leaves `abandoned`, the words stay once", () => {
		const e = entry({ local: c("hello"), abandoned: ["tok-1"] });
		const t = step(e, { type: "RELEASE_RESULT", token: "tok-1", seq: 2, retry: 0, result: { outcome: "released", row: row(c("hello"), 4) } });
		expect(t.entry?.abandoned).toEqual([]);
		expect(t.entry?.local).toBeNull();
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("hello");
	});

	it("a late claim answer for another attempt changes nothing", () => {
		const e = entry({ claiming: claimingOf("first") });
		expect(step(e, { type: "CLAIM_RESULT", attempt: "att-0", seq: 1, result: { outcome: "empty" } }).entry).toBe(e);
	});
});

// ── D9c / D9d / D20: the route ───────────────────────────────────────────────────────────────────

describe("D9c the hand-off", () => {
	const sending = listedEntry("x", { sending: sendingOf(), server: row(c("deploy"), 4, { state: "sending" }) });

	it("D9c › streaming consumes the claim; consumed empties the row and text typed meanwhile saves at r", () => {
		const t1 = step({ ...sending, local: c("more") }, { type: "ROUTE_HANDOFF", turnId: "turn-1" });
		expect(t1.entry?.sending?.phase).toBe("consuming");
		expect(ofType(t1.effects, "consume")).toEqual([{ type: "consume", key: K, token: "tok-1", retry: 0, delayMs: 0 }]);
		if (t1.entry === null) throw new Error("removed");
		const t2 = step(t1.entry, { type: "CONSUME_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "consumed", revision: 5 } });
		expect(t2.entry?.sending).toBeNull();
		expect(t2.entry?.server).toMatchObject({ revision: 5, state: "active", content: EMPTY_CONTENT, lastSent: { turnId: "turn-1" } });
		expect(ofType(t2.effects, "save").map((x) => [x.base, x.content.text])).toEqual([[5, "more"]]);
	});

	it("consume after the lease released a silent claim: the copy-came-back bar, nothing sent (D9c)", () => {
		const consuming = { ...sending, sending: sendingOf({ phase: "consuming" }) };
		const copy = row(c("deploy"), 6, { failedSend: { turnId: "turn-1", kind: "later", error: "lease", at: NOW, uncertain: true } });
		const t = step(consuming, { type: "CONSUME_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "not-claimed", row: copy, thread: thread() } });
		expect(t.entry?.conflict).toEqual({ kind: "uncertain", row: copy });
		expect(t.entry?.sending).toBeNull();
		for (const type of ["send-message", "claim", "save", "start"] as const) expect(ofType(t.effects, type)).toEqual([]);
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("deploy");
		// Discard the copy: the copy is saved away with the marker dismissed.
		const d = step(t.entry, { type: "COPY_DISCARD" });
		expect(ofType(d.effects, "dismiss-failed-send")).toEqual([{ type: "dismiss-failed-send", key: K, base: 6, content: EMPTY_CONTENT }]);
	});

	it("D9 › Enter while D9c's copy-came-back bar is open claims nothing: only D31's card (no row) allows Enter", () => {
		const consuming = { ...sending, sending: sendingOf({ phase: "consuming" }) };
		const copy = row(c("deploy"), 6, { failedSend: { turnId: "turn-1", kind: "later", error: "lease", at: NOW, uncertain: true } });
		const bar = stay(consuming, { type: "CONSUME_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "not-claimed", row: copy, thread: thread() } });
		const t = step(bar, { type: "SUBMIT", chatReady: true });
		expect(ofType(t.effects, "claim")).toEqual([]);
		expect(t.entry?.claiming).toBeNull();
	});

	it("D9c › not-claimed whose last_sent names this turn is the consumed arm", () => {
		const consuming = { ...sending, sending: sendingOf({ phase: "consuming" }) };
		const sent = row(EMPTY_CONTENT, 6, { lastSent: { turnId: "turn-1", kind: "later", at: NOW } });
		const t = step(consuming, { type: "CONSUME_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "not-claimed", row: sent, thread: thread() } });
		expect(t.entry?.sending).toBeNull();
		expect(t.entry?.conflict).toBeNull();
		expect(t.entry?.server).toBe(sent);
	});

	it("D32 › a consume that is refused or fails is retried with D27's backoff", () => {
		const consuming = { ...sending, sending: sendingOf({ phase: "consuming" }) };
		expect(ofType(step(consuming, { type: "CONSUME_FAILED", token: "tok-1", seq: 3, retry: 0, failure: { kind: "timeout" } }).effects, "consume")).toEqual([
			{ type: "consume", key: K, token: "tok-1", retry: 1, delayMs: 1000 },
		]);
		expect(ofType(step(consuming, { type: "CONSUME_RESULT", token: "tok-1", seq: 3, retry: 2, result: { outcome: "unavailable" } }).effects, "consume")[0]?.delayMs).toBe(4000);
	});
});

describe("D9d a later turn fails before streaming", () => {
	const routing = listedEntry("x", { sending: sendingOf(), server: row(c("deploy"), 4, { state: "sending" }) });

	/** The route fails; returns the transition. */
	const fail = (failure: RouteFailure, e: DraftEntry = routing) => step(e, { type: "ROUTE_FAILED", turnId: "turn-1", failure });

	it("D9d (a) › 401 and 503 before streaming release certain: Not sent, never may-already-have-been-sent (B5)", () => {
		for (const status of [400, 401, 402, 413, 503]) {
			const t = fail({ kind: "status", status, refusal: null });
			expect(t.effects[0]).toEqual({ type: "remove-optimistic", key: K, turnId: "turn-1" });
			expect(ofType(t.effects, "release")).toMatchObject([{ token: "tok-1", uncertain: false, freshTurnId: null }]);
			expect(t.entry?.sending?.phase).toBe("releasing");
			if (t.entry === null) throw new Error("removed");
			// Nothing goes back into the box until the release is definitive (G31).
			expect(shownContent(t.entry).text).toBe("");
		}
	});

	it("transcript-stale, thread-busy, client-outdated, 410, 404 and 403 release certain: no may-already-have-been-sent card (D9d (a), change 2)", () => {
		const codes = ["transcript-stale", "thread-busy", "client-outdated", "thread-deleted", "thread-not-found", "project-not-found", "org-forbidden"] as const;
		for (const code of codes) {
			const t = fail(refusal(code, false));
			expect([code, classifyRouteFailure(refusal(code, false)), ofType(t.effects, "release").map((x) => x.uncertain)]).toEqual([code, "certain", [false]]);
		}
		const stale = fail(refusal("transcript-stale", false));
		expect(ofType(stale.effects, "load-transcript")).toHaveLength(1);
		expect(notices(stale.effects)).toContain("transcript-shown");
		// The release answers: the words come back with Not sent, never with D31's card.
		if (stale.entry === null) throw new Error("removed");
		const back = step(stale.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 5, retry: 0, result: {
			outcome: "released", row: row(c("deploy"), 5, { failedSend: { turnId: "turn-1", kind: "later", error: "transcript-stale", at: NOW, uncertain: false } }),
		} });
		expect(back.entry?.conflict).toBeNull();
		expect(notices(back.effects)).toEqual(["not-sent"]);
		if (back.entry === null) throw new Error("removed");
		expect(shownContent(back.entry).text).toBe("deploy");
	});

	it("D9d (b) › Stop, the deadline, a network error, 500, 502 and 504 release uncertain, and the box shows D31's card", () => {
		const failures: RouteFailure[] = [
			{ kind: "stop" }, { kind: "deadline" }, { kind: "network" },
			{ kind: "status", status: 500, refusal: null }, { kind: "status", status: 502, refusal: null }, { kind: "status", status: 504, refusal: null },
		];
		for (const failure of failures) {
			expect(classifyRouteFailure(failure)).toBe("uncertain");
			expect(ofType(fail(failure).effects, "release")).toMatchObject([{ uncertain: true }]);
		}
		const t = fail({ kind: "status", status: 500, refusal: null });
		if (t.entry === null) throw new Error("removed");
		const back = step(t.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 5, retry: 0, result: {
			outcome: "released", row: row(c("deploy"), 5, { failedSend: { turnId: "turn-1", kind: "later", error: "status-500", at: NOW, uncertain: true } }),
		} });
		expect(back.entry?.conflict).toEqual({ kind: "uncertain", row: null });
		expect(notices(back.effects)).not.toContain("not-sent");
	});

	it("turn-in-progress consumes, loads the transcript and polls until inFlight is null (D9d (c), D20)", () => {
		const t = fail(refusal("turn-in-progress", true));
		expect(ofType(t.effects, "release")).toEqual([]);
		expect(ofType(t.effects, "consume")).toEqual([{ type: "consume", key: K, token: "tok-1", retry: 0, delayMs: 0 }]);
		expect(ofType(t.effects, "load-transcript")).toHaveLength(1);
		expect(ofType(t.effects, "poll-thread")).toHaveLength(1);
		expect(notices(t.effects)).toEqual(["being-answered"]);
		expect(t.entry?.sending?.phase).toBe("consuming");
		expect(ofType(fail(refusal("turn-answered", true)).effects, "poll-thread")).toEqual([]);
	});

	it("D9d (d) › turn-committed-different-text releases under a fresh turn id, never consumes, and loads the stored turn", () => {
		const t = fail(refusal("turn-committed-different-text", true, false));
		expect(ofType(t.effects, "consume")).toEqual([]);
		expect(ofType(t.effects, "release")).toMatchObject([{ freshTurnId: "turn-new", uncertain: false }]);
		expect(ofType(t.effects, "load-transcript")).toHaveLength(1);
		expect(notices(t.effects)).toContain("earlier-version-sent");
		if (t.entry === null) throw new Error("removed");
		// The release keeps the edit under the fresh id; Enter then sends it as a new turn.
		// S4 keeps the claimed text in the row, so the released row holds exactly the sent words.
		const fresh = row(c(t.entry.sending?.text ?? ""), 5, { failedSend: { turnId: "turn-new", kind: "later", error: "x", at: NOW, uncertain: false } });
		const back = stay({ ...t.entry, transcript: "loaded" }, { type: "RELEASE_RESULT", token: "tok-1", seq: 5, retry: 0, result: { outcome: "released", row: fresh } });
		const again = step(back, { type: "SUBMIT", chatReady: true }, { ...CTX, fresh: { ...FRESH, turnId: "turn-other" } });
		expect(again.entry?.claiming?.turnId).toBe("turn-new");
	});

	it("D18 › a later turn refused thread-deleted moves into a new conversation once the release lands", () => {
		const t = fail(refusal("thread-deleted", false));
		expect(t.entry?.thread).toBe("deleted");
		if (t.entry === null) throw new Error("removed");
		const back = step(t.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 5, retry: 0, result: { outcome: "released", row: row(c("deploy"), 5) } });
		expect(back.fork).toEqual({ content: c("deploy"), discard: 5, notice: "kept-in-new-deleted" });
	});
});

// ── D11 / D11r / D11c / D11n / D11t / D12 / D13 / D17 ───────────────────────────────────────────

describe("D11 / D12 / D13 / D17 a first send", () => {
	const starting = entry({ sending: sendingOf({ kind: "first", phase: "starting", text: "hello" }), server: row({ ...c("hello"), artifacts: ["art"] }, 1, { state: "sending" }) });

	it("D12 › created: the row empties, the thread is listed and loaded, threadRevision seeds the transport, and the one turn is pushed", () => {
		const t = step(starting, { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "created", revision: 2, threadRevision: 1 } });
		expect(t.entry).toMatchObject({ sending: null, thread: "listed", transcript: "loaded" });
		expect(t.entry?.server).toMatchObject({ revision: 2, content: EMPTY_CONTENT, state: "active" });
		expect(ofType(t.effects, "thread-revision")).toEqual([{ type: "thread-revision", key: K, revision: 1 }]);
		// D12's metadata is `{ mentions }` only: the stored first turn already carries its cell target.
		expect(ofType(t.effects, "send-message").map((x) => [x.turnId, x.cellTarget])).toEqual([["turn-1", null]]);
		expect(ofType(t.effects, "place-artifacts")).toEqual([{ type: "place-artifacts", key: K, artifacts: ["art"] }]);
	});

	it("created seeds the transport's base revision with threadRevision; an unmounted key sends nothing (D12)", () => {
		const t = step(starting, { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "created", revision: 2, threadRevision: 7 } }, { ...CTX, active: false });
		expect(ofType(t.effects, "thread-revision")[0]?.revision).toBe(7);
		expect(ofType(t.effects, "send-message")).toEqual([]);
	});

	it("D13 › already-stored loads and never sends", () => {
		const t = step(starting, { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "already-stored", revision: 2 } });
		expect(ofType(t.effects, "send-message")).toEqual([]);
		expect(ofType(t.effects, "load-transcript")).toHaveLength(1);
	});

	it("D11 › a rejected start releases by token, and nothing goes back in the box yet (G31)", () => {
		const t = step(starting, { type: "START_FAILED", attempt: "att-1", seq: 2, failure: { kind: "rejected", network: true } });
		expect(t.entry?.sending?.phase).toBe("releasing");
		expect(ofType(t.effects, "release")).toMatchObject([{ token: "tok-1", uncertain: false }]);
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("");
	});

	it("a start that never answers: after 30 s the release is sent, and a late created answer is ignored (G32)", () => {
		const t = stay(starting, { type: "START_FAILED", attempt: "att-1", seq: 2, failure: { kind: "timeout" } });
		const late = step(t, { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "created", revision: 2, threadRevision: 1 } });
		expect(late.entry).toBe(t);
		expect(late.effects).toEqual([]);
	});

	it("D11r › released: the words come back, followed by text typed after the claim, saved at the row's revision", () => {
		const releasing = { ...starting, local: c("more"), sending: sendingOf({ kind: "first", phase: "releasing", text: "hello" }) };
		const t = step(releasing, { type: "RELEASE_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "released", row: row(c("hello"), 2) } });
		expect(t.entry?.local?.text).toBe("hello\n\nmore");
		expect(t.entry?.epoch).toBe(releasing.epoch + 1);
		expect(ofType(t.effects, "save").map((x) => x.base)).toEqual([2]);
		expect(notices(t.effects)).toContain("not-sent");
	});

	it("D11c / D17 › not-claimed proving the start committed: the box holds only the later text, the transcript loads", () => {
		const releasing = { ...starting, local: c("more"), sending: sendingOf({ kind: "first", phase: "releasing", text: "hello" }) };
		const t = step(releasing, { type: "RELEASE_RESULT", token: "tok-1", seq: 3, retry: 0, result: {
			outcome: "not-claimed", row: row(EMPTY_CONTENT, 2), thread: thread({ firstTurnId: "turn-1" }),
		} });
		expect(t.entry).toMatchObject({ sending: null, thread: "listed", transcript: "loading" });
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("more");
		expect(notices(t.effects)).toContain("first-sent-more-in-box");
		expect(ofType(t.effects, "send-message")).toEqual([]);
	});

	it("D11n › not-claimed that proves nothing is as D11r with the returned row", () => {
		const releasing = { ...starting, sending: sendingOf({ kind: "first", phase: "releasing", text: "hello" }) };
		const t = step(releasing, { type: "RELEASE_RESULT", token: "tok-1", seq: 3, retry: 0, result: { outcome: "not-claimed", row: row(c("hello"), 2), thread: thread({ status: "none" }) } });
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("hello");
	});

	it("a release that keeps failing retries with backoff and the cache keeps the token (D11t)", () => {
		const releasing = { ...starting, sending: sendingOf({ kind: "first", phase: "releasing", text: "hello" }) };
		const t1 = step(releasing, { type: "RELEASE_FAILED", token: "tok-1", seq: 3, retry: 0, failure: { kind: "timeout" } });
		expect(t1.entry?.abandoned).toEqual(["tok-1"]);
		expect(ofType(t1.effects, "release")).toMatchObject([{ retry: 1, delayMs: 1000 }]);
		expect(ofType(t1.effects, "cache-remove")).toEqual([]);
		if (t1.entry === null) throw new Error("removed");
		const t2 = step(t1.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 4, retry: 1, result: { outcome: "unavailable" } });
		expect(ofType(t2.effects, "release")).toMatchObject([{ retry: 2, delayMs: 2000 }]);
		expect(t2.entry?.abandoned).toEqual(["tok-1"]);
	});

	it("no transition puts sending.text into the box except D11r (G31)", () => {
		// A first send, every non-release answer: the box never shows "hello".
		const answers: DraftSendEvent[] = [
			{ type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "created", revision: 2, threadRevision: 1 } },
			{ type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "already-stored", revision: 2 } },
			{ type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "unavailable" } },
			{ type: "START_FAILED", attempt: "att-1", seq: 2, failure: { kind: "timeout" } },
			{ type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "not-claimed", row: row(c("hello"), 2), thread: thread({ status: "none" }) } },
			{ type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "not-claimed", row: row(EMPTY_CONTENT, 2), thread: thread({ firstTurnId: "turn-1" }) } },
		];
		for (const ev of answers) {
			const t = step(starting, ev);
			if (t.entry === null) throw new Error("removed");
			expect([ev.type, shownContent(t.entry).text.includes("hello")]).toEqual([ev.type, false]);
		}
	});
});

// ── D34 / D35: the heartbeat ─────────────────────────────────────────────────────────────────────

describe("D34 / D35 the heartbeat's answer", () => {
	const lapsed = row(c("deploy"), 6, { failedSend: { turnId: "turn-1", kind: "later", error: "lease", at: NOW, uncertain: true } });

	it("D34 › touched changes nothing: a claim held through a long action-queue stall stays held (R0)", () => {
		let e = listedEntry("x", { sending: sendingOf() });
		for (let i = 0; i < 5; i += 1) e = stay(e, { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "touched" } });
		expect(e.sending?.phase).toBe("routing");
	});

	it("D34 › in routing with the same token, not-claimed goes to the claim-outcome table (the lease released it: D11n)", () => {
		const t = step(listedEntry("x", { sending: sendingOf() }), { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "not-claimed", row: lapsed, thread: thread() } });
		expect(t.entry?.sending).toBeNull();
		expect(t.entry?.conflict).toEqual({ kind: "uncertain", row: null });
	});

	it("a heartbeat not-claimed that arrives while the start is in flight is dropped, and created sends the first turn once (B1')", () => {
		const starting = entry({ sending: sendingOf({ kind: "first", phase: "starting", text: "hello" }), server: row(c("hello"), 1, { state: "sending" }) });
		const hb = step(starting, { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "not-claimed", row: row(EMPTY_CONTENT, 2), thread: thread({ firstTurnId: "turn-1" }) } });
		expect(hb.entry).toBe(starting);
		expect(hb.effects).toEqual([]);
		const t = step(starting, { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "created", revision: 2, threadRevision: 1 } });
		expect(ofType(t.effects, "send-message")).toHaveLength(1);
	});

	it("a heartbeat answered not-claimed while claimDraft is still pending changes nothing, and the claim then sends once (B1')", () => {
		const claiming = listedEntry("x", { claiming: claimingOf("later") });
		const hb = step(claiming, { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "not-claimed", row: row(c("hello"), 3), thread: thread() } });
		expect(hb.entry).toBe(claiming);
		const t = step(claiming, { type: "CLAIM_RESULT", attempt: "att-1", seq: 1, result: { outcome: "claimed-by-you", revision: 4, content: c("hello") } });
		expect(ofType(t.effects, "send-message")).toHaveLength(1);
	});

	it("D34 › a heartbeat answer with another token, or in consuming or releasing, is dropped", () => {
		for (const phase of ["consuming", "releasing"] as const) {
			const e = listedEntry("x", { sending: sendingOf({ phase }) });
			expect(step(e, { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "not-claimed", row: lapsed, thread: thread() } }).entry).toBe(e);
		}
		const e = listedEntry("x", { sending: sendingOf() });
		expect(step(e, { type: "HEARTBEAT_RESULT", token: "tok-0", result: { outcome: "gone", thread: thread() } }).entry).toBe(e);
	});

	it("D35 › gone before the hand-off moves the words to a new conversation; after it, the text is the sent turn", () => {
		const routing = listedEntry("x", { sending: sendingOf(), local: c("more") });
		const before = step(routing, { type: "HEARTBEAT_RESULT", token: "tok-1", result: { outcome: "gone", thread: thread({ status: "deleted" }) } });
		expect(before.fork?.content.text).toBe("deploy\n\nmore");
		const consuming = listedEntry("x", { sending: sendingOf({ phase: "consuming" }) });
		const after = step(consuming, { type: "CONSUME_RESULT", token: "tok-1", seq: 2, retry: 0, result: { outcome: "gone", thread: thread({ status: "deleted" }) } });
		expect(after.fork).toBeUndefined();
		expect(after.entry?.sending).toBeNull();
		expect(after.entry?.server).toBeNull();
	});
});

// ── D10x / D10y / D10f: external sends ───────────────────────────────────────────────────────────

describe("D10x / D10y / D10f external sends", () => {
	const ext = (cellTarget: { x: number; y: number } | null = null): DraftSendEvent => ({
		type: "SUBMIT_EXTERNAL", text: "  add a node chart ", mentions: [], cellTarget, origin: "cell", chatReady: true,
	});

	it("SUBMIT_EXTERNAL in every state (G4)", () => {
		// D10x: no thread → a token-less start with the prompt; the box is untouched.
		const x = step(entry({ local: c("mine") }), ext());
		expect(x.entry?.sending).toMatchObject({ token: null, kind: "first", phase: "starting" });
		expect(ofType(x.effects, "start")[0]?.prompt?.text).toBe("  add a node chart ");
		if (x.entry === null) throw new Error("removed");
		expect(shownContent(x.entry).text).toBe("mine");
		// D10y: a listed, loaded thread → the route, no claim and no heartbeat token.
		const y = step(listedEntry("mine"), ext());
		expect(y.entry?.sending).toMatchObject({ token: null, kind: "later", phase: "routing" });
		expect(ofType(y.effects, "claim")).toEqual([]);
		// D9a first when the transcript is not loaded.
		expect(ofType(step(listedEntry("m", { transcript: "unloaded" }), ext()).effects, "load-transcript")).toHaveLength(1);
		// D10z while a claim or a send is live.
		expect(notices(step(entry({ claiming: claimingOf("first") }), ext()).effects)).toEqual(["wait-for-send"]);
		expect(notices(step(listedEntry("m", { sending: sendingOf() }), ext()).effects)).toEqual(["wait-for-send"]);
	});

	it("SUBMIT_EXTERNAL with a cellTarget into a listed thread sends it in the user message's metadata (D10y)", () => {
		const t = step(listedEntry("mine"), ext({ x: 2, y: 0 }));
		expect(ofType(t.effects, "send-message")).toEqual([
			{ type: "send-message", key: K, turnId: "turn-new", text: "add a node chart", mentions: [], cellTarget: { x: 2, y: 0 } },
		]);
	});

	it("D9c › an external send's hand-off has no claim to consume", () => {
		const y = stay(listedEntry("mine"), ext());
		const t = step(y, { type: "ROUTE_HANDOFF", turnId: "turn-new" });
		expect(t.entry?.sending).toBeNull();
		expect(ofType(t.effects, "consume")).toEqual([]);
	});

	it("SUBMIT_EXTERNAL into a listed thread refused transcript-stale: loads, and the prompt and its cell target are in the box (B2')", () => {
		const y = stay(listedEntry("mine"), ext({ x: 2, y: 0 }));
		const t = step(y, { type: "ROUTE_FAILED", turnId: "turn-new", failure: refusal("transcript-stale", false) });
		expect(ofType(t.effects, "remove-optimistic")).toHaveLength(1);
		expect(ofType(t.effects, "load-transcript")).toHaveLength(1);
		expect(t.entry?.local).toEqual({ ...c("  add a node chart \n\nmine"), cellTarget: { x: 2, y: 0 } });
		expect(t.entry?.pendingFailedSend).toEqual({ turnId: "turn-new", kind: "later", error: "transcript-stale", uncertain: false });
		expect(ofType(t.effects, "save")[0]?.failedSend).toEqual({ turnId: "turn-new", kind: "later", error: "transcript-stale", uncertain: false });
		expect(t.entry?.sending).toBeNull();
	});

	it("an external send that fails before streaming with a 5xx is in the box with the may-already-have-been-sent marker and the same turn id (B2')", () => {
		const y = stay(listedEntry("mine"), ext({ x: 2, y: 0 }));
		const t = step(y, { type: "ROUTE_FAILED", turnId: "turn-new", failure: { kind: "status", status: 502, refusal: null } });
		expect(t.entry?.pendingFailedSend).toMatchObject({ turnId: "turn-new", uncertain: true });
		expect(t.entry?.conflict).toEqual({ kind: "uncertain", row: null });
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).cellTarget).toEqual({ x: 2, y: 0 });
	});

	it("D10f › an external start answered not-claimed (no claim to read) keeps the prompt in the box", () => {
		const x = stay(entry({ server: row(c("mine"), 2) }), ext());
		const t = step(x, { type: "START_RESULT", attempt: "att-new", seq: 2, result: { outcome: "not-claimed", row: row(c("mine"), 2), thread: thread({ status: "none" }) } });
		expect(t.entry?.local?.text).toBe("  add a node chart \n\nmine");
		expect(t.entry?.pendingFailedSend?.turnId).toBe("turn-new");
	});

	it("D10f (c) › an external turn the route says is committed is not put back; D20 loads it", () => {
		const y = stay(listedEntry("mine"), ext());
		const t = step(y, { type: "ROUTE_FAILED", turnId: "turn-new", failure: refusal("turn-answered", true) });
		expect(t.entry?.sending).toBeNull();
		expect(t.entry?.local).toBeNull();
		expect(ofType(t.effects, "load-transcript")).toHaveLength(1);
	});

	it("an external start that times out is fenced by the save; a start that committed first is read as D17 and the prompt is not put back (B2')", () => {
		const x = stay(entry({ server: row(c("mine"), 2) }), ext());
		const t1 = step(x, { type: "START_FAILED", attempt: "att-new", seq: 2, failure: { kind: "timeout" } });
		const save = ofType(t1.effects, "save")[0];
		expect(save?.base).toBe(2);
		expect(save?.failedSend?.turnId).toBe("turn-new");
		expect(t1.fence).toMatchObject({ turnId: "turn-new", before: c("mine") });
		if (t1.entry === null || !t1.fence) throw new Error("no fence");
		// The fencing save loses to the start, which committed first.
		const t2 = step(t1.entry, { type: "SAVE_RESULT", seq: 3, result: { outcome: "conflict", row: row(c("mine"), 3), thread: thread({ firstTurnId: "turn-new" }) } }, { ...CTX, fence: t1.fence });
		expect(t2.entry?.local).toBeNull();
		expect(t2.entry?.pendingFailedSend).toBeNull();
		expect(t2.entry?.thread).toBe("listed");
		expect(t2.fence).toBeNull();
		if (t2.entry === null) throw new Error("removed");
		expect(shownContent(t2.entry).text).toBe("mine");
		expect(notices(t2.effects)).toContain("first-sent");
		// Without the commit (the save won), the prompt stays with its marker: the start can no longer commit.
		const won = step(t1.entry, { type: "SAVE_RESULT", seq: 3, result: { outcome: "saved", revision: 3 } }, { ...CTX, fence: t1.fence });
		expect(won.entry?.server?.content.text).toBe("  add a node chart \n\nmine");
		expect(won.fence).toBeNull();
	});
});

// ── D18: FORK, through the store ─────────────────────────────────────────────────────────────────

describe("D18 FORK", () => {
	it("D18 › a start answered deleted moves the words to a new key, saves them, and discards the old row once saved", () => {
		const e = entry({ local: c("more"), sending: sendingOf({ kind: "first", phase: "starting", text: "hello" }), server: row(c("hello"), 1, { state: "sending" }) });
		const s = storeWith(e);
		const t = reduce(s, { type: "ENTRY", key: K, event: { type: "START_RESULT", attempt: "att-1", seq: 2, result: { outcome: "deleted", revision: 2 } } }, ENV);
		const k2: DraftKey = { ...SCOPE_A, conversationId: "fork-1" };
		expect(t.state.entries[keyId(K)]).toBeUndefined();
		expect(t.state.entries[keyId(k2)]?.local?.text).toBe("hello\n\nmore");
		expect(t.state.activeKey[scopeId(SCOPE_A)]).toBe("fork-1");
		expect(ofType(t.effects, "save")).toMatchObject([{ key: k2, base: 0 }]);
		expect(notices(t.effects)).toContain("kept-in-new-deleted");
		expect(ofType(t.effects, "discard")).toEqual([]);
		const saved = reduce(t.state, { type: "ENTRY", key: k2, event: { type: "SAVE_RESULT", seq: 3, result: { outcome: "saved", revision: 1 } } }, ENV);
		expect(ofType(saved.effects, "discard")).toEqual([{ type: "discard", key: K, base: 2 }]);
		expect(saved.state.forks).toEqual({});
	});

	it("D18 › gone on save while the box holds unsaved words forks them", () => {
		const e = entry({ server: row(c("a"), 1), local: c("mine"), save: "saving", inflight: { op: "save", base: 1, content: c("mine"), failedSend: null } });
		const t = reduce(storeWith(e), { type: "ENTRY", key: K, event: { type: "SAVE_RESULT", seq: 1, result: { outcome: "gone", thread: thread({ status: "deleted" }) } } }, ENV);
		expect(t.state.entries[keyId({ ...SCOPE_A, conversationId: "fork-1" })]?.local).toEqual(c("mine"));
		expect(ofType(t.effects, "cache-remove")).toEqual([{ type: "cache-remove", key: K }]);
	});

	it("D18 › an id this tab already holds is not fresh: the words stay in the old box", () => {
		const e = entry({ server: row(c("a"), 1), local: c("mine"), save: "saving", inflight: { op: "save", base: 1, content: c("mine"), failedSend: null } });
		const taken = { ...newEntry({ ...SCOPE_A, conversationId: "fork-1" }, "none") };
		const t = reduce(storeWith(e, taken), { type: "ENTRY", key: K, event: { type: "SAVE_RESULT", seq: 1, result: { outcome: "gone", thread: thread({ status: "deleted" }) } } }, ENV);
		expect(t.state.entries[keyId(K)]?.local).toEqual(c("mine"));
		expect(t.state.entries[keyId(taken.key)]).toBe(taken);
	});
});

// ── D21: discard ─────────────────────────────────────────────────────────────────────────────────

describe("D21 discard", () => {
	it("D21 › Discard sends discardDraft at the base; discarded empties the box and offers Undo, which restores it", () => {
		const e = entry({ server: row(c("draft"), 4) });
		expect(step(e, { type: "DISCARD" }).effects).toEqual([{ type: "discard", key: K, base: 4 }]);
		const t = step(e, { type: "DISCARD_RESULT", base: 4, seq: 1, result: { outcome: "discarded", revision: 5 } });
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry)).toEqual(EMPTY_CONTENT);
		expect(ofType(t.effects, "offer-undo-discard")).toEqual([{ type: "offer-undo-discard", key: K, revision: 5, content: c("draft") }]);
		const u = step(t.entry, { type: "UNDO_DISCARD", revision: 5, content: c("draft") });
		expect(u.effects).toEqual([{ type: "restore", key: K, base: 5 }]);
		if (u.entry === null) throw new Error("removed");
		expect(shownContent(u.entry).text).toBe("draft");
	});

	it("D21 › never while a claim or a send is live; a claimed answer is D30; a conflict keeps the words (D15)", () => {
		expect(step(entry({ server: row(c("d"), 4), claiming: claimingOf("first") }), { type: "DISCARD" }).effects).toEqual([]);
		const other = row(c("d"), 5, { state: "sending", claim: { token: "tok-x", turnId: "t-x", kind: "first", claimedAt: NOW } });
		const claimed = step(entry({ server: row(c("d"), 4) }), { type: "DISCARD_RESULT", base: 4, seq: 1, result: { outcome: "claimed", row: other, thread: thread() } });
		expect(claimed.entry?.conflict?.kind).toBe("claimed");
		const conflict = step(entry({ server: row(c("d"), 4) }), { type: "DISCARD_RESULT", base: 4, seq: 1, result: { outcome: "conflict", row: row(c("theirs"), 5), thread: thread() } });
		expect(conflict.entry?.local).toEqual(c("d"));
		expect(conflict.entry?.conflict?.kind).toBe("edited");
	});
});

// ── D22 / D30 / D31 / D33: listed rows ───────────────────────────────────────────────────────────

describe("D22 / D30 / D31 / D33 listed rows", () => {
	/** A list answer of scope A holding `drafts`. */
	const rows = (seq: number, ...drafts: DraftListEntry[]): DraftsStoreEvent => ({
		type: "SERVER_ROWS", seq, generation: 1, result: { outcome: "ok", orgId: ORG_A, drafts }, restored: [],
	});

	it("D22 › a clean key adopts the row (epoch bumps only when the box changes); an unsaved key with a newer row is D15", () => {
		const clean = entry({ server: row(c("old"), 1) });
		const s = reduce(storeWith(clean), rows(5, { row: row(c("new"), 2), thread: thread({ status: "none" }), threadTitle: null }), ENV).state;
		expect(s.entries[keyId(K)]?.server?.content.text).toBe("new");
		expect(s.entries[keyId(K)]?.epoch).toBe(clean.epoch + 1);
		const dirty = entry({ server: row(c("old"), 1), local: c("mine") });
		const d = reduce(storeWith(dirty), rows(5, { row: row(c("new"), 2), thread: thread({ status: "none" }), threadTitle: null }), ENV).state;
		expect(d.entries[keyId(K)]?.local).toEqual(c("mine"));
		expect(d.entries[keyId(K)]?.conflict?.kind).toBe("edited");
	});

	it("D22 › a mounted key whose thread became listed loads its transcript, so D9 never sends from an empty chat (I7)", () => {
		const t = reduce(storeWith(entry({ server: row(c("x"), 1) })), rows(5, { row: row(c("x"), 1), thread: thread(), threadTitle: null }), ENV);
		expect(t.state.entries[keyId(K)]).toMatchObject({ thread: "listed", transcript: "loading" });
		expect(ofType(t.effects, "load-transcript")).toEqual([{ type: "load-transcript", key: K }]);
	});

	it("a list that shows our sending row active resolves through not-claimed (R9), and only while routing", () => {
		const routing = listedEntry("x", { sending: sendingOf(), server: row(c("deploy"), 4, { state: "sending" }) });
		const consumed = row(EMPTY_CONTENT, 5, { lastSent: { turnId: "turn-1", kind: "later", at: NOW } });
		const s = reduce(storeWith(routing), rows(9, { row: consumed, thread: thread({ hasTurn: true }), threadTitle: null }), ENV).state;
		expect(s.entries[keyId(K)]?.sending).toBeNull();
		expect(s.entries[keyId(K)]?.server).toEqual(consumed);
		const starting = entry({ sending: sendingOf({ kind: "first", phase: "starting", text: "hello" }), server: row(c("hello"), 1, { state: "sending" }) });
		const kept = reduce(storeWith(starting), rows(9, { row: row(EMPTY_CONTENT, 2), thread: thread({ firstTurnId: "turn-1" }), threadTitle: null }), ENV).state;
		expect(kept.entries[keyId(K)]?.sending).toEqual(starting.sending);
	});

	it("D30 › device A's live claim: the box is read-only with the being-sent bar, and keeps unsaved words; it ends when the row is sent", () => {
		const frozen = row(c("deploy"), 5, { state: "sending", claim: { token: "tok-x", turnId: "turn-x", kind: "later", claimedAt: NOW } });
		const e = listedEntry("deploy");
		const t1 = reduce(storeWith(e), rows(5, { row: frozen, thread: thread(), threadTitle: null }), ENV);
		const held = t1.state.entries[keyId(K)];
		expect(held?.conflict).toEqual({ kind: "claimed", row: frozen });
		expect(notices(t1.effects)).toContain("claimed-elsewhere");
		if (held === undefined) throw new Error("missing");
		expect(step(held, { type: "SUBMIT", chatReady: true }).effects).toEqual([]);
		const sent = row(EMPTY_CONTENT, 6, { lastSent: { turnId: "turn-x", kind: "later", at: NOW } });
		const t2 = reduce(t1.state, rows(6, { row: sent, thread: thread(), threadTitle: null }), ENV);
		expect(t2.state.entries[keyId(K)]?.conflict).toBeNull();
		expect(t2.state.entries[keyId(K)]?.server).toEqual(sent);
		expect(notices(t2.effects)).toContain("sent-elsewhere");
	});

	it("a listed row frozen under this tab's abandoned token is released, never shown as another tab's (D33)", () => {
		const frozen = row(c("hello"), 5, { state: "sending", claim: { token: "tok-1", turnId: "turn-1", kind: "first", claimedAt: NOW } });
		const e = entry({ local: c("hello"), abandoned: ["tok-1"] });
		const t = reduce(storeWith(e), rows(5, { row: frozen, thread: thread({ status: "none" }), threadTitle: null }), ENV);
		expect(t.state.entries[keyId(K)]?.conflict).toBeNull();
		expect(ofType(t.effects, "release")).toMatchObject([{ token: "tok-1" }]);
	});

	it("D31 › a row with an uncertain marker opens the card; edits still autosave and Enter sends the same turn id; Dismiss clears it", () => {
		const uncertain = row(c("deploy"), 5, { failedSend: { turnId: "turn-u", kind: "later", error: "lease", at: NOW, uncertain: true } });
		const s = reduce(storeWith(listedEntry("deploy")), rows(5, { row: uncertain, thread: thread(), threadTitle: null }), ENV).state;
		const e = s.entries[keyId(K)];
		if (e === undefined) throw new Error("missing");
		expect(e.conflict).toEqual({ kind: "uncertain", row: null });
		const edited = stay(e, { type: "EDIT", epoch: e.epoch, content: { text: "deploy now", mentions: [] } });
		expect(ofType(step(edited, { type: "SAVE_TRIGGER", reason: "timer" }).effects, "save")).toHaveLength(1);
		expect(edited.conflict?.kind).toBe("uncertain");
		expect(step(e, { type: "SUBMIT", chatReady: true }).entry?.claiming?.turnId).toBe("turn-u");
		expect(ofType(step(e, { type: "UNCERTAIN_DISMISS" }).effects, "dismiss-failed-send")).toEqual([
			{ type: "dismiss-failed-send", key: K, base: 5, content: c("deploy") },
		]);
	});

	it("property: no SERVER_ROWS removes an entry whose local ≠ null or whose server = null (G29)", () => {
		const unsaved = entry({ local: c("mine"), server: row(c("x"), 1) });
		const unseen = { ...newEntry({ ...SCOPE_A, conversationId: "c-2" }, "none") };
		const t = reduce(storeWith(unsaved, unseen), rows(9), ENV).state;
		expect(t.entries[keyId(K)]).toBeDefined();
		expect(t.entries[keyId(unseen.key)]).toBeDefined();
	});
});

// ── D26: reload ──────────────────────────────────────────────────────────────────────────────────

describe("D26 restoring the cache", () => {
	const cached = (over: Partial<CachedDraft>): CachedDraft => ({ key: K, base: 2, local: null, claiming: null, sending: null, abandoned: [], epoch: 0, ...over });
	const item = (r: ServerDraft, t: DraftThread = thread({ status: "none" })): DraftListEntry => ({ row: r, thread: t, threadTitle: null });

	it("D26 › a restored claim is released at once by its own token, and its answer is read by D11r", () => {
		const t = restoreFromCache(cached({ claiming: claimingOf("first") }), item(row(c("hello"), 3, { state: "sending" })), CTX);
		expect(ofType(t.effects, "release")).toMatchObject([{ token: "tok-1", error: "reload", uncertain: false }]);
		if (t.entry === null) throw new Error("removed");
		expect(shownContent(t.entry).text).toBe("");
		const back = step(t.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 1, retry: 0, result: { outcome: "released", row: row(c("hello"), 4) } });
		if (back.entry === null) throw new Error("removed");
		expect(shownContent(back.entry).text).toBe("hello");
	});

	it("D26 / D11n › a reload during a claim that never landed: not-claimed restores the CLAIMED words, and the cache keeps them", () => {
		const claimed = claimingOf("first", c("hello world"));
		const t = restoreFromCache(cached({ claiming: claimed }), item(row(c("hello"), 3)), CTX);
		if (t.entry === null) throw new Error("removed");
		const back = step(t.entry, { type: "RELEASE_RESULT", token: "tok-1", seq: 1, retry: 0, result: {
			outcome: "not-claimed", row: row(c("hello"), 3), thread: thread({ status: "none" }),
		} });
		if (back.entry === null) throw new Error("removed");
		expect(shownContent(back.entry).text).toBe("hello world");
		expect(back.entry.local?.text).toBe("hello world");
		expect(ofType(back.effects, "cache-remove")).toEqual([]);
		expect(ofType(back.effects, "save").map((x) => [x.base, x.content.text])).toEqual([[3, "hello world"]]);
	});

	it("D26 › a restored later send that was routing is released uncertain; an external one is D10f", () => {
		const later = restoreFromCache(cached({ sending: sendingOf() }), item(row(c("deploy"), 3, { state: "sending" }), thread()), CTX);
		expect(ofType(later.effects, "release")).toMatchObject([{ uncertain: true }]);
		const ext = restoreFromCache(cached({ sending: sendingOf({ token: null, text: "seed" }) }), item(row(c("mine"), 3), thread()), CTX);
		expect(ext.entry?.pendingFailedSend).toMatchObject({ turnId: "turn-1", error: "reload", uncertain: true });
		expect(ofType(ext.effects, "save")[0]?.base).toBe(3);
	});

	it("a cache item older than the server row becomes a conflict, not a resurrection (AC10); a current one saves again", () => {
		const stale = restoreFromCache(cached({ local: c("deploy") }), item(row(c("deploy now"), 5)), CTX);
		expect(stale.entry?.conflict?.kind).toBe("edited");
		expect(ofType(stale.effects, "save")).toEqual([]);
		const current = restoreFromCache(cached({ local: c("deploy!") }), item(row(c("deploy"), 2)), CTX);
		expect(ofType(current.effects, "save")).toMatchObject([{ base: 2, content: c("deploy!") }]);
		const gone = restoreFromCache(cached({ local: c("deploy!") }), null, CTX);
		expect(gone.fork?.content).toEqual(c("deploy!"));
	});
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

describe("content helpers", () => {
	it("appendContent re-bases the tail's spans after the separator", () => {
		const tail: DraftContent = { ...c("@db up"), mentions: [{ id: "d", type: "cluster", label: "db", start: 0, end: 3 }] };
		expect(appendContent(c("hi"), tail).mentions).toEqual([{ id: "d", type: "cluster", label: "db", start: 4, end: 7 }]);
	});
});

// ── Property tests: I3, I5, I6 and AC17 over EVERY event ─────────────────────────────────────────

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

const TEXTS = ["", "a", "deploy", "deploy now", "x\u0000y", "scale web"];
const KEYS: DraftKey[] = [
	{ ...SCOPE_A, conversationId: "p1" },
	{ ...SCOPE_A, conversationId: "p2" },
	{ ...SCOPE_B, conversationId: "p3" },
];

/** A random drafting or sending event for `key`, aimed at its live claim or send most of the time. */
function randomEntryEvent(r: () => number, e: DraftEntry | undefined, seq: () => number): DraftEntryEvent | DraftSendEvent {
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
	const key = e?.key ?? KEYS[0];
	const turnId = e?.sending?.turnId ?? e?.claiming?.turnId ?? pick(["turn-a", "turn-b"]);
	const token = r() < 0.85 ? (e?.sending?.token ?? e?.claiming?.token ?? pick(e?.abandoned ?? ["tok-z"])) : "tok-z";
	const attempt = r() < 0.9 ? (e?.claiming?.attempt ?? e?.sending?.attempt ?? "att-z") : "att-z";
	const anyRow = (): ServerDraft => {
		const state = pick(["active", "active", "sending", "discarded"] as const);
		return row(c(pick(TEXTS)), Math.floor(r() * 8) + 1, {
			...key,
			state,
			claim: state === "sending" ? { token: pick([token, "tok-other"]), turnId: pick([turnId, "turn-o"]), kind: pick(["first", "later"] as const), claimedAt: NOW } : null,
			lastSent: r() < 0.4 ? { turnId: pick([turnId, "turn-o"]), kind: "later", at: NOW } : null,
			failedSend: r() < 0.2 ? { turnId, kind: "later", error: "x", at: NOW, uncertain: r() < 0.5 } : null,
			lastWriter: r() < 0.3 ? TAB : "tab-other",
		});
	};
	// A row frozen by another sender, as every `claimed` answer shows it.
	const frozenRow = (): ServerDraft => ({
		...anyRow(),
		state: "sending",
		claim: { token: pick([token, "tok-other"]), turnId: "turn-o", kind: "later", claimedAt: NOW },
	});
	// A released row holds exactly what was claimed (S4 keeps the content).
	const releasedRow = (): ServerDraft => ({
		...anyRow(),
		state: "active",
		claim: null,
		content: e?.sending?.token != null ? { ...c(e.sending.text), mentions: e.sending.mentions } : c(pick(TEXTS)),
	});
	const anyThread = (): DraftThread => ({
		status: pick(["none", "listed", "unlisted", "deleted"] as const),
		firstTurnId: r() < 0.3 ? turnId : null,
		hasTurn: r() < 0.3,
	});
	const gate = [
		{ outcome: "invalid" }, { outcome: "unauthorized" }, { outcome: "forbidden" },
		{ outcome: "scope-changed", reason: "other-org" }, { outcome: "rate-limited" }, { outcome: "unavailable" },
	] as const;
	const refusals = [{ outcome: "limit" }, ...gate] as const;
	const failure = (): RouteFailure =>
		pick<RouteFailure>([
			{ kind: "stop" }, { kind: "network" }, { kind: "status", status: pick([401, 402, 500, 502]), refusal: null },
			refusal(pick(["transcript-stale", "thread-busy", "thread-deleted", "org-forbidden"] as const), false),
			refusal("turn-in-progress", true), refusal("turn-answered", true), refusal("turn-committed-different-text", true, false),
		]);
	const writeFailure = () => pick([{ kind: "timeout" as const }, { kind: "rejected" as const, network: r() < 0.5 }]);
	const epoch = (e?.epoch ?? 0) + (r() < 0.8 ? 0 : pick([-1, 1]));
	const events: (DraftEntryEvent | DraftSendEvent)[] = [
		{ type: "EDIT", epoch, content: { text: pick(TEXTS), mentions: [] } },
		{ type: "EDIT", epoch, content: { text: pick(TEXTS), mentions: [] } },
		{ type: "SAVE_TRIGGER", reason: pick(["timer", "blur", "retry", "online", "before-submit"] as const) },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "saved", revision: Math.floor(r() * 8) + 1 } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "conflict", row: anyRow(), thread: anyThread() } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "claimed", row: frozenRow(), thread: anyThread() } },
		{ type: "SAVE_RESULT", seq: seq(), result: { outcome: "gone", thread: anyThread() } },
		{ type: "SAVE_RESULT", seq: seq(), result: pick(refusals) },
		{ type: "WRITE_REJECTED", seq: seq(), rejection: { network: r() < 0.5 } },
		{ type: "CONFLICT_KEEP_MINE" }, { type: "CONFLICT_USE_THEIRS" }, { type: "CONFLICT_RESTORE" }, { type: "CONFLICT_LET_GO" },
		{ type: "NOT_LISTED", seq: seq() },
		{ type: "TRANSCRIPT_LOADED" },
		{ type: "SUBMIT", chatReady: r() < 0.8 },
		{ type: "SUBMIT", chatReady: true },
		{ type: "SUBMIT_EXTERNAL", text: pick(TEXTS), mentions: [], cellTarget: r() < 0.5 ? { x: 1, y: 1 } : null, origin: "cell", chatReady: r() < 0.8 },
		{ type: "CLAIM_RESULT", attempt, seq: seq(), result: { outcome: "claimed-by-you", revision: Math.floor(r() * 8) + 1, content: e?.claiming?.content ?? c("a") } },
		{ type: "CLAIM_RESULT", attempt, seq: seq(), result: { outcome: "claimed-by-you", revision: Math.floor(r() * 8) + 1, content: e?.claiming?.content ?? c("a") } },
		{ type: "CLAIM_RESULT", attempt, seq: seq(), result: pick([
			{ outcome: "conflict", row: anyRow(), thread: anyThread() }, { outcome: "claimed", row: frozenRow(), thread: anyThread() },
			{ outcome: "discarded", row: anyRow(), thread: anyThread() }, { outcome: "gone", thread: anyThread() },
			{ outcome: "wrong-kind", thread: anyThread() }, { outcome: "empty" }, ...refusals,
		] as const) },
		{ type: "CLAIM_FAILED", attempt, seq: seq(), failure: writeFailure() },
		{ type: "START_RESULT", attempt, seq: seq(), result: pick([
			{ outcome: "created", revision: Math.floor(r() * 8) + 1, threadRevision: 1 }, { outcome: "already-stored", revision: 3 },
			{ outcome: "deleted", revision: 3 }, { outcome: "conflict", revision: 3 }, { outcome: "not-claimed", row: anyRow(), thread: anyThread() },
			{ outcome: "claimed", row: frozenRow(), thread: anyThread() }, { outcome: "draft-conflict", row: anyRow(), thread: anyThread() }, ...gate,
		] as const) },
		{ type: "START_FAILED", attempt, seq: seq(), failure: writeFailure() },
		{ type: "ROUTE_HANDOFF", turnId },
		{ type: "ROUTE_FAILED", turnId, failure: failure() },
		{ type: "ROUTE_FAILED", turnId, failure: failure() },
		{ type: "CONSUME_RESULT", token, seq: seq(), retry: 0, result: pick([
			{ outcome: "consumed", revision: 5 }, { outcome: "not-claimed", row: anyRow(), thread: anyThread() }, { outcome: "gone", thread: anyThread() }, ...gate,
		] as const) },
		{ type: "CONSUME_FAILED", token, seq: seq(), retry: 0, failure: writeFailure() },
		{ type: "RELEASE_RESULT", token, seq: seq(), retry: 0, result: pick([
			{ outcome: "released", row: releasedRow() }, { outcome: "consumed", revision: 5 }, { outcome: "not-claimed", row: anyRow(), thread: anyThread() },
			{ outcome: "gone", thread: anyThread() }, ...gate,
		] as const) },
		{ type: "RELEASE_FAILED", token, seq: seq(), retry: 0, failure: writeFailure() },
		{ type: "HEARTBEAT_RESULT", token, result: pick([
			{ outcome: "touched" }, { outcome: "not-claimed", row: anyRow(), thread: anyThread() }, { outcome: "gone", thread: anyThread() },
		] as const) },
		{ type: "DISCARD" },
		{ type: "DISCARD_RESULT", base: e?.server?.revision ?? 0, seq: seq(), result: pick([
			{ outcome: "discarded", revision: 9 }, { outcome: "conflict", row: anyRow(), thread: anyThread() },
			{ outcome: "claimed", row: frozenRow(), thread: anyThread() }, { outcome: "gone", thread: anyThread() }, ...gate,
		] as const) },
		{ type: "UNDO_DISCARD", revision: 9, content: c(pick(TEXTS)) },
		{ type: "UNCERTAIN_DISMISS" }, { type: "COPY_KEEP" }, { type: "COPY_DISCARD" },
		{ type: "LISTED", seq: seq(), listed: { row: anyRow(), thread: anyThread(), threadTitle: null } },
	];
	// Aim at the answer a live claim or send is waiting for, so the generator reaches every phase.
	const waiting = events.filter((x) =>
		(e?.claiming != null && (x.type === "CLAIM_RESULT" || x.type === "CLAIM_FAILED")) ||
		(e?.sending?.phase === "starting" && (x.type === "START_RESULT" || x.type === "START_FAILED")) ||
		(e?.sending?.phase === "routing" && (x.type === "ROUTE_HANDOFF" || x.type === "ROUTE_FAILED" || x.type === "HEARTBEAT_RESULT")) ||
		(e?.sending?.phase === "consuming" && (x.type === "CONSUME_RESULT" || x.type === "CONSUME_FAILED")) ||
		(e?.sending?.phase === "releasing" && (x.type === "RELEASE_RESULT" || x.type === "RELEASE_FAILED")),
	);
	return waiting.length > 0 && r() < 0.6 ? pick(waiting) : pick(events);
}

/** Every text an entry holds anywhere: unsaved, acknowledged, claimed, being sent, or in a bar's row. */
function heldTexts(e: DraftEntry): string[] {
	const out: string[] = [];
	if (e.local !== null) out.push(e.local.text);
	if (e.server !== null) out.push(e.server.content.text);
	if (e.conflict?.row) out.push(e.conflict.row.content.text);
	if (e.claiming !== null) out.push(e.claiming.content.text);
	if (e.sending !== null) out.push(e.sending.text);
	return out;
}

/** The words a key holds that only a listed event may remove: unsaved, claimed, or a claimed send's. */
function guardedWords(e: DraftEntry): { kind: "local" | "claim" | "send"; text: string }[] {
	const out: { kind: "local" | "claim" | "send"; text: string }[] = [];
	if (e.local !== null && e.local.text !== "") out.push({ kind: "local", text: e.local.text });
	// Claimed words equal to the acknowledged row are not unsaved: a newer row may supersede them.
	const acked = e.server?.content.text;
	if (e.claiming !== null && e.claiming.content.text !== acked) out.push({ kind: "claim", text: e.claiming.content.text });
	if (e.sending !== null && e.sending.token !== null) out.push({ kind: "send", text: e.sending.text });
	return out;
}

/** The claim-outcome table's proof that a send was consumed (§7.2). */
function proven(row: ServerDraft, t: DraftThread, turnId: string): boolean {
	return row.lastSent?.turnId === turnId || t.firstTurnId === turnId || t.hasTurn;
}

/** This key's listed row in a store event, if the event lists one. */
function listedFor(ev: DraftsStoreEvent, key: DraftKey): DraftListEntry | null {
	if (ev.type === "SERVER_ROWS")
		return ev.result.drafts.find((d) => d.row.conversationId === key.conversationId && d.row.orgId === key.orgId) ?? null;
	if (ev.type === "ENTRY" && keyId(ev.key) === keyId(key) && ev.event.type === "LISTED") return ev.event.listed;
	return null;
}

/**
 * I3's list, per word and per event, with no blanket exemption for any event type. A user's choice
 * removes words (D15 Use theirs, D16 Let it go, D21's discard, D9c's Discard the copy, D25); a send's
 * words leave only with the server's proof that the send was consumed (D9c, D12, D13, D17, D20, R9,
 * D35 after the hand-off); and D30 ends by adopting a row whose send is proven sent elsewhere.
 */
function mayRemove(ev: DraftsStoreEvent, before: DraftEntry, kind: "local" | "claim" | "send"): boolean {
	if (ev.type === "VIEWER_CHANGE") return true; // D25
	const own = ev.type === "ENTRY" && keyId(ev.key) === keyId(before.key);
	const item = listedFor(ev, before.key);
	const former = before.conflict?.kind === "claimed" ? (before.conflict.row?.claim?.turnId ?? null) : null;
	if (kind === "local" && item !== null && former !== null && item.row.lastSent?.turnId === former) return true; // D30 ends
	if (own && ev.type === "ENTRY") {
		const x = ev.event;
		if (kind === "local" && ["CONFLICT_USE_THEIRS", "CONFLICT_LET_GO", "COPY_DISCARD", "EDIT"].includes(x.type)) return true;
		if (x.type === "DISCARD_RESULT" && (x.result.outcome === "discarded" || x.result.outcome === "gone")) return true; // D21
	}
	if (kind !== "send" || before.sending === null) return false;
	const turnId = before.sending.turnId;
	if (item !== null && proven(item.row, item.thread, turnId)) return true; // R9 through the table
	if (!own || ev.type !== "ENTRY") return false;
	const x = ev.event;
	// A consume runs only after the hand-off: the route accepted the turn, so the text is the sent
	// turn whatever the consume answers (D9c; D35 after the hand-off). D9c's copy is the row's own.
	if (x.type === "CONSUME_RESULT") return before.sending.phase === "consuming";
	if (x.type === "RELEASE_RESULT" || x.type === "HEARTBEAT_RESULT")
		return x.result.outcome === "consumed" || (x.result.outcome === "not-claimed" && proven(x.result.row, x.result.thread, turnId));
	if (x.type === "START_RESULT")
		return x.result.outcome === "created" || x.result.outcome === "already-stored" || (x.result.outcome === "not-claimed" && proven(x.result.row, x.result.thread, turnId));
	return false;
}

/** The words a restored cache item carries, which D26 must keep. */
function cachedWords(c0: CachedDraft): string[] {
	const out: string[] = [];
	if (c0.local !== null && c0.local.text !== "") out.push(c0.local.text);
	if (c0.claiming !== null) out.push(c0.claiming.content.text);
	if (c0.sending !== null) out.push(c0.sending.text);
	return out;
}

/** How often the generator reached each interesting case, so a vacuous run cannot pass. */
const reached = { restored: 0, granted: 0, released: 0, consumed: 0, forked: 0, claimedElsewhere: 0, external: 0, staleEdit: 0, uncertain: 0 };

/** Runs the generator for `seed` and checks every property at every step. */
function runSeed(seed: number, steps: number): void {
	const r = rng(seed);
	let n = 0;
	const seq = () => (n += 1);
	let ids = 0;
	const boxModel = new Map<string, string>();
	let state = storeWith();
	for (const k of KEYS) state = { ...state, entries: { ...state.entries, [keyId(k)]: newEntry(k, r() < 0.5 ? "listed" : "none") } };
	for (let i = 0; i < steps; i += 1) {
		ids += 1;
		const env: DraftsStoreEnv = {
			tabId: TAB, now: NOW, mounted: r() < 0.7,
			fresh: { attempt: `att-${ids}`, token: `tok-${ids}`, turnId: `turn-${ids}`, conversationId: `fork-${ids}` },
		};
		const keys = Object.values(state.entries).map((x) => x.key);
		const key = keys.length > 0 && r() < 0.9 ? keys[Math.floor(r() * keys.length)] : KEYS[Math.floor(r() * KEYS.length)];
		const roll = r();
		let ev: DraftsStoreEvent;
		if (roll < 0.02) ev = { type: "OPEN_NEW", conversationId: `new-${ids}` };
		else if (roll < 0.04) ev = { type: "SELECT", key, thread: r() < 0.5 ? "listed" : "none" };
		else if (roll < 0.06) ev = { type: "PAGE_ORG", orgId: r() < 0.7 ? key.orgId : null };
		else if (roll < 0.065) ev = { type: "VIEWER_CHANGE", viewerId: r() < 0.5 ? "viewer-1" : "viewer-2" };
		else if (roll < 0.07) ev = { type: "SCOPE_CHANGE", scope: r() < 0.5 ? SCOPE_A : SCOPE_B };
		else if (roll < 0.1) {
			const drafts: DraftListEntry[] = [];
			for (const k of KEYS) {
				if (r() < 0.4) continue;
				const ev2 = randomEntryEvent(r, state.entries[keyId(k)], seq);
				if (ev2.type === "LISTED") drafts.push({ ...ev2.listed, row: { ...ev2.listed.row, ...k } });
			}
			// D26: a cache item for a key this tab does not hold yet, listed or not.
			const restored: CachedDraft[] = [];
			const scope = state.scope ?? SCOPE_A;
			if (r() < 0.6) {
				const rk: DraftKey = { ...scope, conversationId: `r-${ids}` };
				const words = c(["hello world", "deploy now", "scale web"][Math.floor(r() * 3)]);
				const which = Math.floor(r() * 4);
				const turnId = `turn-r${ids}`;
				restored.push({
					key: rk, base: Math.floor(r() * 3), epoch: 0, abandoned: [],
					local: which === 0 ? words : null,
					claiming: which === 1 ? { attempt: `att-r${ids}`, token: `tok-r${ids}`, turnId, kind: r() < 0.5 ? "first" : "later", content: words } : null,
					sending: which >= 2 ? sendingOf({ attempt: `att-r${ids}`, token: which === 2 ? `tok-r${ids}` : null, turnId, text: words.text, phase: r() < 0.5 ? "starting" : "routing", kind: r() < 0.5 ? "first" : "later" }) : null,
				});
				if (r() < 0.6) {
					const ev2 = randomEntryEvent(r, undefined, seq);
					if (ev2.type === "LISTED") drafts.push({ ...ev2.listed, row: { ...ev2.listed.row, ...rk } });
				}
			}
			ev = { type: "SERVER_ROWS", seq: seq(), generation: state.generation, result: { outcome: "ok", orgId: scope.orgId, drafts }, restored };
		} else ev = { type: "ENTRY", key, event: randomEntryEvent(r, state.entries[keyId(key)], seq) };
		const check = (ok: boolean, what: string): void => {
			if (!ok) throw new Error(`seed ${seed} step ${i} ${JSON.stringify(ev)}: ${what}`);
		};
		const t = reduce(state, ev, env);
		const x = ev.type === "ENTRY" ? ev.event : null;
		const all = Object.values(t.state.entries).flatMap(heldTexts);
		// I6, model-based: the box changes only by an applied EDIT or with an epoch move.
		for (const [id, after] of Object.entries(t.state.entries)) {
			const before = state.entries[id];
			const shown = shownContent(after).text;
			const model = boxModel.get(id);
			if (before === undefined || model === undefined || after.epoch !== before.epoch) {
				boxModel.set(id, shown);
				continue;
			}
			const own = ev.type === "ENTRY" && keyId(ev.key) === id;
			if (own && x?.type === "EDIT" && x.epoch === before.epoch && before.claiming === null) {
				boxModel.set(id, shown);
				check(shown === normalizeDraftText(x.content.text) || before.sending?.token != null, `box is not the edit: ${shown}`);
				continue;
			}
			check(shown === model, `box changed without an outside replacement: ${JSON.stringify(shown)} ≠ ${JSON.stringify(model)} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
		}
		for (const id of [...boxModel.keys()]) if (t.state.entries[id] === undefined) boxModel.delete(id);
		for (const [id, before] of Object.entries(state.entries)) {
			const after = t.state.entries[id];
			const own = ev.type === "ENTRY" && keyId(ev.key) === id;
			// AC17: no event writes a key other than its own (a fork only ever creates a fresh key).
			if (ev.type === "ENTRY" && !own) check(after === before, "another key written");
			if (own && x?.type === "EDIT" && x.epoch !== before.epoch) {
				reached.staleEdit += 1;
				check(after === before, "stale edit applied"); // I6
			}
			if (before.claiming !== null && after?.sending?.token === before.claiming.token) reached.granted += 1;
			if (before.sending !== null && after?.sending === null) reached.consumed += 1;
			if (before.sending?.phase === "releasing" && (after === undefined || after.sending === null)) reached.released += 1;
			if (after === undefined && own) reached.forked += 1;
			if (before.conflict?.kind !== "claimed" && after?.conflict?.kind === "claimed") reached.claimedElsewhere += 1;
			if (after?.sending?.token === null && before.sending === null) reached.external += 1;
			if (after?.conflict?.kind === "uncertain") reached.uncertain += 1;
			// I3 / I5, on EVERY event: unsaved, claimed or claimed-and-sending words survive, here or in
			// a fork, unless the user chose to remove them or the server proved the send consumed.
			for (const w of guardedWords(before))
				if (!mayRemove(ev, before, w.kind))
					check(all.some((h) => h.includes(w.text)), `words lost (${w.kind}): ${JSON.stringify(w.text)}`);
		}
		// D26: a restored cache item's words are never dropped by the restore.
		if (ev.type === "SERVER_ROWS")
			for (const c0 of ev.restored) {
				if (state.entries[keyId(c0.key)] !== undefined) continue;
				reached.restored += 1;
				for (const w of cachedWords(c0)) check(all.some((h) => h.includes(w)), `restored words lost: ${JSON.stringify(w)}`);
			}
		state = t.state;
	}
}

describe("properties over every event (seeded)", () => {
	// 240 seeds × 150 steps, in six batches so no single test carries the whole budget.
	for (let batch = 0; batch < 6; batch += 1) {
		const first = batch * 40 + 1;
		it(`no event removes words except the listed ones (I3); unsaved edits are never overwritten (I5); a stale-epoch edit is dropped (I6); no event writes a key other than its own (AC17) — seeds ${first}-${first + 39}`, () => {
			expect(() => {
				for (let seed = first; seed < first + 40; seed += 1) runSeed(seed, 150);
			}).not.toThrow();
		});
	}

	it("the generator reached every case it checks (the batches above ran first)", () => {
		for (const [name, count] of Object.entries(reached)) expect(count, `reached ${name}`).toBeGreaterThan(20);
	});
});
