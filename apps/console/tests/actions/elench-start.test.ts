// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The A tests of ADR 0001 slice 5 (§5.1, §11, §14): `startConversation` from both origins, and
// `countDraftsOfConversation`. `deleteThread`'s purge is pinned in tests/actions/agent.test.ts, and
// its cross-org and other-user halves against Postgres in
// tests/integration/elench-drafts-threads.test.ts.
//
// As in tests/actions/elench-draft-claims.test.ts, the boundary is mocked and the actions are real.
// The database is an in-memory table set that RENDERS each statement with drizzle's own Postgres
// dialect and applies its equalities, `IS NULL` and `<>` to the rows, so a predicate an action drops
// (the `user_id` pin, the token match) is a predicate the fake stops applying. Two behaviours of
// Postgres the start relies on are modelled explicitly:
//   * `agent_threads.id` is a GLOBAL primary key: an insert under an id ANY row holds writes nothing,
//     whoever owns that row (RLS hides another owner's row from reads, never from the unique check);
//   * a savepoint (`tx.transaction`) that throws rolls back every write made inside it.
// The lease is read out of the rendered statement, as in the claim suite, on the test's clock.

import { PgDialect } from "drizzle-orm/pg-core";
import { Column, getTableName, is, SQL, Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorizeQuiet: vi.fn(),
}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));

import {
	countDraftsOfConversation,
	type StartConversationInput,
	startConversation,
} from "@/app/server/actions/elench-drafts";
import { getOwnerScope } from "@/lib/auth/owner";
import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

const USER = "00000000-0000-4000-8000-000000000001";
const STRANGER = "00000000-0000-4000-8000-000000000003";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const PROJECT = "00000000-0000-4000-8000-0000000000e1";
const CONV = "00000000-0000-4000-8000-0000000c0001";
const TURN = "00000000-0000-4000-8000-0000000d0001";
const OTHER_TURN = "00000000-0000-4000-8000-0000000d0002";
const TOKEN = "00000000-0000-4000-8000-0000000e0001";
const OTHER_TOKEN = "00000000-0000-4000-8000-0000000e0002";
/** The composer origin and a mention type, typed as their literals without a cast. */
const CLUSTER: "cluster" = "cluster";
const COMPOSER: "composer" = "composer";

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
/** The `revision` Postgres gives an inserted thread row (its column default is 1). */
let insertedThreadRevision: number;
/**
 * A row another transaction commits just before the next `elench_drafts` insert: a concurrent writer
 * landing first. It is that transaction's, so a rollback of this one never removes it.
 */
let concurrentDraft: Row | null;

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
	if (table === "elench_drafts" && silent(row, text) === false) return false;
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

/** A copy of every table, to restore when a savepoint rolls back. */
function snapshot(): Record<string, Row[]> {
	return Object.fromEntries(
		Object.entries(tables).map(([name, rows]) => [name, rows.map((r) => structuredClone(r))]),
	);
}

/** A drizzle-shaped transaction over `tables`. */
function fakeTx() {
	const tx = {
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
					if (st.table === "agent_threads") {
						const rows = tables.agent_threads ?? [];
						// The primary key is global: ANY owner's row holding the id blocks the insert.
						if (rows.some((r) => r.id === values.id)) return resolve([]);
						const row = threadRow([], { ...values, revision: insertedThreadRevision });
						const messages = Array.isArray(row.messages) ? row.messages : [];
						row.firstTurnId = messages[0]?.id ?? null;
						row.messageCount = messages.length;
						rows.push(row);
						return resolve([{ ...row }]);
					}
					if (concurrentDraft) {
						committedElsewhere.push(concurrentDraft);
						tables.elench_drafts?.push(concurrentDraft);
						concurrentDraft = null;
					}
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
			const st: Statement = { verb: "lock", table: "", ...render(q) };
			statements.push(st);
			if (st.sql.includes("count_elench_drafts_of_conversation")) {
				// The function's own predicate: the current owner (the actor), the conversation, any org.
				const n = (tables.elench_drafts ?? []).filter(
					(r) => r.user_id === actor.userId && r.conversation_id === st.params[0],
				).length;
				return Promise.resolve([{ n }]);
			}
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
		/** A savepoint: a throw inside rolls back every write made inside, then propagates. */
		async transaction<T>(fn: (sp: unknown) => Promise<T>): Promise<T> {
			const saved = snapshot();
			try {
				return await fn(tx);
			} catch (e) {
				tables = saved;
				tables.elench_drafts?.push(...committedElsewhere.map((r) => structuredClone(r)));
				throw e;
			}
		},
	};
	return tx;
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

/** The caller's first-turn claim on CONV, claimed `ageSeconds` ago. */
function claimedRow(over: Row & { ageSeconds?: number } = {}): Row {
	const { ageSeconds = 5, ...rest } = over;
	return draftRow({
		status: "sending",
		revision: 4,
		text: "  deploy staging \n",
		claim_token: TOKEN,
		claim_turn_id: TURN,
		claim_kind: "first",
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
		project_id: null,
		kind: "agent",
		status: "active",
		title: "A thread",
		messages,
		revision: 1,
		firstTurnId: messages[0]?.id ?? null,
		messageCount: messages.length,
		...over,
	};
}

const userTurn = (id: string, text: string): Row => ({ id, role: "user", parts: [{ type: "text", text }] });

/** The caller's draft row for CONV in the actor's org. */
const stored = () =>
	tables.elench_drafts?.find((r) => r.user_id === USER && r.org_id === actor.orgId && r.conversation_id === CONV);
/** The thread row holding CONV, whoever owns it. */
const thread = () => tables.agent_threads?.find((r) => r.id === CONV);
const writes = () => statements.filter((s) => s.verb === "insert" || s.verb === "update");

let actor: Actor;
/** Rows other transactions committed during this test (see {@link concurrentDraft}). */
let committedElsewhere: Row[];

beforeEach(() => {
	vi.clearAllMocks();
	tables = { elench_drafts: [], agent_threads: [], projects: [], member: [], organization: [] };
	statements = [];
	insertedThreadRevision = 1;
	concurrentDraft = null;
	committedElsewhere = [];
	actor = { userId: USER, orgId: ORG_A };
	vi.mocked(currentActor).mockImplementation(async () => actor);
	vi.mocked(authorizeQuiet).mockImplementation(async () => actor);
	vi.mocked(getOwnerScope).mockResolvedValue({ userId: USER, sessionId: "s" });
	vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, remaining: 19 });
	// The fake implements only the builder surface the code uses, so it crosses the seam untyped,
	// as the other action tests' chains do.
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx())) as never,
	);
	vi.mocked(getServiceDb).mockImplementation((() => fakeTx()) as never);
});

const key = { orgId: ORG_A, projectId: null, conversationId: CONV };

/** A composer start of CONV's first-turn claim under TOKEN. */
const composer = (over: Partial<Extract<StartConversationInput, { origin: "composer" }>> = {}) =>
	startConversation({ ...key, origin: "composer", turnId: TURN, token: TOKEN, revision: 4, title: "", ...over });

/** An external start of CONV with `text`, sent at draft revision `revision`. */
const external = (over: Partial<Extract<StartConversationInput, { origin: "external" }>> = {}) =>
	startConversation({
		...key,
		origin: "external",
		turnId: TURN,
		revision: 0,
		text: "show me the cluster",
		mentions: [],
		title: "",
		...over,
	});

// ── composer start: S2 and the fence ───────────────────────────────────────────────────────────

describe("startConversation, composer origin (S2)", () => {
	it("stores the locked row's trimmed text as the first turn in the parts form, and consumes the claim", async () => {
		tables.elench_drafts?.push(claimedRow());
		expect(await composer()).toEqual({ outcome: "created", revision: 5, threadRevision: 1 });
		expect(thread()).toMatchObject({
			user_id: USER,
			org_id: USER,
			project_id: null,
			title: "deploy staging",
			messages: [
				{
					id: TURN,
					role: "user",
					parts: [{ type: "text", text: "deploy staging" }],
					metadata: { mentions: [], cellTarget: null },
				},
			],
		});
		expect(stored()).toMatchObject({
			status: "active",
			revision: 5,
			text: "",
			mentions: [],
			artifacts: [],
			cell_target: null,
			claim_token: null,
			claim_turn_id: null,
			claim_kind: null,
			claimed_at: null,
			failed_send: null,
			thread_seen: true,
			last_sent: { turnId: TURN, kind: "first" },
		});
	});

	// B2 (#5512 rev-6 review, 625): a start queued behind Next's action queue for more than 120 s
	// must not settle its own claim and bounce the words back as a release.
	it("a composer start whose claim is 130 s old and whose token is live commits, and is not settled first", async () => {
		tables.elench_drafts?.push(claimedRow({ ageSeconds: 130 }));
		expect(await composer()).toMatchObject({ outcome: "created", revision: 5 });
		expect(thread()?.messages).toHaveLength(1);
		expect(stored()).toMatchObject({ status: "active", text: "", failed_send: null });
		// Nothing released it on the way: the only draft write is the consume.
		expect(writes().filter((w) => w.table === "elench_drafts")).toHaveLength(1);
	});

	// AC17: the start reads its text from its own locked row, never from the input.
	it("startConversation stores the locked row's text, not the input's", async () => {
		tables.elench_drafts?.push(claimedRow({ text: "the frozen words" }));
		const smuggled = { ...key, origin: COMPOSER, turnId: TURN, token: TOKEN, title: "", text: "other words" };
		expect(await startConversation(smuggled)).toMatchObject({ outcome: "created" });
		expect(thread()?.messages).toEqual([
			expect.objectContaining({ parts: [{ type: "text", text: "the frozen words" }] }),
		]);
	});

	it("reads the cell target and the mentions from the locked row, re-basing the spans onto the trimmed text", async () => {
		const mention = { id: "c-1", type: CLUSTER, label: "prod", start: 9, end: 14 };
		tables.elench_drafts?.push(
			claimedRow({ text: "   scale @prod  ", mentions: [mention], cell_target: { x: 2, y: 3 } }),
		);
		const smuggled = { ...key, origin: COMPOSER, turnId: TURN, token: TOKEN, title: "", cellTarget: { x: 0, y: 0 } };
		expect(await startConversation(smuggled)).toMatchObject({ outcome: "created" });
		const [first] = (thread()?.messages ?? []) as Row[];
		expect(first).toMatchObject({
			parts: [{ type: "text", text: "scale @prod" }],
			metadata: { mentions: [{ ...mention, start: 6, end: 11 }], cellTarget: { x: 2, y: 3 } },
		});
	});

	it("answers created with the inserted thread row's revision, and the draft's NEW revision", async () => {
		insertedThreadRevision = 7;
		tables.elench_drafts?.push(claimedRow({ revision: 11 }));
		expect(await composer()).toEqual({ outcome: "created", revision: 12, threadRevision: 7 });
		expect(stored()?.revision).toBe(12);
	});

	it("a start on a project anchor inserts the project's thread", async () => {
		tables.elench_drafts?.push(claimedRow({ project_id: PROJECT }));
		tables.projects?.push({ id: PROJECT, org_id: ORG_A });
		expect(await composer({ projectId: PROJECT })).toMatchObject({ outcome: "created" });
		expect(thread()?.project_id).toBe(PROJECT);
	});

	it("refuses a token that is not the claim's: not-claimed, and nothing is written", async () => {
		tables.elench_drafts?.push(claimedRow());
		expect(await composer({ token: OTHER_TOKEN })).toMatchObject({
			outcome: "not-claimed",
			row: { state: "sending", claim: { token: TOKEN } },
			thread: { status: "none", firstTurnId: null },
		});
		expect(writes()).toEqual([]);
		expect(thread()).toBeUndefined();
	});

	it("refuses another turn id and a later-turn claim: not-claimed, and nothing is written", async () => {
		tables.elench_drafts?.push(claimedRow());
		expect(await composer({ turnId: OTHER_TURN })).toMatchObject({ outcome: "not-claimed" });
		tables.elench_drafts = [claimedRow({ claim_kind: "later" })];
		expect(await composer()).toMatchObject({ outcome: "not-claimed" });
		expect(writes()).toEqual([]);
	});

	it("a released claim can never commit: an active row answers not-claimed with its text", async () => {
		tables.elench_drafts?.push(
			draftRow({ revision: 5, text: "kept", failed_send: { turnId: TURN, kind: "first", error: "500", at: "x", uncertain: false } }),
		);
		expect(await composer()).toMatchObject({ outcome: "not-claimed", row: { state: "active", content: { text: "kept" } } });
		expect(thread()).toBeUndefined();
	});

	// D35: a delete elsewhere purged the frozen row.
	it("answers gone when the draft row is gone, and stores nothing", async () => {
		expect(await composer()).toMatchObject({ outcome: "gone", thread: { status: "none" } });
		expect(thread()).toBeUndefined();
	});

	// Step 1's settle for a request that does NOT present the row's token: the silent claim is
	// another tab's, so it is settled first (released, as a first-turn claim reaching the lease is
	// unsent), and the answer carries the released row.
	it("a composer start with another token settles a silent claim first, and answers not-claimed with the released row", async () => {
		tables.elench_drafts?.push(claimedRow({ ageSeconds: 130 }));
		expect(await composer({ token: OTHER_TOKEN })).toMatchObject({
			outcome: "not-claimed",
			row: { state: "active", revision: 5, claim: null, failedSend: { turnId: TURN, error: "lease" } },
		});
		expect(stored()).toMatchObject({ status: "active", text: "  deploy staging \n" });
		expect(thread()).toBeUndefined();
	});

	it("a start with A's key from org B's page is scope-changed and stores nothing", async () => {
		tables.elench_drafts?.push(claimedRow());
		actor = { userId: USER, orgId: ORG_B };
		expect(await composer()).toEqual({ outcome: "scope-changed", reason: "other-org" });
		expect(statements).toEqual([]);
		expect(thread()).toBeUndefined();
	});

	it("a 100,000-unit draft of U+0001 starts and stores the turn", async () => {
		const text = "\u0001".repeat(100_000);
		tables.elench_drafts?.push(claimedRow({ text }));
		expect(await composer()).toMatchObject({ outcome: "created" });
		expect(thread()?.messages).toEqual([expect.objectContaining({ parts: [{ type: "text", text }] })]);
	});
});

// ── step 5: the insert wrote nothing ────────────────────────────────────────────────────────────

describe("startConversation, the conversation id is taken (§5.1 step 5)", () => {
	it("the caller's thread already holds this turn first: already-stored, and the claim is consumed", async () => {
		tables.agent_threads?.push(threadRow([userTurn(TURN, "deploy staging"), { id: "a1", role: "assistant", parts: [] }]));
		tables.elench_drafts?.push(claimedRow());
		expect(await composer()).toEqual({ outcome: "already-stored", revision: 5 });
		expect(stored()).toMatchObject({ status: "active", text: "", last_sent: { turnId: TURN }, thread_seen: true });
		// The stored turn is never rewritten.
		expect(thread()?.messages).toHaveLength(2);
	});

	it("a tombstoned id answers deleted, and the claim is released with its text", async () => {
		tables.agent_threads?.push(threadRow([], { status: "deleted", title: "" }));
		tables.elench_drafts?.push(claimedRow());
		expect(await composer()).toEqual({ outcome: "deleted", revision: 5 });
		expect(stored()).toMatchObject({
			status: "active",
			text: "  deploy staging \n",
			claim_token: null,
			failed_send: { turnId: TURN, kind: "first", error: "deleted", uncertain: false },
		});
	});

	it("another owner's row under the id (live or tombstone) answers conflict and is never read", async () => {
		for (const status of ["active", "deleted"]) {
			tables.agent_threads = [threadRow([userTurn(TURN, "theirs")], { user_id: STRANGER, org_id: STRANGER, status })];
			tables.elench_drafts = [claimedRow()];
			expect(await composer()).toEqual({ outcome: "conflict", revision: 5 });
			expect(stored()).toMatchObject({ status: "active", text: "  deploy staging \n", failed_send: { error: "conflict" } });
			// Theirs is untouched.
			expect(thread()).toMatchObject({ user_id: STRANGER, messages: [userTurn(TURN, "theirs")] });
		}
	});

	it("the caller's own row that this start cannot be the first turn of answers conflict", async () => {
		const cases: Row[] = [
			threadRow([userTurn(OTHER_TURN, "another first turn")]),
			threadRow([userTurn(TURN, "x")], { kind: "support" }),
			threadRow([userTurn(TURN, "x")], { project_id: PROJECT }),
			threadRow([]),
		];
		for (const t of cases) {
			tables.agent_threads = [t];
			tables.elench_drafts = [claimedRow()];
			expect(await composer()).toEqual({ outcome: "conflict", revision: 5 });
			expect(stored()?.failed_send).toMatchObject({ turnId: TURN, error: "conflict" });
		}
	});

	it("a start after the tombstone is reaped stores only the first turn", async () => {
		tables.elench_drafts?.push(claimedRow());
		expect(await composer()).toMatchObject({ outcome: "created" });
		expect(thread()?.messages).toEqual([expect.objectContaining({ id: TURN })]);
	});
});

// ── external start (D10x) ───────────────────────────────────────────────────────────────────────

describe("startConversation, external origin (D10x)", () => {
	it("an external start with no draft row inserts one (empty, revision 1) beside the thread", async () => {
		expect(await external({ text: "  show me the cluster\n", cellTarget: { x: 1, y: 0 } })).toEqual({
			outcome: "created",
			revision: 1,
			threadRevision: 1,
		});
		expect(thread()?.messages).toEqual([
			{
				id: TURN,
				role: "user",
				parts: [{ type: "text", text: "show me the cluster" }],
				metadata: { mentions: [], cellTarget: { x: 1, y: 0 } },
			},
		]);
		expect(stored()).toMatchObject({ status: "active", revision: 1, text: "", thread_seen: true, org_id: ORG_A });
	});

	// B2' delta finding (#5512 rev-7 review, 981): D10f's fencing save and the start can never both
	// commit. The save inserted the key between the start's lock read and its draft insert.
	it("an external start with no draft row inserts one, and loses to a base-0 save that inserted first", async () => {
		concurrentDraft = draftRow({
			revision: 1,
			text: "show me the cluster",
			failed_send: { turnId: TURN, kind: "first", error: "timeout", at: "x", uncertain: false },
		});
		expect(await external()).toMatchObject({
			outcome: "draft-conflict",
			row: { revision: 1, content: { text: "show me the cluster" }, failedSend: { turnId: TURN } },
			thread: { status: "none", firstTurnId: null },
		});
		// The thread insert rolled back with it: the prompt lives only in the box.
		expect(thread()).toBeUndefined();
	});

	it("leaves an active row's content as it is, clears its marker and moves its revision", async () => {
		tables.elench_drafts?.push(
			draftRow({ revision: 3, text: "my half-typed draft", failed_send: { turnId: OTHER_TURN, kind: "first", error: "500", at: "x", uncertain: false } }),
		);
		expect(await external({ revision: 3 })).toEqual({ outcome: "created", revision: 4, threadRevision: 1 });
		expect(stored()).toMatchObject({ revision: 4, text: "my half-typed draft", failed_send: null, thread_seen: true });
	});

	it("a row not at the start's revision answers draft-conflict and nothing is written", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 3, text: "moved" }));
		expect(await external({ revision: 2 })).toMatchObject({ outcome: "draft-conflict", row: { revision: 3 } });
		tables.elench_drafts = [draftRow({ revision: 3, status: "discarded", discarded_at: new Date() })];
		expect(await external({ revision: 3 })).toMatchObject({ outcome: "draft-conflict", row: { state: "discarded" } });
		expect(writes()).toEqual([]);
		expect(thread()).toBeUndefined();
	});

	it("a sending row answers claimed: an external prompt takes no claim", async () => {
		tables.elench_drafts?.push(claimedRow());
		expect(await external({ revision: 4 })).toMatchObject({ outcome: "claimed", row: { claim: { token: TOKEN } } });
		expect(writes()).toEqual([]);
	});

	// Step 1's settle for an external start: the silent claim is settled first, so the row it then
	// compares is the released one, a revision on.
	it("an external start settles a silent claim first, then compares the released row", async () => {
		tables.elench_drafts?.push(claimedRow({ ageSeconds: 130 }));
		expect(await external({ revision: 4 })).toMatchObject({
			outcome: "draft-conflict",
			row: { state: "active", revision: 5, failedSend: { error: "lease" } },
		});
		expect(thread()).toBeUndefined();
	});

	// G1: two starts at one base serialize on the draft row.
	it("two startConversation calls at one base: one created, one draft-conflict", async () => {
		tables.elench_drafts?.push(draftRow({ revision: 2 }));
		expect(await external({ revision: 2 })).toMatchObject({ outcome: "created", revision: 3 });
		expect(await external({ revision: 2, turnId: OTHER_TURN })).toMatchObject({
			outcome: "draft-conflict",
			row: { revision: 3 },
			thread: { status: "listed", firstTurnId: TURN },
		});
		expect(thread()?.messages).toHaveLength(1);
	});

	it("a taken id writes no draft row: conflict at revision 0 when there was none", async () => {
		tables.agent_threads?.push(threadRow([userTurn(OTHER_TURN, "x")]));
		expect(await external()).toEqual({ outcome: "conflict", revision: 0 });
		expect(stored()).toBeUndefined();
		tables.agent_threads = [threadRow([userTurn(TURN, "show me the cluster")])];
		expect(await external()).toEqual({ outcome: "already-stored", revision: 0 });
		expect(stored()).toBeUndefined();
	});

	it("refuses a blank prompt and invalid spans before touching the database", async () => {
		expect(await external({ text: " \n " })).toEqual({ outcome: "invalid" });
		expect(
			await external({ text: "hi", mentions: [{ id: "c", type: "cluster", label: "prod", start: 0, end: 5 }] }),
		).toEqual({ outcome: "invalid" });
		expect(statements).toEqual([]);
	});
});

// ── countDraftsOfConversation (§6.3) ────────────────────────────────────────────────────────────

describe("countDraftsOfConversation", () => {
	it("counts the caller's drafts of the conversation in every org through the owner-pinned function", async () => {
		tables.elench_drafts?.push(
			draftRow({ org_id: ORG_A }),
			draftRow({ org_id: ORG_B }),
			draftRow({ user_id: STRANGER, org_id: ORG_A }),
		);
		expect(await countDraftsOfConversation({ id: CONV })).toEqual({ outcome: "ok", count: 2, orgs: 2 });
		const call = statements.find((s) => s.sql.includes("count_elench_drafts_of_conversation"));
		expect(call?.sql).toBe("select public.count_elench_drafts_of_conversation($1::uuid) as n");
		expect(call?.params).toEqual([CONV]);
	});

	it("refuses an id that is not a uuid", async () => {
		expect(await countDraftsOfConversation({ id: "nope" })).toEqual({ outcome: "invalid" });
		expect(statements).toEqual([]);
	});
});
