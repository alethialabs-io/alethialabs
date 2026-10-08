// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The A tests of ADR 0001 slice 3 (§11, §14): the draft actions behind their preamble.
//
// The boundary is mocked, the actions and the gate are real. `currentActor`, `authorizeQuiet`,
// `getOwnerScope`, the rate limit and the database are faked:
//   - `authorizeQuiet` decides with the PDP's own pure rule (`decide` from lib/authz/evaluate.ts)
//     over a grant list, so "an org-wide grant" is the real coverage rule, which admits ANY project
//     id (A2);
//   - the database is an in-memory table set that RENDERS each statement's WHERE with drizzle's
//     own Postgres dialect and applies its conjunctive equalities, `IS NULL`, `<>` and `IN` to the
//     rows. So a predicate an action drops is a predicate the fake stops applying: the user_id
//     predicate on `agent_threads`, the compare-and-set on `revision` and the `projects.org_id` read
//     are each observed through what the action answers, not through a recorded call count.
//     One predicate is not an equality: `listDrafts`' 24-hour window on discarded rows. The fake
//     reads its interval OUT OF the rendered statement and fails closed when the shape is absent,
//     so dropping the window throws and widening it lists a row it must not. The real clock and
//     the real `now() - interval` are proved against Postgres in
//     tests/integration/elench-drafts-actions.test.ts, with §4.3's concurrent inserts;
//   - `tx.execute` (only §4.3's scope lock uses it) is recorded as a `lock` statement and changes
//     no row: what the lock serializes is observable only against a real database.

import { PgDialect } from "drizzle-orm/pg-core";
import { Column, getTableName, is, SQL, Table } from "drizzle-orm";
import { notFound } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn(), authorizeQuiet: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));

import {
	discardDraft,
	listDrafts,
	restoreDraft,
	saveDraft,
} from "@/app/server/actions/elench-drafts";
import { UnauthorizedError } from "@/lib/auth/errors";
import { getOwnerScope } from "@/lib/auth/owner";
import { decide } from "@/lib/authz/evaluate";
import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import type { DraftContent } from "@/lib/elench/draft-content";
import { checkRateLimit } from "@/lib/rate-limit";

// ── ids ──────────────────────────────────────────────────────────────────────────────────────────

const USER = "00000000-0000-4000-8000-000000000001";
const TEAMMATE = "00000000-0000-4000-8000-000000000002";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const PROJECT_A = "00000000-0000-4000-8000-00000000aa01";
const PROJECT_B = "00000000-0000-4000-8000-00000000bb01";
const CONV = "00000000-0000-4000-8000-0000000c0001";
const TURN = "00000000-0000-4000-8000-0000000d0001";

// ── the fake database ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Statement {
	verb: "select" | "insert" | "update" | "lock";
	table: string;
	sql: string;
	params: unknown[];
	forUpdate: boolean;
}

const dialect = new PgDialect({ casing: "snake_case" });

let tables: Record<string, Row[]>;
let statements: Statement[];
/** Runs once before the next insert lands: a concurrent writer racing the action. */
let beforeInsert: (() => void) | null;

/** Whether `row` satisfies every predicate shape the rendered WHERE carries. */
function matches(row: Row, table: string, text: string, params: unknown[]): boolean {
	const col = (t: string, c: string) => (t === table ? row[c] : undefined);
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)) {
		if (m[1] === table && col(m[1], m[2] ?? "") !== params[Number(m[3]) - 1]) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" <> \$(\d+)/g)) {
		if (m[1] === table && col(m[1], m[2] ?? "") === params[Number(m[3]) - 1]) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" is null/g)) {
		if (m[1] === table && col(m[1], m[2] ?? "") != null) return false;
	}
	for (const m of text.matchAll(/"(\w+)"\."(\w+)" in \((\$\d+(?:, \$\d+)*)\)/g)) {
		const allowed = (m[3] ?? "").split(", ").map((p) => params[Number(p.slice(1)) - 1]);
		if (m[1] === table && !allowed.includes(col(m[1], m[2] ?? ""))) return false;
	}
	// listDrafts' state filter: active and sending, plus discarded within the window the STATEMENT
	// names. The interval is parsed from the rendered SQL, never assumed, and a filter without one
	// is a defect the fake refuses rather than evaluates.
	if (text.includes(`in ('active', 'sending') or`)) {
		const discardWindow = text.match(
			/"elench_drafts"\."discarded_at" > now\(\) - interval '(\d+) hours'/,
		);
		if (!discardWindow) throw new Error(`fake: listDrafts' state filter has no discard window: ${text}`);
		const hours = Number(discardWindow[1]);
		const status = row.status;
		const at = row.discarded_at;
		const recent = at instanceof Date && at.getTime() > Date.now() - hours * 3600 * 1000;
		if (!(status === "active" || status === "sending" || (status === "discarded" && recent))) {
			return false;
		}
	}
	return true;
}

/**
 * A selected row: a column field reads the row's snake_case column (the production casing), any
 * other field (a `sql` expression) reads the row's key of the same alias, which the seed helpers
 * precompute.
 */
function project(row: Row, fields: Record<string, unknown> | undefined): Row {
	if (!fields) return { ...row };
	const out: Row = {};
	for (const [alias, field] of Object.entries(fields)) {
		out[alias] = is(field, Column)
			? row[field.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]
			: row[alias];
	}
	return out;
}

/** Renders a WHERE with the production dialect and casing. */
function render(where: SQL | undefined): { sql: string; params: unknown[] } {
	if (!where) return { sql: "", params: [] };
	const q = dialect.sqlToQuery(where);
	return { sql: q.sql, params: q.params };
}

/** A drizzle-shaped transaction over `tables`. */
function fakeTx() {
	return {
		select(fields?: Record<string, unknown>) {
			const st: Statement = { verb: "select", table: "", sql: "", params: [], forUpdate: false };
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
				for(mode: string) {
					st.forUpdate = mode === "update";
					return chain;
				},
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					try {
						statements.push(st);
						const rows = (tables[st.table] ?? []).filter((r) =>
							matches(r, st.table, st.sql, st.params),
						);
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
			const st: Statement = {
				verb: "insert",
				table: getTableName(t),
				sql: "",
				params: [],
				forUpdate: false,
			};
			let values: Row = {};
			let doNothing = false;
			const chain = {
				values(v: Row) {
					values = v;
					return chain;
				},
				onConflictDoNothing() {
					doNothing = true;
					return chain;
				},
				returning: () => chain,
				then(resolve: (v: unknown) => void) {
					statements.push(st);
					beforeInsert?.();
					beforeInsert = null;
					const rows = tables[st.table] ?? [];
					const clash = rows.some(
						(r) =>
							r.user_id === values.user_id &&
							r.org_id === values.org_id &&
							r.conversation_id === values.conversation_id,
					);
					if (clash) {
						if (doNothing) return resolve([]);
						throw new Error("unique violation");
					}
					const row = draftRow(values);
					rows.push(row);
					resolve([{ ...row }]);
				},
			};
			return chain;
		},
		execute(q: SQL) {
			const st: Statement = { verb: "lock", table: "", ...render(q), forUpdate: false };
			statements.push(st);
			return Promise.resolve([]);
		},
		update(t: Table) {
			const st: Statement = {
				verb: "update",
				table: getTableName(t),
				sql: "",
				params: [],
				forUpdate: false,
			};
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
					const hit = (tables[st.table] ?? []).filter((r) =>
						matches(r, st.table, st.sql, st.params),
					);
					for (const r of hit) {
						for (const [k, v] of Object.entries(patch)) r[k] = is(v, SQL) ? new Date() : v;
					}
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

/** An `agent_threads` row, with the derived columns `threadSummaryColumns` selects. */
function threadRow(over: Row & { messages?: Row[] }): Row {
	const messages = over.messages ?? [];
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

/** The caller's draft row for `conversationId` in `org`, as the fake holds it. */
function stored(conversationId = CONV, org = ORG_A): Row | undefined {
	return tables.elench_drafts?.find(
		(r) => r.user_id === USER && r.org_id === org && r.conversation_id === conversationId,
	);
}

const writes = () => statements.filter((s) => s.verb === "insert" || s.verb === "update");

// ── the actor and the PDP ───────────────────────────────────────────────────────────────────────

let actor: Actor;
/** The caller's `project:view` / `org:view` allow grants: `null` is org-wide. */
let grants: Array<string | null>;

beforeEach(() => {
	vi.clearAllMocks();
	tables = { elench_drafts: [], agent_threads: [], projects: [], member: [], organization: [] };
	statements = [];
	beforeInsert = null;
	actor = { userId: USER, orgId: ORG_A };
	grants = [null];
	tables.projects?.push({ id: PROJECT_A, org_id: ORG_A }, { id: PROJECT_B, org_id: ORG_B });

	vi.mocked(currentActor).mockImplementation(async () => actor);
	vi.mocked(authorizeQuiet).mockImplementation(async (action, resource) => {
		const a = await currentActor();
		if (!decide(grants, [], resource.id, [])) {
			throw new ForbiddenError(action, { type: resource.type, id: resource.id });
		}
		return a;
	});
	vi.mocked(getOwnerScope).mockResolvedValue({ userId: USER, sessionId: "s" });
	vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, remaining: 19 });
	// The fake implements only the builder surface the actions use, so it crosses the two seams
	// untyped, as the other action tests' chains do.
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx())) as never,
	);
	vi.mocked(getServiceDb).mockImplementation((() => fakeTx()) as never);
});

const text = (t: string): DraftContent => ({
	text: t,
	mentions: [],
	artifacts: [],
	cellTarget: null,
});

const save = (over: Partial<Parameters<typeof saveDraft>[0]> = {}) =>
	saveDraft({
		orgId: ORG_A,
		projectId: null,
		conversationId: CONV,
		baseRevision: 0,
		content: text("hello"),
		tabId: "tab-1",
		...over,
	});

// ── G17, G26, A12, A13: the org of the key and of the page (§4 steps 2-3) ───────────────────────

describe("the page org", () => {
	it("saveDraft with an orgId other than the page actor's is scope-changed and writes nothing", async () => {
		tables.elench_drafts?.push(draftRow({ org_id: ORG_B, revision: 2, text: "B's words" }));
		const out = await save({ orgId: ORG_B, baseRevision: 2, content: text("written under A") });
		expect(out).toEqual({ outcome: "scope-changed", reason: "other-org" });
		expect(statements).toEqual([]);
		expect(withActorScope).not.toHaveBeenCalled();
		expect(stored(CONV, ORG_B)?.text).toBe("B's words");
	});

	it("a renamed slug answers scope-changed with the new slug and writes nothing", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		tables.member?.push({ organization_id: ORG_A, user_id: USER, status: "active" });
		tables.organization?.push({ id: ORG_A, slug: "acme-renamed" });
		const out = await save({ content: text("keep me") });
		expect(out).toEqual({ outcome: "scope-changed", reason: "address", slug: "acme-renamed" });
		expect(writes()).toEqual([]);
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("a suspended member answers forbidden(membership) and writes nothing", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		tables.member?.push({ organization_id: ORG_A, user_id: USER, status: "suspended" });
		tables.organization?.push({ id: ORG_A, slug: "acme" });
		const out = await save();
		expect(out).toEqual({ outcome: "forbidden", reason: "membership" });
		expect(writes()).toEqual([]);
	});

	it("a removed member (no member row) answers forbidden(membership)", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		tables.member?.push({ organization_id: ORG_A, user_id: TEAMMATE, status: "active" });
		tables.organization?.push({ id: ORG_A, slug: "acme" });
		expect(await save()).toEqual({ outcome: "forbidden", reason: "membership" });
	});

	it("listDrafts on a renamed slug with orgHint answers scope-changed(address)", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		tables.member?.push({ organization_id: ORG_A, user_id: USER, status: "active" });
		tables.organization?.push({ id: ORG_A, slug: "acme-2" });
		expect(await listDrafts({ projectId: null, orgHint: ORG_A })).toEqual({
			outcome: "scope-changed",
			reason: "address",
			slug: "acme-2",
		});
		// Without a hint there is no org to ask about: the page itself is already a 404.
		expect(await listDrafts({ projectId: null })).toEqual({
			outcome: "forbidden",
			reason: "membership",
		});
	});

	it("community: a renamed slug answers address with slug ~", async () => {
		actor = { userId: USER, orgId: USER };
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		const out = await save({ orgId: USER });
		expect(out).toEqual({ outcome: "scope-changed", reason: "address", slug: "~" });
		expect(statements).toEqual([]);
	});

	it("a database error on the lost-scope read is unavailable, not a throw", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		const driver = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		vi.mocked(getServiceDb).mockImplementation(() => {
			throw Object.assign(new Error("Failed query"), { name: "DrizzleQueryError", cause: driver });
		});
		expect(await save()).toEqual({ outcome: "unavailable" });
		expect(await listDrafts({ projectId: null, orgHint: ORG_A })).toEqual({
			outcome: "unavailable",
		});
	});

	it("a session lost between the actor and the lost-scope read is unauthorized", async () => {
		vi.mocked(currentActor).mockImplementation(async () => notFound());
		vi.mocked(getOwnerScope).mockRejectedValue(new UnauthorizedError());
		expect(await save()).toEqual({ outcome: "unauthorized" });
	});

	it("rethrows a throw that is not an expected outcome (a redirect, a defect)", async () => {
		vi.mocked(currentActor).mockRejectedValue(new TypeError("boom"));
		await expect(save()).rejects.toThrow("boom");
	});
});

// ── A2: a project of this org (§4 step 4) ───────────────────────────────────────────────────────

describe("the project anchor", () => {
	it("saveDraft for a project of another org is forbidden, for a member with an org-wide project:view grant", async () => {
		grants = [null];
		const out = await save({ projectId: PROJECT_B });
		expect(out).toEqual({ outcome: "forbidden" });
		expect(writes()).toEqual([]);
		expect(tables.elench_drafts).toEqual([]);
		// The read that refused it named the actor's org.
		const read = statements.find((s) => s.table === "projects");
		expect(read?.params).toContain(ORG_A);
	});

	it("the same org-wide grant saves a draft for a project of this org", async () => {
		expect(await save({ projectId: PROJECT_A })).toEqual({ outcome: "saved", revision: 1 });
		expect(stored()?.project_id).toBe(PROJECT_A);
	});

	it("a project the PDP refuses is forbidden even when it is this org's", async () => {
		grants = ["some-other-project"];
		expect(await save({ projectId: PROJECT_A })).toEqual({ outcome: "forbidden" });
		expect(writes()).toEqual([]);
	});

	it("an org anchor is authorized quietly on the org", async () => {
		await save();
		expect(authorizeQuiet).toHaveBeenCalledWith("view", { type: "org" });
	});

	it("a key whose anchor differs from the stored row's is invalid and writes nothing", async () => {
		tables.elench_drafts?.push(draftRow({ project_id: PROJECT_A, revision: 1 }));
		expect(await save({ baseRevision: 1 })).toEqual({ outcome: "invalid" });
		expect(writes()).toEqual([]);
	});
});

// ── §4 step 5: the explicit user_id predicate on agent_threads ──────────────────────────────────

describe("agent_threads reads", () => {
	it("never see a teammate's thread whose org_id is the page org", async () => {
		tables.agent_threads?.push(
			threadRow({ user_id: TEAMMATE, org_id: ORG_A, messages: [{ id: TURN, role: "user", parts: [] }] }),
		);
		const out = await save({ baseRevision: 4 });
		expect(out).toEqual({
			outcome: "gone",
			thread: { status: "none", firstTurnId: null, hasTurn: false },
		});
		const threadReads = statements.filter((s) => s.table === "agent_threads");
		expect(threadReads.length).toBeGreaterThan(0);
		for (const s of threadReads) {
			expect(s.sql).toMatch(/"agent_threads"\."user_id" = \$\d+/);
			expect(s.params).toContain(USER);
		}
	});

	it("the hasTurn read of a claimed row names the caller too", async () => {
		tables.elench_drafts?.push(
			draftRow({
				status: "sending",
				revision: 2,
				text: "send this",
				claim_token: "00000000-0000-4000-8000-0000000e0003",
				claim_turn_id: TURN,
				claim_kind: "later",
				claimed_at: new Date(),
			}),
		);
		// A row that holds the turn but is a teammate's, ahead of the caller's own (which does not).
		tables.agent_threads?.push(
			threadRow({
				user_id: TEAMMATE,
				org_id: ORG_A,
				messages: [{ id: TURN, role: "user", parts: [{ type: "text", text: "send this" }] }],
			}),
			threadRow({ messages: [{ id: "first", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
		);
		expect(await save({ baseRevision: 2 })).toMatchObject({
			outcome: "claimed",
			thread: { status: "listed", firstTurnId: "first", hasTurn: false },
		});
		const threadReads = statements.filter((s) => s.table === "agent_threads");
		expect(threadReads).toHaveLength(2);
		for (const s of threadReads) expect(s.params).toContain(USER);
	});

	it("listDrafts reports the caller's own thread and ignores a teammate's", async () => {
		const other = "00000000-0000-4000-8000-0000000c0002";
		tables.elench_drafts?.push(draftRow({ text: "mine" }), draftRow({ conversation_id: other }));
		tables.agent_threads?.push(
			threadRow({ messages: [{ id: TURN, role: "user", parts: [{ type: "text", text: "hi" }] }] }),
			threadRow({ id: other, user_id: TEAMMATE, org_id: ORG_A, messages: [{ id: TURN }] }),
		);
		const out = await listDrafts({ projectId: null });
		if (out.outcome !== "ok") throw new Error(out.outcome);
		const byConv = new Map(out.drafts.map((d) => [d.row.conversationId, d]));
		expect(byConv.get(CONV)?.thread).toEqual({ status: "listed", firstTurnId: TURN, hasTurn: false });
		expect(byConv.get(CONV)?.threadTitle).toBe("A thread");
		expect(byConv.get(other)?.thread.status).toBe("none");
	});
});

// ── saveDraft: insert, compare-and-set, refusals ────────────────────────────────────────────────

describe("saveDraft", () => {
	it("inserts at base 0 and updates at the returned revision", async () => {
		expect(await save({ content: text("one") })).toEqual({ outcome: "saved", revision: 1 });
		expect(await save({ baseRevision: 1, content: text("two") })).toEqual({
			outcome: "saved",
			revision: 2,
		});
		expect(stored()).toMatchObject({ text: "two", revision: 2, last_writer: "tab-1" });
		const lock = statements.find((s) => s.table === "elench_drafts" && s.verb === "select");
		expect(lock?.forUpdate).toBe(true);
	});

	it("a stale base is conflict(row, thread) and writes nothing", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 5, text: "theirs" }));
		const out = await save({ baseRevision: 4, content: text("mine") });
		expect(out).toMatchObject({
			outcome: "conflict",
			row: { revision: 5, state: "active", content: { text: "theirs" } },
			thread: { status: "none", firstTurnId: null, hasTurn: false },
		});
		expect(writes()).toEqual([]);
		expect(stored()?.text).toBe("theirs");
	});

	it("the update is a compare-and-set on the base revision and the active state", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 3 }));
		await save({ baseRevision: 3, content: text("x") });
		const update = statements.find((s) => s.verb === "update");
		expect(update?.sql).toMatch(/"elench_drafts"\."revision" = \$\d+/);
		expect(update?.params).toContain(3);
		expect(update?.params).toContain("active");
	});

	it("base 0 on an existing row is conflict", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 1, text: "first tab" }));
		expect(await save()).toMatchObject({ outcome: "conflict", row: { revision: 1 } });
		expect(writes()).toEqual([]);
	});

	it("the row lock names the caller's user and org: a teammate's or another org's row under the same conversation is not this key's", async () => {
		tables.elench_drafts?.push(
			draftRow({ user_id: TEAMMATE, revision: 7, text: "teammate's" }),
			draftRow({ org_id: ORG_B, revision: 4, text: "mine in B" }),
		);
		expect(await save({ content: text("mine in A") })).toEqual({ outcome: "saved", revision: 1 });
		expect(stored()?.text).toBe("mine in A");
		const lock = statements.find((s) => s.table === "elench_drafts" && s.forUpdate);
		expect(lock?.sql).toMatch(/"elench_drafts"\."user_id" = \$\d+/);
		expect(lock?.sql).toMatch(/"elench_drafts"\."org_id" = \$\d+/);
	});

	it("a base-0 save that loses the insert race to another tab is conflict", async () => {
		beforeInsert = () => {
			tables.elench_drafts?.push(draftRow({ revision: 1, text: "other tab" }));
		};
		expect(await save({ content: text("this tab") })).toMatchObject({
			outcome: "conflict",
			row: { content: { text: "other tab" } },
		});
		expect(stored()?.text).toBe("other tab");
	});

	it("no row and a base above 0 is gone(thread), with a tombstone read as deleted", async () => {
		tables.agent_threads?.push(threadRow({ status: "deleted" }));
		expect(await save({ baseRevision: 3 })).toEqual({
			outcome: "gone",
			thread: { status: "deleted", firstTurnId: null, hasTurn: false },
		});
		expect(writes()).toEqual([]);
	});

	it("a sending row is claimed(row, thread) with the claim and hasTurn, and writes nothing", async () => {
		const claimedAt = new Date("2026-10-08T10:00:00Z");
		tables.elench_drafts?.push(
			draftRow({
				status: "sending",
				revision: 2,
				text: "  send this\r\n",
				claim_token: "00000000-0000-4000-8000-0000000e0001",
				claim_turn_id: TURN,
				claim_kind: "later",
				claimed_at: claimedAt,
			}),
		);
		tables.agent_threads?.push(
			threadRow({
				messages: [
					{ id: "first", role: "user", parts: [{ type: "text", text: "earlier" }] },
					{ id: TURN, role: "user", parts: [{ type: "text", text: "send this" }] },
				],
			}),
		);
		const out = await save({ baseRevision: 2, content: text("edit") });
		expect(out).toMatchObject({
			outcome: "claimed",
			row: {
				state: "sending",
				claim: {
					token: "00000000-0000-4000-8000-0000000e0001",
					turnId: TURN,
					kind: "later",
					claimedAt: claimedAt.toISOString(),
				},
			},
			thread: { status: "listed", firstTurnId: "first", hasTurn: true },
		});
		expect(writes()).toEqual([]);
	});

	it("hasTurn is false when the thread holds the claimed id with another text", async () => {
		tables.elench_drafts?.push(
			draftRow({
				status: "sending",
				revision: 2,
				text: "edited",
				claim_token: "00000000-0000-4000-8000-0000000e0001",
				claim_turn_id: TURN,
				claim_kind: "later",
				claimed_at: new Date(),
			}),
		);
		tables.agent_threads?.push(
			threadRow({ messages: [{ id: TURN, role: "user", parts: [{ type: "text", text: "original" }] }] }),
		);
		expect(await save({ baseRevision: 2 })).toMatchObject({
			outcome: "claimed",
			thread: { hasTurn: false },
		});
	});

	it("a discarded row is discarded(row, thread) and writes nothing", async () => {
		tables.elench_drafts?.push(
			draftRow({ status: "discarded", discarded_at: new Date(), revision: 3 }),
		);
		expect(await save({ baseRevision: 3 })).toMatchObject({
			outcome: "discarded",
			row: { state: "discarded" },
		});
		expect(writes()).toEqual([]);
	});

	it("sets thread_seen and the title only when the server finds the caller's thread", async () => {
		await save({ threadSeen: true });
		expect(stored()?.thread_seen).toBe(false);
		tables.agent_threads?.push(threadRow({ title: "Known", messages: [{ id: TURN }] }));
		await save({ baseRevision: 1, threadSeen: true });
		expect(stored()).toMatchObject({ thread_seen: true, title: "Known" });
		// Never on the client's word alone.
		const other = "00000000-0000-4000-8000-0000000c0003";
		await save({ conversationId: other, threadSeen: true });
		expect(stored(other)?.thread_seen).toBe(false);
	});

	it("clears a certain failed-send marker when the text changes, and keeps an uncertain one", async () => {
		const marker = { turnId: TURN, kind: "first", error: "500", at: "x", uncertain: false };
		tables.elench_drafts?.push(draftRow({ revision: 1, text: "a", failed_send: marker }));
		await save({ baseRevision: 1, content: text("a") });
		expect(stored()?.failed_send).toEqual(marker);
		await save({ baseRevision: 2, content: text("b") });
		expect(stored()?.failed_send).toBeNull();

		const uncertain = { ...marker, uncertain: true };
		const other = "00000000-0000-4000-8000-0000000c0004";
		tables.elench_drafts?.push(
			draftRow({ conversation_id: other, revision: 1, text: "a", failed_send: uncertain }),
		);
		await save({ conversationId: other, baseRevision: 1, content: text("b") });
		expect(stored(other)?.failed_send).toEqual(uncertain);
		await save({ conversationId: other, baseRevision: 2, content: text("b"), dismissFailedSend: true });
		expect(stored(other)?.failed_send).toBeNull();
	});

	it("saveDraft with failedSend writes the marker and the content in one compare-and-set", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 3, text: "what the box held" }));
		const content: DraftContent = {
			text: "fill this cell\n\nwhat the box held",
			mentions: [],
			artifacts: [],
			cellTarget: { x: 2, y: 1 },
		};
		const failedSend = { turnId: TURN, kind: "later" as const, error: "transcript-stale", uncertain: false };
		const out = await save({ baseRevision: 3, content, failedSend });
		expect(out).toEqual({ outcome: "saved", revision: 4 });
		const updates = statements.filter((s) => s.verb === "update");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.params).toContain(3);
		expect(stored()).toMatchObject({
			revision: 4,
			text: content.text,
			cell_target: { x: 2, y: 1 },
			failed_send: { ...failedSend, at: expect.any(String) },
		});

		// At a stale base neither half lands.
		statements = [];
		const stale = await save({ baseRevision: 3, content: text("late"), failedSend: { ...failedSend, error: "502" } });
		expect(stale).toMatchObject({ outcome: "conflict", row: { revision: 4 } });
		expect(writes()).toEqual([]);
		expect(stored()?.failed_send).toMatchObject({ error: "transcript-stale" });
		expect(stored()?.text).toBe(content.text);
	});

	it("a failedSend on a new row is written with the insert", async () => {
		const failedSend = { turnId: TURN, kind: "first" as const, error: "reload", uncertain: false };
		expect(await save({ failedSend })).toEqual({ outcome: "saved", revision: 1 });
		expect(stored()?.failed_send).toMatchObject(failedSend);
	});

	it("refuses an input that fails its schema, with no database work", async () => {
		expect(await save({ conversationId: "not-a-uuid" })).toEqual({ outcome: "invalid" });
		expect(
			await save({ failedSend: { turnId: null, kind: "first", error: "the user's words here", uncertain: false } }),
		).toEqual({ outcome: "invalid" });
		expect(currentActor).not.toHaveBeenCalled();
	});
});

// ── AC8: the bound (§4.3) ────────────────────────────────────────────────────────────────────────

describe("the bound", () => {
	it("the 201st new draft is refused with limit and existing rows still save", async () => {
		for (let i = 0; i < 200; i++) {
			tables.elench_drafts?.push(
				draftRow({ conversation_id: crypto.randomUUID(), revision: 1, text: `d${i}` }),
			);
		}
		const existing = tables.elench_drafts?.[0];
		expect(await save()).toEqual({ outcome: "limit" });
		expect(stored()).toBeUndefined();
		expect(
			await save({ conversationId: String(existing?.conversation_id), baseRevision: 1, content: text("edited") }),
		).toEqual({ outcome: "saved", revision: 2 });
		expect(tables.elench_drafts).toHaveLength(200);
	});

	it("the count runs after the scope's advisory lock, which names user, org and anchor", async () => {
		await save({ projectId: PROJECT_A });
		const lockAt = statements.findIndex((s) => s.verb === "lock");
		const countAt = statements.findIndex(
			(s) => s.table === "elench_drafts" && !s.forUpdate && s.verb === "select",
		);
		expect(lockAt).toBeGreaterThan(-1);
		expect(lockAt).toBeLessThan(countAt);
		expect(statements[lockAt]?.sql).toContain("pg_advisory_xact_lock");
		expect(statements[lockAt]?.params).toEqual([`elench-drafts:${USER}:${ORG_A}:${PROJECT_A}`]);
	});

	it("discarded drafts and other scopes do not count toward it", async () => {
		for (let i = 0; i < 199; i++) {
			tables.elench_drafts?.push(draftRow({ conversation_id: crypto.randomUUID() }));
		}
		tables.elench_drafts?.push(
			draftRow({ conversation_id: crypto.randomUUID(), status: "discarded", discarded_at: new Date() }),
			draftRow({ conversation_id: crypto.randomUUID(), project_id: PROJECT_A }),
		);
		expect(await save()).toEqual({ outcome: "saved", revision: 1 });
		const second = "00000000-0000-4000-8000-0000000c0005";
		expect(await save({ conversationId: second })).toEqual({ outcome: "limit" });
	});
});

// ── discardDraft / restoreDraft ─────────────────────────────────────────────────────────────────

describe("discardDraft and restoreDraft", () => {
	const key = { orgId: ORG_A, projectId: null, conversationId: CONV };

	it("discard at the base marks the row discarded and never touches agent_threads", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 2, text: "keep for a day" }));
		expect(await discardDraft({ ...key, baseRevision: 2 })).toEqual({
			outcome: "discarded",
			revision: 3,
		});
		expect(stored()).toMatchObject({ status: "discarded", text: "keep for a day" });
		expect(stored()?.discarded_at).toBeInstanceOf(Date);
		expect(writes().every((s) => s.table === "elench_drafts")).toBe(true);
	});

	it("discard at a stale base is conflict; on a sending row is claimed; with no row is gone", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 2 }));
		expect(await discardDraft({ ...key, baseRevision: 1 })).toMatchObject({ outcome: "conflict" });
		expect(stored()?.status).toBe("active");

		tables.elench_drafts = [
			draftRow({
				status: "sending",
				revision: 2,
				claim_token: "00000000-0000-4000-8000-0000000e0002",
				claim_turn_id: TURN,
				claim_kind: "first",
				claimed_at: new Date(),
			}),
		];
		expect(await discardDraft({ ...key, baseRevision: 2 })).toMatchObject({ outcome: "claimed" });
		expect(stored()?.status).toBe("sending");

		tables.elench_drafts = [];
		expect(await discardDraft({ ...key, baseRevision: 2 })).toMatchObject({ outcome: "gone" });
		expect(writes()).toEqual([]);
	});

	it("restore brings a discarded row back at its base, and refuses a stale one", async () => {
		tables.elench_drafts?.push(draftRow({ status: "discarded", discarded_at: new Date(), revision: 4 }));
		expect(await restoreDraft({ ...key, baseRevision: 3 })).toMatchObject({ outcome: "conflict" });
		expect(stored()?.status).toBe("discarded");
		expect(await restoreDraft({ ...key, baseRevision: 4 })).toEqual({ outcome: "saved", revision: 5 });
		expect(stored()).toMatchObject({ status: "active", discarded_at: null });
		// An active row is not restorable: conflict, not a second write.
		expect(await restoreDraft({ ...key, baseRevision: 5 })).toMatchObject({ outcome: "conflict" });
		expect(await restoreDraft({ ...key, conversationId: TURN, baseRevision: 1 })).toMatchObject({
			outcome: "gone",
		});
	});

	it("discard and restore pass through the same preamble", async () => {
		expect(await discardDraft({ ...key, orgId: ORG_B, baseRevision: 1 })).toEqual({
			outcome: "scope-changed",
			reason: "other-org",
		});
		expect(await restoreDraft({ ...key, baseRevision: -1 })).toEqual({ outcome: "invalid" });
		expect(statements).toEqual([]);
	});
});

// ── listDrafts ──────────────────────────────────────────────────────────────────────────────────

describe("listDrafts", () => {
	it("lists this scope's active and sending drafts and those discarded in the last 24 hours", async () => {
		const id = (n: number) => `00000000-0000-4000-8000-0000000f000${n}`;
		tables.elench_drafts?.push(
			draftRow({ conversation_id: id(1) }),
			draftRow({
				conversation_id: id(2),
				status: "sending",
				claim_token: id(9),
				claim_turn_id: TURN,
				claim_kind: "first",
				claimed_at: new Date(),
			}),
			draftRow({ conversation_id: id(3), status: "discarded", discarded_at: new Date() }),
			draftRow({
				conversation_id: id(4),
				status: "discarded",
				discarded_at: new Date(Date.now() - 25 * 3600 * 1000),
			}),
			draftRow({ conversation_id: id(5), project_id: PROJECT_A }),
			draftRow({ conversation_id: id(6), org_id: ORG_B }),
			draftRow({ conversation_id: id(7), user_id: TEAMMATE }),
		);
		const out = await listDrafts({ projectId: null });
		if (out.outcome !== "ok") throw new Error(out.outcome);
		expect(out.orgId).toBe(ORG_A);
		expect(out.drafts.map((d) => d.row.conversationId).sort()).toEqual([id(1), id(2), id(3)]);
		expect(out.drafts.find((d) => d.row.conversationId === id(2))?.row.claim?.turnId).toBe(TURN);

		const project = await listDrafts({ projectId: PROJECT_A });
		if (project.outcome !== "ok") throw new Error(project.outcome);
		expect(project.drafts.map((d) => d.row.conversationId)).toEqual([id(5)]);
	});

	it("never returns the row id or the user", async () => {
		tables.elench_drafts?.push(draftRow({}));
		const out = await listDrafts({ projectId: null });
		if (out.outcome !== "ok") throw new Error(out.outcome);
		const row = out.drafts[0]?.row;
		expect(row).toBeDefined();
		expect(Object.keys(row ?? {})).not.toContain("id");
		expect(JSON.stringify(row)).not.toContain(USER);
	});
});

// ── §4 steps 6-7: the remaining refusals ────────────────────────────────────────────────────────

describe("the preamble's refusals", () => {
	it("no session is unauthorized", async () => {
		vi.mocked(currentActor).mockRejectedValue(new UnauthorizedError());
		expect(await save()).toEqual({ outcome: "unauthorized" });
	});

	it("over the per-user rate is rate-limited, before any authorization or write", async () => {
		vi.mocked(checkRateLimit).mockResolvedValue({ ok: false, remaining: 0 });
		expect(await save()).toEqual({ outcome: "rate-limited" });
		expect(checkRateLimit).toHaveBeenCalledWith(`elench-drafts:${USER}`, 20, 1000);
		expect(authorizeQuiet).not.toHaveBeenCalled();
		expect(statements).toEqual([]);
	});

	it("a database error is unavailable", async () => {
		const driver = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		vi.mocked(withActorScope).mockRejectedValue(
			Object.assign(new Error("Failed query"), { name: "DrizzleQueryError", cause: driver }),
		);
		expect(await save()).toEqual({ outcome: "unavailable" });
		expect(await listDrafts({ projectId: null })).toEqual({ outcome: "unavailable" });
	});

	it("a resolver that landed on another org is forbidden", async () => {
		vi.mocked(currentActor).mockRejectedValue(
			new ForbiddenError("view", { type: "org", id: ORG_A }, "resolver"),
		);
		expect(await save()).toEqual({ outcome: "forbidden" });
	});
});
