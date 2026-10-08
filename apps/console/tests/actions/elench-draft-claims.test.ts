// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The A tests of ADR 0001 slice 4 (§11.6, §14): the draft claim. `claimDraft`, `consumeDraft`,
// `releaseClaim`, the 120 s lease settle (S5) and the heartbeat route's transaction (S7).
//
// As in tests/actions/elench-drafts.test.ts, the boundary is mocked and the actions are real. The
// database is an in-memory table set that RENDERS each statement with drizzle's own Postgres dialect
// and applies its equalities, `IS NULL` and `<>` to the rows, so a predicate an action drops (the
// `user_id` pin, the token match) is a predicate the fake stops applying. The lease is the one
// predicate that is not an equality: the fake reads its interval OUT OF the rendered statement
// (`claimed_at < now() - interval 'N seconds'`, as a WHERE term or a selected column) and compares
// it with the row's `claimed_at` on the test's clock. A statement that names no such interval is
// never silent, so a settle that drops the lease check settles nothing it should, and one that
// widens or narrows it disagrees with the 119 s / 121 s rows below.

import { PgDialect } from "drizzle-orm/pg-core";
import { Column, getTableName, is, SQL, Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorizeQuiet: vi.fn(),
	resolveTurnActor: vi.fn(),
}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn(), getOwner: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));

import { POST as heartbeat } from "@/app/api/elench/drafts/heartbeat/route";
import {
	claimDraft,
	consumeDraft,
	discardDraft,
	listDrafts,
	releaseClaim,
	saveDraft,
} from "@/app/server/actions/elench-drafts";
import { getOwner, getOwnerScope } from "@/lib/auth/owner";
import { authorizeQuiet, currentActor, resolveTurnActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import type { DraftContent } from "@/lib/elench/draft-content";
import { checkRateLimit } from "@/lib/rate-limit";

const USER = "00000000-0000-4000-8000-000000000001";
const TEAMMATE = "00000000-0000-4000-8000-000000000002";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000c0001";
const TURN = "00000000-0000-4000-8000-0000000d0001";
const FRESH = "00000000-0000-4000-8000-0000000d0002";
const TOKEN = "00000000-0000-4000-8000-0000000e0001";
const OTHER_TOKEN = "00000000-0000-4000-8000-0000000e0002";

// ── the fake database ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface Statement {
	verb: "select" | "insert" | "update" | "lock";
	table: string;
	sql: string;
	params: unknown[];
}

const dialect = new PgDialect({ casing: "snake_case" });
let tables: Record<string, Row[]>;
let statements: Statement[];

const LEASE = /"elench_drafts"\."claimed_at" < now\(\) - interval '(\d+) seconds'/;

/** Whether the row's claim is silent past the interval a rendered statement names. */
function silent(row: Row, text: string): boolean | undefined {
	const m = text.match(LEASE);
	if (!m) return undefined;
	const at = row.claimed_at;
	return at instanceof Date && at.getTime() < Date.now() - Number(m[1]) * 1000;
}

/** Whether `row` satisfies every predicate shape the rendered WHERE carries. */
function matches(row: Row, table: string, text: string, params: unknown[]): boolean {
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)) {
		if (m[1] === table && row[m[2] ?? ""] !== params[Number(m[3]) - 1]) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" <> \$(\d+)/g)) {
		if (m[1] === table && row[m[2] ?? ""] === params[Number(m[3]) - 1]) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" is null/g)) {
		if (m[1] === table && row[m[2] ?? ""] != null) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" in \((\$\d+(?:, \$\d+)*)\)/g)) {
		const allowed = (m[3] ?? "").split(", ").map((p) => params[Number(p.slice(1)) - 1]);
		if (m[1] === table && !allowed.includes(row[m[2] ?? ""])) return false;
	}
	if (table === "elench_drafts" && silent(row, text) === false) return false;
	if (text.includes(`in ('active', 'sending') or`)) {
		const st = row.status;
		const recent = row.discarded_at instanceof Date && row.discarded_at.getTime() > Date.now() - 86_400_000;
		if (!(st === "active" || st === "sending" || (st === "discarded" && recent))) return false;
	}
	return true;
}

/** Renders a WHERE (or any SQL) with the production dialect and casing. */
function render(q: SQL | undefined): { sql: string; params: unknown[] } {
	if (!q) return { sql: "", params: [] };
	const out = dialect.sqlToQuery(q);
	return { sql: out.sql, params: out.params };
}

/** A selected row: columns read the row, the lease expression is evaluated, other SQL reads its alias. */
function project(row: Row, fields: Record<string, unknown> | undefined): Row {
	if (!fields) return { ...row };
	const out: Row = {};
	for (const [alias, field] of Object.entries(fields)) {
		if (is(field, Column)) out[alias] = row[field.name];
		else if (is(field, SQL)) out[alias] = silent(row, render(field).sql) ?? row[alias];
		else out[alias] = row[alias];
	}
	return out;
}

/** `sql\`now()\`` in a write is the test's clock. */
const valueOf = (v: unknown) => (is(v, SQL) ? new Date() : v);

/** A drizzle-shaped transaction over `tables`. */
function fakeTx() {
	return {
		select(fields?: Record<string, unknown>) {
			const st: Statement = { verb: "select", table: "", sql: "", params: [] };
			const chain = {
				from(t: Table) {
					st.table = getTableName(t);
					return chain;
				},
				where(w: SQL | undefined) {
					Object.assign(st, render(w));
					return chain;
				},
				orderBy: () => chain,
				limit: () => chain,
				for: () => chain,
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					try {
						statements.push(st);
						const rows = (tables[st.table] ?? []).filter((r) => matches(r, st.table, st.sql, st.params));
						if (fields && "n" in fields) return resolve([{ n: rows.length }]);
						resolve(rows.map((r) => project(r, fields)));
					} catch (e) {
						reject(e);
					}
				},
			};
			return chain;
		},
		insert(t: Table) {
			const st: Statement = { verb: "insert", table: getTableName(t), sql: "", params: [] };
			let values: Row = {};
			const chain = {
				values(v: Row) {
					values = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, valueOf(x)]));
					return chain;
				},
				onConflictDoNothing: () => chain,
				returning: () => chain,
				then(resolve: (v: unknown) => void) {
					statements.push(st);
					const rows = tables[st.table] ?? [];
					const clash = rows.some(
						(r) =>
							r.user_id === values.user_id &&
							r.org_id === values.org_id &&
							r.conversation_id === values.conversation_id,
					);
					if (clash) return resolve([]);
					const row = draftRow(values);
					rows.push(row);
					resolve([{ ...row }]);
				},
			};
			return chain;
		},
		execute(q: SQL) {
			statements.push({ verb: "lock", table: "", ...render(q) });
			return Promise.resolve([]);
		},
		update(t: Table) {
			const st: Statement = { verb: "update", table: getTableName(t), sql: "", params: [] };
			let patch: Row = {};
			const chain = {
				set(p: Row) {
					patch = p;
					return chain;
				},
				where(w: SQL | undefined) {
					Object.assign(st, render(w));
					return chain;
				},
				returning: () => chain,
				then(resolve: (v: unknown) => void) {
					statements.push(st);
					const hit = (tables[st.table] ?? []).filter((r) => matches(r, st.table, st.sql, st.params));
					for (const r of hit) for (const [k, v] of Object.entries(patch)) r[k] = valueOf(v);
					resolve(hit.map((r) => ({ ...r })));
				},
			};
			return chain;
		},
	};
}

/** A full `elench_drafts` row with the table's defaults. */
function draftRow(over: Row): Row {
	return {
		id: crypto.randomUUID(),
		user_id: USER,
		org_id: ORG_A,
		project_id: null,
		conversation_id: CONV,
		revision: 1,
		status: "active",
		discarded_at: null,
		text: "",
		mentions: [],
		artifacts: [],
		cell_target: null,
		claim_token: null,
		claim_turn_id: null,
		claim_kind: null,
		claimed_at: null,
		failed_send: null,
		last_sent: null,
		thread_seen: false,
		title: null,
		last_writer: null,
		created_at: new Date(),
		updated_at: new Date(),
		...over,
	};
}

/** A `sending` row of the caller's, claimed `ageSeconds` ago. */
function sendingRow(over: Row & { ageSeconds?: number }): Row {
	const { ageSeconds = 5, ...rest } = over;
	return draftRow({
		status: "sending",
		revision: 4,
		text: "send this",
		claim_token: TOKEN,
		claim_turn_id: TURN,
		claim_kind: "later",
		claimed_at: new Date(Date.now() - ageSeconds * 1000),
		...rest,
	});
}

/** An `agent_threads` row of the caller's, with the derived columns the summaries select. */
function threadRow(messages: Row[], over: Row = {}): Row {
	return {
		id: CONV,
		user_id: USER,
		org_id: USER,
		status: "active",
		title: "A thread",
		messages,
		firstTurnId: messages[0]?.id ?? null,
		messageCount: messages.length,
		...over,
	};
}

const userTurn = (id: string, text: string): Row => ({ id, role: "user", parts: [{ type: "text", text }] });

/** The caller's draft row for CONV. */
const stored = () => tables.elench_drafts?.find((r) => r.user_id === USER && r.conversation_id === CONV);
const writes = () => statements.filter((s) => s.verb === "insert" || s.verb === "update");

let actor: Actor;

beforeEach(() => {
	vi.clearAllMocks();
	tables = { elench_drafts: [], agent_threads: [], projects: [], member: [], organization: [] };
	statements = [];
	actor = { userId: USER, orgId: ORG_A };
	vi.mocked(currentActor).mockImplementation(async () => actor);
	vi.mocked(authorizeQuiet).mockImplementation(async () => actor);
	vi.mocked(getOwnerScope).mockResolvedValue({ userId: USER, sessionId: "s" });
	vi.mocked(getOwner).mockResolvedValue(USER);
	vi.mocked(resolveTurnActor).mockImplementation(async (userId, orgId) =>
		orgId === ORG_A ? { userId, orgId } : null,
	);
	vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, remaining: 19 });
	// The fake implements only the builder surface the code uses, so it crosses the seam untyped,
	// as the other action tests' chains do.
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx())) as never,
	);
	vi.mocked(getServiceDb).mockImplementation((() => fakeTx()) as never);
});

const content = (t: string): DraftContent => ({ text: t, mentions: [], artifacts: [], cellTarget: null });
const key = { orgId: ORG_A, projectId: null, conversationId: CONV };

const claim = (over: Partial<Parameters<typeof claimDraft>[0]> = {}) =>
	claimDraft({
		...key,
		baseRevision: 0,
		content: content("hello"),
		turnId: TURN,
		token: TOKEN,
		kind: "first",
		tabId: "tab-1",
		...over,
	});

// ── S1, S1r: the claim ──────────────────────────────────────────────────────────────────────────

describe("claimDraft (S1, S1r)", () => {
	it("claims a new draft at base 0: the content is written and the row is sending", async () => {
		const out = await claim({ content: { ...content("hello"), cellTarget: { x: 1, y: 2 } } });
		expect(out).toEqual({
			outcome: "claimed-by-you",
			revision: 1,
			content: { ...content("hello"), cellTarget: { x: 1, y: 2 } },
		});
		expect(stored()).toMatchObject({
			status: "sending",
			text: "hello",
			cell_target: { x: 1, y: 2 },
			claim_token: TOKEN,
			claim_turn_id: TURN,
			claim_kind: "first",
			failed_send: null,
		});
		expect(stored()?.claimed_at).toBeInstanceOf(Date);
	});

	it("claims an active row at its base and clears the failed-send marker", async () => {
		tables.elench_drafts?.push(
			draftRow({
				revision: 3,
				text: "old",
				failed_send: { turnId: TURN, kind: "first", error: "500", at: "x", uncertain: false },
			}),
		);
		expect(await claim({ baseRevision: 3, content: content("edited") })).toMatchObject({
			outcome: "claimed-by-you",
			revision: 4,
		});
		expect(stored()).toMatchObject({ status: "sending", text: "edited", failed_send: null });
	});

	it("two claimDraft calls at one base: one claimed-by-you, one claimed", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 2, text: "x" }));
		expect(await claim({ baseRevision: 2 })).toMatchObject({ outcome: "claimed-by-you" });
		const second = await claim({ baseRevision: 2, token: OTHER_TOKEN });
		expect(second).toMatchObject({ outcome: "claimed", row: { claim: { token: TOKEN } } });
		expect(stored()?.claim_token).toBe(TOKEN);
	});

	it("a claimDraft retried with the same token answers claimed-by-you and changes nothing", async () => {
		tables.elench_drafts?.push(sendingRow({ text: "frozen", claim_kind: "first", ageSeconds: 500 }));
		const out = await claim({ baseRevision: 1, content: content("different"), kind: "first" });
		expect(out).toEqual({ outcome: "claimed-by-you", revision: 4, content: content("frozen") });
		expect(writes()).toEqual([]);
		// Its own claim is never settled, however old.
		expect(stored()?.status).toBe("sending");
	});

	it("refuses an empty text, the wrong kind, a stale base and a missing row", async () => {
		expect(await claim({ content: content(" \n\t ") })).toEqual({ outcome: "empty" });
		tables.agent_threads?.push(threadRow([userTurn("first", "hi")]));
		expect(await claim({ kind: "first" })).toMatchObject({
			outcome: "wrong-kind",
			thread: { status: "listed", firstTurnId: "first" },
		});
		tables.agent_threads = [];
		expect(await claim({ kind: "later" })).toMatchObject({ outcome: "wrong-kind", thread: { status: "none" } });
		expect(await claim({ baseRevision: 3 })).toMatchObject({ outcome: "gone" });
		tables.elench_drafts?.push(draftRow({ revision: 5 }));
		expect(await claim({ baseRevision: 4 })).toMatchObject({ outcome: "conflict", row: { revision: 5 } });
		expect(writes()).toEqual([]);
	});

	it("a discarded row is discarded and stays so", async () => {
		tables.elench_drafts?.push(draftRow({ status: "discarded", discarded_at: new Date(), revision: 2 }));
		expect(await claim({ baseRevision: 2 })).toMatchObject({ outcome: "discarded" });
		expect(writes()).toEqual([]);
	});
});

// ── S3: consume ─────────────────────────────────────────────────────────────────────────────────

describe("consumeDraft (S3)", () => {
	it("consumes a later claim: content emptied, claim cleared, last_sent recorded", async () => {
		tables.elench_drafts?.push(sendingRow({ cell_target: { x: 0, y: 0 } }));
		expect(await consumeDraft({ ...key, token: TOKEN })).toEqual({ outcome: "consumed", revision: 5 });
		expect(stored()).toMatchObject({
			status: "active",
			text: "",
			cell_target: null,
			claim_token: null,
			claimed_at: null,
			last_sent: { turnId: TURN, kind: "later" },
		});
	});

	it("consumeDraft with the live token on a claim older than 120 s consumes, and never settles first", async () => {
		tables.elench_drafts?.push(sendingRow({ ageSeconds: 300 }));
		expect(await consumeDraft({ ...key, token: TOKEN })).toEqual({ outcome: "consumed", revision: 5 });
		expect(stored()?.failed_send).toBeNull();
		expect(writes()).toHaveLength(1);
	});

	it("another token is not-claimed and changes a live claim not at all", async () => {
		tables.elench_drafts?.push(sendingRow({}));
		expect(await consumeDraft({ ...key, token: OTHER_TOKEN })).toMatchObject({
			outcome: "not-claimed",
			row: { state: "sending" },
		});
		expect(writes()).toEqual([]);
	});

	it("a first claim is never consumed here; no row is gone", async () => {
		tables.elench_drafts?.push(sendingRow({ claim_kind: "first" }));
		expect(await consumeDraft({ ...key, token: TOKEN })).toEqual({ outcome: "invalid" });
		expect(stored()?.status).toBe("sending");
		tables.elench_drafts = [];
		expect(await consumeDraft({ ...key, token: TOKEN })).toMatchObject({ outcome: "gone" });
	});

	it("never reaches another user's row in the same org", async () => {
		tables.elench_drafts?.push(sendingRow({ user_id: TEAMMATE }));
		expect(await consumeDraft({ ...key, token: TOKEN })).toMatchObject({ outcome: "gone" });
		expect(tables.elench_drafts?.[0]?.status).toBe("sending");
	});
});

// ── S4: release ─────────────────────────────────────────────────────────────────────────────────

describe("releaseClaim (S4)", () => {
	const release = (over: Partial<Parameters<typeof releaseClaim>[0]> = {}) =>
		releaseClaim({ ...key, token: TOKEN, error: "502", ...over });

	it("keeps the text and records the failed-send marker under the claim's turn id", async () => {
		tables.elench_drafts?.push(sendingRow({ claim_kind: "first" }));
		const out = await release({ error: "reload", uncertain: false });
		expect(out).toMatchObject({
			outcome: "released",
			row: {
				state: "active",
				claim: null,
				content: { text: "send this" },
				failedSend: { turnId: TURN, kind: "first", error: "reload", uncertain: false },
			},
		});
	});

	it("a later turn the thread does not hold is released with the caller's uncertain", async () => {
		tables.elench_drafts?.push(sendingRow({}));
		tables.agent_threads?.push(threadRow([userTurn("first", "hi")]));
		expect(await release({ uncertain: true })).toMatchObject({
			outcome: "released",
			row: { failedSend: { turnId: TURN, uncertain: true } },
		});
	});

	it("releaseClaim of a later claim whose turn is stored answers consumed", async () => {
		tables.elench_drafts?.push(sendingRow({ text: "send this\n" }));
		tables.agent_threads?.push(threadRow([userTurn("first", "hi"), userTurn(TURN, "send this")]));
		expect(await release()).toEqual({ outcome: "consumed", revision: 5 });
		expect(stored()).toMatchObject({ text: "", last_sent: { turnId: TURN } });
	});

	it("a later claim whose id is stored with another text is released with no turn id", async () => {
		tables.elench_drafts?.push(sendingRow({ text: "edited" }));
		tables.agent_threads?.push(threadRow([userTurn(TURN, "original")]));
		expect(await release({ uncertain: true })).toMatchObject({
			outcome: "released",
			row: { content: { text: "edited" }, failedSend: { turnId: null, uncertain: false } },
		});
	});

	it("releaseClaim with freshTurnId keeps the text, never consumes, and stores the fresh id on failed_send", async () => {
		tables.elench_drafts?.push(sendingRow({}));
		// The thread holds this very turn with this very text: without freshTurnId this would be S3.
		tables.agent_threads?.push(threadRow([userTurn(TURN, "send this")]));
		const out = await release({ error: "turn-committed-different-text", freshTurnId: FRESH, uncertain: true });
		expect(out).toMatchObject({
			outcome: "released",
			row: { content: { text: "send this" }, failedSend: { turnId: FRESH, uncertain: false } },
		});
		expect(stored()?.last_sent).toBeNull();
	});

	it("a stale token is not-claimed, and a live claim of the old age is never settled by its own release", async () => {
		tables.elench_drafts?.push(sendingRow({ ageSeconds: 600, claim_kind: "first" }));
		expect(await release()).toMatchObject({
			outcome: "released",
			row: { failedSend: { error: "502" } },
		});
		expect(await release()).toMatchObject({ outcome: "not-claimed", row: { state: "active" } });
	});
});

// ── S5: the lease settle ────────────────────────────────────────────────────────────────────────

describe("the lease settle (S5)", () => {
	it("a first-turn claim silent for 120 s is released by the next listDrafts with its text intact", async () => {
		tables.elench_drafts?.push(sendingRow({ claim_kind: "first", ageSeconds: 121 }));
		const out = await listDrafts({ projectId: null });
		if (out.outcome !== "ok") throw new Error(out.outcome);
		expect(out.drafts[0]?.row).toMatchObject({
			state: "active",
			claim: null,
			content: { text: "send this" },
			failedSend: { turnId: TURN, kind: "first", error: "lease", uncertain: false },
		});
	});

	it("a claim silent for 119 s is left alone", async () => {
		tables.elench_drafts?.push(sendingRow({ claim_kind: "first", ageSeconds: 119 }));
		await listDrafts({ projectId: null });
		await saveDraft({ ...key, baseRevision: 4, content: content("x"), tabId: "t" });
		expect(stored()?.status).toBe("sending");
		expect(writes()).toEqual([]);
	});

	it("a later-turn claim silent for 120 s: consumed if the transcript holds the turn, released uncertain otherwise", async () => {
		tables.elench_drafts?.push(sendingRow({ ageSeconds: 200 }));
		tables.agent_threads?.push(threadRow([userTurn("first", "hi"), userTurn(TURN, "send this")]));
		await listDrafts({ projectId: null });
		expect(stored()).toMatchObject({ status: "active", text: "", last_sent: { turnId: TURN } });

		tables.elench_drafts = [sendingRow({ ageSeconds: 200 })];
		tables.agent_threads = [threadRow([userTurn("first", "hi")])];
		await listDrafts({ projectId: null });
		expect(stored()).toMatchObject({
			status: "active",
			text: "send this",
			failed_send: { turnId: TURN, error: "lease", uncertain: true },
		});
	});

	it("the lease settle releases, not consumes, a claim whose stored turn has different text", async () => {
		tables.elench_drafts?.push(sendingRow({ text: "edited", ageSeconds: 200 }));
		tables.agent_threads?.push(threadRow([userTurn(TURN, "original")]));
		await listDrafts({ projectId: null });
		expect(stored()).toMatchObject({
			status: "active",
			text: "edited",
			last_sent: null,
			failed_send: { turnId: null, uncertain: false },
		});
	});

	it("a later turn typed with a trailing newline and stored trimmed is hasTurn, and S5 consumes it", async () => {
		tables.elench_drafts?.push(sendingRow({ text: "  deploy it\r\n", ageSeconds: 200 }));
		tables.agent_threads?.push(threadRow([userTurn(TURN, "deploy it")]));
		const out = await saveDraft({ ...key, baseRevision: 4, content: content("x"), tabId: "t" });
		// The settle consumed it (revision 5), so the save at the claim's base is a conflict.
		expect(out).toMatchObject({ outcome: "conflict", row: { revision: 5, content: { text: "" } } });
		expect(stored()?.last_sent).toMatchObject({ turnId: TURN });
	});

	it("saveDraft, discardDraft and a claim with another token each settle a silent claim first", async () => {
		tables.elench_drafts?.push(sendingRow({ claim_kind: "first", ageSeconds: 130 }));
		expect(await discardDraft({ ...key, baseRevision: 5 })).toMatchObject({ outcome: "discarded" });

		tables.elench_drafts = [sendingRow({ claim_kind: "first", ageSeconds: 130 })];
		expect(await claim({ baseRevision: 5, token: OTHER_TOKEN })).toMatchObject({
			outcome: "claimed-by-you",
			revision: 6,
		});
		expect(stored()?.claim_token).toBe(OTHER_TOKEN);
	});

	it("never settles another user's silent claim", async () => {
		tables.elench_drafts?.push(sendingRow({ user_id: TEAMMATE, claim_kind: "first", ageSeconds: 500 }));
		await listDrafts({ projectId: null });
		expect(tables.elench_drafts?.[0]?.status).toBe("sending");
	});
});

// ── S7: the heartbeat's transaction ─────────────────────────────────────────────────────────────

describe("the heartbeat route (S7)", () => {
	const beat = (body: unknown) =>
		heartbeat(
			new Request("http://localhost/api/elench/drafts/heartbeat", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		);

	it("the heartbeat route renews claimed_at for the live token, and for any other token renews nothing", async () => {
		const old = new Date(Date.now() - 100_000);
		tables.elench_drafts?.push(sendingRow({ claimed_at: old }));
		const res = await beat({ orgId: ORG_A, conversationId: CONV, token: TOKEN });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "touched" });
		const renewed = stored()?.claimed_at;
		expect(renewed instanceof Date && renewed.getTime() > old.getTime()).toBe(true);
		expect(stored()?.revision).toBe(4);

		const row = stored();
		if (row) row.claimed_at = old;
		const other = await beat({ orgId: ORG_A, conversationId: CONV, token: OTHER_TOKEN });
		expect(await other.json()).toMatchObject({ outcome: "not-claimed", row: { state: "sending" } });
		expect(stored()?.claimed_at).toBe(old);
	});

	it("never settles, even a silent claim it does not hold", async () => {
		tables.elench_drafts?.push(sendingRow({ ageSeconds: 600 }));
		const res = await beat({ orgId: ORG_A, conversationId: CONV, token: OTHER_TOKEN });
		expect(await res.json()).toMatchObject({ outcome: "not-claimed" });
		expect(stored()?.status).toBe("sending");
		expect(writes().filter((s) => s.sql.includes("now()"))).toEqual([]);
	});

	it("cannot renew another user's claim, even with its token", async () => {
		const old = new Date(Date.now() - 100_000);
		tables.elench_drafts?.push(sendingRow({ user_id: TEAMMATE, claimed_at: old }));
		const res = await beat({ orgId: ORG_A, conversationId: CONV, token: TOKEN });
		expect(await res.json()).toMatchObject({ outcome: "gone" });
		expect(tables.elench_drafts?.[0]?.claimed_at).toBe(old);
	});
});
