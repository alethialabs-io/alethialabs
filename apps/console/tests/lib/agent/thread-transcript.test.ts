// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drizzle side of the transcript save the chat routes call (`saveThreadTranscript`): it writes
// under the owner the ROUTE authenticated, validates the target before touching the database, and
// each query reads only what `saveTranscript` asked for. Mocked boundary: `withOwnerScope` runs the
// real callback against a chain that records the predicates and values it is handed.

import type { UIMessage } from "ai";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The fake connection's state: queued query results, and what it was handed. */
interface FakeDb {
	results: unknown[][];
	owners: string[];
	where: unknown[];
	values: Record<string, unknown>[];
	sets: Record<string, unknown>[];
}
const db = vi.hoisted((): FakeDb => ({ results: [], owners: [], where: [], values: [], sets: [] }));

vi.mock("@/lib/db", () => {
	/** A chain whose every builder returns itself and whose awaited query takes the next result. */
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	Object.assign(chain, {
		update: self,
		set: (v: Record<string, unknown>) => {
			db.sets.push(v);
			return chain;
		},
		select: self,
		from: self,
		limit: self,
		insert: self,
		returning: self,
		onConflictDoNothing: self,
		where: (w: unknown) => {
			db.where.push(w);
			return chain;
		},
		values: (v: Record<string, unknown>) => {
			db.values.push(v);
			return chain;
		},
		then: (resolve: (v: unknown) => void) => resolve(db.results.shift() ?? []),
	});
	return {
		withOwnerScope: vi.fn(async (owner: string, cb: (tx: unknown) => unknown) => {
			db.owners.push(owner);
			return cb(chain);
		}),
	};
});
vi.mock("@/lib/observability/log", () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

import { saveThreadTranscript, transcriptRows } from "@/lib/agent/thread-transcript";
import { transcriptTargetSchema } from "@/lib/agent/transcript-save";
import { withOwnerScope } from "@/lib/db";
import { log } from "@/lib/observability/log";

/** Queue the results of the queries the next save awaits, in order. */
function useChain(results: unknown[][]) {
	db.results = results;
	db.owners = [];
	db.where = [];
	db.values = [];
	db.sets = [];
}

/** A recorded predicate as Postgres would receive it. */
function compiled(w: unknown): { sql: string; params: unknown[] } {
	if (!(w instanceof SQL)) throw new Error("not a drizzle predicate");
	return new PgDialect().sqlToQuery(w);
}

const T = "5b0f4f0e-6c43-4f39-9a52-0a0f6f2a6b11";
const messages: UIMessage[] = [
	{ id: "m-1", role: "user", parts: [{ type: "text", text: "deploy staging" }] },
	{ id: "m-2", role: "assistant", parts: [{ type: "text", text: "Planned." }] },
];

beforeEach(() => vi.clearAllMocks());

describe("saveThreadTranscript", () => {
	// #5423 review: the update matched on id and kind only, so the org route (`/api/agent`), named a
	// project thread's id, wrote over that thread's transcript. The route's project is matched too.
	it("updates only the live thread of the route's kind and project, under the route's owner", async () => {
		useChain([[{ id: T }]]);
		const outcome = await saveThreadTranscript(
			{ owner: "user-1", threadId: T, kind: "agent", projectId: null },
			messages,
		);
		expect(outcome).toEqual({ kind: "saved" });
		expect(db.owners).toEqual(["user-1"]);
		const q = compiled(db.where[0]);
		expect(q.sql).toMatch(
			/"id" = \$1 and "agent_threads"\."user_id" = \$2 and "agent_threads"\."kind" = \$3 and "agent_threads"\."project_id" is null and "agent_threads"\."status" <> \$4/,
		);
		expect(q.params).toEqual([T, "user-1", "agent", "deleted"]);
		// A write of `messages` is a new revision (ADR 0003 §4.2).
		expect(compiled(db.sets[0].revision).sql).toBe('"agent_threads"."revision" + 1');
	});

	it("a project route's update and recovery lookup match only that project's threads", async () => {
		const P = "7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
		const NEW = "0d6c1e2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a";
		// update: no live row; find: the tombstone; findRecovered: none; insert: the new id.
		useChain([[], [{ status: "deleted" }], [], [{ id: NEW }]]);
		await saveThreadTranscript({ owner: "user-1", threadId: T, kind: "agent", projectId: P }, messages);
		const update = compiled(db.where[0]);
		expect(update.sql).toMatch(/"agent_threads"\."project_id" = \$4/);
		expect(update.params).toEqual([T, "user-1", "agent", P, "deleted"]);
		const recovered = compiled(db.where[2]);
		expect(recovered.sql).toMatch(/"agent_threads"\."user_id" = \$2/);
		expect(recovered.sql).toMatch(/"agent_threads"\."project_id" = \$4/);
		expect(recovered.params).toContain(P);
	});

	it("recovers a deleted thread's turn into a new row it inserts, and logs that", async () => {
		// update: no live row; find: the tombstone; findRecovered: none; insert: the new id.
		const NEW = "0d6c1e2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a";
		useChain([[], [{ status: "deleted" }], [], [{ id: NEW }]]);
		const outcome = await saveThreadTranscript(
			{ owner: "user-1", threadId: T, kind: "agent", projectId: null },
			messages,
		);
		expect(outcome).toEqual({ kind: "recovered", threadId: NEW });
		const row = db.values[0];
		expect(row).not.toHaveProperty("id");
		expect(row).toMatchObject({
			user_id: "user-1",
			org_id: "user-1",
			kind: "agent",
			title: "Recovered: deploy staging",
		});
		expect(row.messages).toBe(messages);
		expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
	});

	it("recreates a reaped thread under its own id in the route's project", async () => {
		const P = "7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
		useChain([[], [], [{ id: T }]]);
		await saveThreadTranscript({ owner: "user-1", threadId: T, kind: "agent", projectId: P }, messages);
		expect(db.values[0]).toMatchObject({ id: T, project_id: P, kind: "agent" });
	});

	it("refuses a target that is not a route's own context before touching the database", async () => {
		useChain([]);
		const bad = [
			{ owner: "user-1", threadId: "t-1", kind: "agent", projectId: null },
			{ owner: "user-1", threadId: T, kind: "agent", projectId: "not-a-project" },
			{ owner: "", threadId: T, kind: "agent", projectId: null },
		] satisfies Parameters<typeof saveThreadTranscript>[0][];
		for (const target of bad) {
			await expect(saveThreadTranscript(target, messages)).rejects.toThrow();
		}
		// A kind the type does not admit is refused by the same schema the save parses with.
		expect(
			transcriptTargetSchema.safeParse({ owner: "user-1", threadId: T, kind: "admin", projectId: null })
				.success,
		).toBe(false);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

// ADR 0003 §7: the claim's two transcript writes. Both hold only at the caller's base revision, add
// one to it, and name the owner explicitly, because the claim runs them on the service role where RLS
// does not apply (§4.3).
describe("transcriptRows: appendLive and replaceLast", () => {
	const answer: UIMessage = { id: "m-3", role: "assistant", parts: [{ type: "text", text: "Done." }] };

	it("appendLive never writes a client list: the database appends only the new messages", async () => {
		useChain([[{ revision: 8 }]]);
		const revision = await withOwnerScope("user-1", (tx) =>
			transcriptRows(tx, "user-1").appendLive(T, "agent", null, 7, [answer]),
		);
		expect(revision).toBe(8);
		const set = db.sets[0];
		const appended = compiled(set.messages);
		expect(appended.sql).toBe('"agent_threads"."messages" || $1::jsonb');
		// Only the appended message travels: the stored transcript is never re-sent.
		expect(appended.params).toEqual([JSON.stringify([answer])]);
		expect(compiled(set.revision).sql).toBe('"agent_threads"."revision" + 1');
		const where = compiled(db.where[0]);
		expect(where.sql).toMatch(/"agent_threads"\."user_id" = \$2/);
		expect(where.sql).toMatch(/"agent_threads"\."status" <> \$4\) and "agent_threads"\."revision" = \$5/);
		expect(where.params).toEqual([T, "user-1", "agent", "deleted", 7]);
	});

	it("appendLive answers null when no row matched (a moved revision, or not live)", async () => {
		useChain([[]]);
		const revision = await withOwnerScope("user-1", (tx) =>
			transcriptRows(tx, "user-1").appendLive(T, "agent", null, 7, [answer]),
		);
		expect(revision).toBeNull();
	});

	it("replaceLast drops only the stored last element and appends the one message", async () => {
		useChain([[{ revision: 4 }]]);
		const revision = await withOwnerScope("user-1", (tx) =>
			transcriptRows(tx, "user-1").replaceLast(T, "agent", null, 3, answer),
		);
		expect(revision).toBe(4);
		const replaced = compiled(db.sets[0].messages);
		expect(replaced.sql).toBe(
			'("agent_threads"."messages" - (-1)) || jsonb_build_array($1::jsonb)',
		);
		expect(replaced.params).toEqual([JSON.stringify(answer)]);
		const where = compiled(db.where[0]);
		expect(where.sql).toMatch(/"agent_threads"\."revision" = \$5 and jsonb_array_length\("agent_threads"\."messages"\) > 0/);
		expect(where.params).toEqual([T, "user-1", "agent", "deleted", 3]);
	});

	it("replaceLast answers null when no row matched", async () => {
		useChain([[]]);
		const revision = await withOwnerScope("user-1", (tx) =>
			transcriptRows(tx, "user-1").replaceLast(T, "agent", null, 3, answer),
		);
		expect(revision).toBeNull();
	});
});
