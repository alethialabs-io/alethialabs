// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the agent-thread actions: stub requireOwner + withOwnerScope
// (run the real callback against a thenable drizzle chain that records .values()/.set()/.where()
// writes), keep titleFrom real, and assert the owner-scoping, title derivation, returned shapes,
// and which write each mutating action issues.

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));

// Spy on the drizzle predicate builders (keeping their real behavior) so the tests can assert
// the ACTUAL scoping predicate each query builds — `eq(project_id, id)` vs `isNull(project_id)` —
// rather than only counting `.where()` calls. The schema module imports the same (spread) module,
// so table/column construction is unaffected.
vi.mock("drizzle-orm", async (importActual) => {
	const actual = await importActual<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: vi.fn(actual.eq),
		isNull: vi.fn(actual.isNull),
	};
});

import * as agentActions from "@/app/server/actions/agent";
import {
	createThread,
	deleteThread,
	getThread,
	listThreads,
	renameThread,
} from "@/app/server/actions/agent";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { eq, isNull, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentThreads } from "@/lib/db/schema";

/**
 * A drizzle-ish chain whose every builder returns itself, awaits to `rows`, and records the
 * args handed to the mutating verbs so tests can assert the exact write.
 */
function mockChain(rows: unknown[], sequence: unknown[][] = []) {
	const calls = {
		insert: vi.fn(),
		values: vi.fn(),
		update: vi.fn(),
		set: vi.fn(),
		where: vi.fn(),
		delete: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
		for: vi.fn(),
		onConflictDoNothing: vi.fn(),
		returning: vi.fn(),
	};
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		insert: (...a: unknown[]) => {
			calls.insert(...a);
			return db;
		},
		values: (...a: unknown[]) => {
			calls.values(...a);
			return db;
		},
		returning: (...a: unknown[]) => {
			calls.returning(...a);
			return db;
		},
		onConflictDoNothing: (...a: unknown[]) => {
			calls.onConflictDoNothing(...a);
			return db;
		},
		select: () => db,
		from: () => db,
		orderBy: (...a: unknown[]) => {
			calls.orderBy(...a);
			return db;
		},
		update: (...a: unknown[]) => {
			calls.update(...a);
			return db;
		},
		set: (...a: unknown[]) => {
			calls.set(...a);
			return db;
		},
		where: (...a: unknown[]) => {
			calls.where(...a);
			return db;
		},
		limit: (...a: unknown[]) => {
			calls.limit(...a);
			return db;
		},
		for: (...a: unknown[]) => {
			calls.for(...a);
			return db;
		},
		delete: (...a: unknown[]) => {
			calls.delete(...a);
			return db;
		},
		// Each awaited query takes the next queued result, then `rows` once the queue is empty.
		then: (resolve: (v: unknown) => void) => resolve(sequence.shift() ?? rows),
	});
	return { db, calls };
}

/** Wire withOwnerScope to invoke the real callback against the given chain. `sequence` holds
 * per-query results in await order (e.g. the first-turn lookup, then the insert). */
function useChain(rows: unknown[], sequence: unknown[][] = []) {
	const { db, calls } = mockChain(rows, sequence);
	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	return { calls };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireOwner).mockResolvedValue("user-1");
});

describe("createThread", () => {
	it("inserts an owner-scoped row whose title is derived from the first message", async () => {
		const row = { id: "t-1", title: "Hello world", user_id: "user-1", org_id: "user-1" };
		const { calls } = useChain([row]);

		const thread = await createThread("  Hello   world  ");

		expect(thread).toBe(row);
		// Owner scope is passed through to withOwnerScope.
		expect(vi.mocked(withOwnerScope).mock.calls[0][0]).toBe("user-1");
		// Inserted values: owner used for both user_id and org_id, normalized title.
		// No projectId → the org-level path omits project_id entirely.
		expect(calls.values).toHaveBeenCalledWith({
			user_id: "user-1",
			org_id: "user-1",
			title: "Hello world",
		});
	});

	it("scopes the thread to a project when a projectId is given", async () => {
		const { calls } = useChain([{ id: "t-p" }]);
		await createThread("Deploy prod", "proj-9");
		expect(calls.values).toHaveBeenCalledWith({
			user_id: "user-1",
			org_id: "user-1",
			title: "Deploy prod",
			project_id: "proj-9",
		});
	});

	it("falls back to 'New chat' when no first message is given", async () => {
		const { calls } = useChain([{ id: "t-2" }]);
		await createThread();
		expect(calls.values.mock.calls[0][0].title).toBe("New chat");
	});

	it("truncates a long first message to a 60-char ellipsized title", async () => {
		const { calls } = useChain([{ id: "t-3" }]);
		const long = "a".repeat(100);
		await createThread(long);
		const title: string = calls.values.mock.calls[0][0].title;
		expect(title.length).toBe(58); // 57 chars + ellipsis
		expect(title.endsWith("…")).toBe(true);
		expect(title.startsWith("a".repeat(57))).toBe(true);
	});

	// #5414 / the #5423 ruling: the assistant reply is persisted only by the streaming route's
	// onFinish, which never runs when the turn fails (AI off → 503 before any stream). The user's
	// first message must therefore be stored BY THE INSERT, or the row keeps zero messages,
	// listThreads hides it, and the typed message vanishes on reload.
	it("stores the first user turn as the thread's transcript in the same insert", async () => {
		// The idempotency lookup finds no row holding this turn, so the insert runs.
		const { calls } = useChain([{ id: "t-turn" }], [[]]);
		await createThread("persisted elench thread", undefined, {
			id: "msg-1",
			text: "persisted elench thread",
		});
		expect(calls.insert).toHaveBeenCalledTimes(1);
		expect(calls.update).not.toHaveBeenCalled();
		expect(calls.values).toHaveBeenCalledWith({
			user_id: "user-1",
			org_id: "user-1",
			title: "persisted elench thread",
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", text: "persisted elench thread" }],
				},
			],
		});
	});

	it("stores the first turn on a project-scoped thread too", async () => {
		const { calls } = useChain([{ id: "t-pturn" }], [[]]);
		await createThread("Deploy prod", "proj-9", { id: "msg-2", text: "Deploy prod" });
		const values = calls.values.mock.calls[0][0];
		expect(values.project_id).toBe("proj-9");
		expect(values.messages).toEqual([
			{ id: "msg-2", role: "user", parts: [{ type: "text", text: "Deploy prod" }] },
		]);
	});

	it("leaves the transcript to its column default when no first turn is given", async () => {
		const { calls } = useChain([{ id: "t-art" }]);
		await createThread("An artifact", undefined, undefined);
		expect(calls.values.mock.calls[0][0]).not.toHaveProperty("messages");
	});

	it("refuses a blank first turn before touching the database", async () => {
		useChain([{ id: "t-blank" }]);
		await expect(
			createThread("x", undefined, { id: "msg-3", text: "   " }),
		).rejects.toThrow();
		await expect(
			createThread("x", undefined, { id: "", text: "hello" }),
		).rejects.toThrow();
		expect(withOwnerScope).not.toHaveBeenCalled();
	});

	// The stored first turn is capped by the SAME constant the chat routes 413 on and the
	// composer refuses at — one number, so the action never rejects a turn the route would take.
	it("stores a first turn of exactly the shared limit and refuses one character more", async () => {
		const { calls } = useChain([{ id: "t-max" }], [[]]);
		const atLimit = "a".repeat(MAX_USER_MESSAGE_CHARS);
		await createThread("long", undefined, { id: "msg-max", text: atLimit });
		expect(calls.values.mock.calls[0][0].messages[0].parts[0].text).toHaveLength(
			MAX_USER_MESSAGE_CHARS,
		);
		vi.mocked(withOwnerScope).mockClear();
		await expect(
			createThread("long", undefined, { id: "msg-over", text: `${atLimit}a` }),
		).rejects.toThrow();
		expect(withOwnerScope).not.toHaveBeenCalled();
	});

	// The #5423 review: a server action can fail AFTER its insert committed (the response is
	// lost). The client retries with the SAME first-turn id; a second insert would leave two
	// threads holding one message, one of them never answered.
	it("returns the row a lost response already committed for this turn id, inserting nothing", async () => {
		const stored = {
			id: "t-committed",
			messages: [{ id: "msg-r", role: "user", parts: [{ type: "text", text: "hello" }] }],
		};
		const rewritten = { ...stored, title: "hello", revision: 2 };
		// 1st await: the lookup finds the committed row; 2nd: no running claim; 3rd: the rewrite
		// returns it.
		const { calls } = useChain([], [[stored], [], [rewritten]]);
		const thread = await createThread("hello", undefined, { id: "msg-r", text: "hello" });
		expect(thread).toBe(rewritten);
		expect(calls.insert).not.toHaveBeenCalled();
		expect(calls.update).toHaveBeenCalledTimes(1);
		expect(calls.set.mock.calls[0][0]).toMatchObject({
			title: "hello",
			messages: [{ id: "msg-r", role: "user", parts: [{ type: "text", text: "hello" }] }],
		});
	});

	// ADR 0003 §4.2: every write to `messages` bumps `revision` in the same UPDATE, and the rewrite
	// runs under the thread row's lock so its running-claim probe cannot race an acceptance.
	it("locks the committed row, and its rewrite bumps revision in the same UPDATE", async () => {
		const stored = { id: "t-rev", revision: 4, messages: [] };
		const { calls } = useChain([], [[stored], [], [{ ...stored, revision: 5 }]]);
		const thread = await createThread("hello", undefined, { id: "msg-rev", text: "hello" });
		expect(thread).toMatchObject({ revision: 5 });
		expect(calls.for).toHaveBeenCalledWith("update");
		const revision: unknown = calls.set.mock.calls[0][0].revision;
		if (!(revision instanceof SQL)) throw new Error("revision is not a SQL expression");
		expect(new PgDialect().sqlToQuery(revision).sql).toBe('"agent_threads"."revision" + 1');
	});

	it("does nothing while the thread has a running turn claim, returning the row unchanged", async () => {
		const stored = { id: "t-busy", revision: 3, messages: [] };
		// 2nd await: the running-claim probe finds one.
		const { calls } = useChain([], [[stored], [{ id: "claim-1" }]]);
		const thread = await createThread("edited", undefined, { id: "msg-b", text: "edited" });
		expect(thread).toBe(stored);
		expect(calls.update).not.toHaveBeenCalled();
		expect(calls.insert).not.toHaveBeenCalled();
	});

	it("keeps the committed row when it already holds more than the first turn", async () => {
		const stored = { id: "t-answered", messages: [] };
		// No running claim; the rewrite is guarded to a one-message transcript and matches nothing here.
		const { calls } = useChain([], [[stored], [], []]);
		const thread = await createThread("hello", undefined, { id: "msg-a", text: "hello" });
		expect(thread).toBe(stored);
		expect(calls.insert).not.toHaveBeenCalled();
	});

	it("does not look a turn up when no first turn is given (an artifact's new chat)", async () => {
		const { calls } = useChain([{ id: "t-plain" }]);
		await createThread("An artifact");
		expect(calls.where).not.toHaveBeenCalled();
		expect(calls.insert).toHaveBeenCalledTimes(1);
	});

	it("throws when there is no authenticated owner", async () => {
		vi.mocked(requireOwner).mockRejectedValue(new Error("Unauthorized"));
		await expect(createThread("x")).rejects.toThrow(/Unauthorized/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("listThreads", () => {
	it("reaps stale empties, then returns the owner's threads scoped to project_id IS NULL", async () => {
		const rows = [{ id: "t-1" }, { id: "t-2" }];
		const { calls } = useChain(rows);
		const result = await listThreads();
		expect(result).toBe(rows);
		// A reap delete runs first, then the guarded org-level select (kind='agent' AND
		// project_id IS NULL AND non-empty) and an order — two .where()s and one delete.
		expect(calls.delete).toHaveBeenCalledTimes(1);
		expect(calls.where).toHaveBeenCalledTimes(2);
		expect(calls.orderBy).toHaveBeenCalledTimes(1);
		// The listing predicate: kind='agent' + project_id IS NULL (no eq on project_id).
		expect(vi.mocked(eq)).toHaveBeenCalledWith(agentThreads.kind, "agent");
		expect(vi.mocked(isNull)).toHaveBeenCalledWith(agentThreads.project_id);
		expect(vi.mocked(eq)).not.toHaveBeenCalledWith(
			agentThreads.project_id,
			expect.anything(),
		);
	});

	it("scopes listing to eq(project_id, id) when a projectId is given (no IS NULL)", async () => {
		const rows = [{ id: "t-p" }];
		const { calls } = useChain(rows);
		const result = await listThreads("proj-9");
		expect(result).toBe(rows);
		// Reap delete + guarded select.
		expect(calls.delete).toHaveBeenCalledTimes(1);
		expect(calls.where).toHaveBeenCalledTimes(2);
		expect(calls.orderBy).toHaveBeenCalledTimes(1);
		// The actual predicate: kind='agent' + project_id = 'proj-9'; never IS NULL.
		expect(vi.mocked(eq)).toHaveBeenCalledWith(agentThreads.project_id, "proj-9");
		expect(vi.mocked(isNull)).not.toHaveBeenCalledWith(agentThreads.project_id);
	});
});

describe("getThread", () => {
	it("returns the first matching row with no inFlight when no claim is running", async () => {
		const row = { id: "t-7", title: "Found", revision: 3 };
		const { calls } = useChain([], [[row], []]);
		const thread = await getThread("t-7");
		expect(thread).toEqual({ ...row, inFlight: null });
		expect(calls.limit).toHaveBeenCalledWith(1);
		expect(calls.where).toHaveBeenCalledTimes(2);
	});

	// ADR 0003 §4.2: inFlight comes from a running claim whose lease is NOT silent, so a dead
	// process's claim does not show "Being answered" while it waits for the sweep.
	it("returns inFlight from a running claim, reading only a claim whose lease is not silent", async () => {
		const row = { id: "t-8", title: "Busy", revision: 2 };
		const since = new Date("2026-10-08T10:00:00Z");
		const { calls } = useChain([], [[row], [{ turnId: "msg-9", since }]]);
		const thread = await getThread("t-8");
		expect(thread).toEqual({ ...row, inFlight: { turnId: "msg-9", since } });
		const where = calls.where.mock.calls[1][0];
		if (!(where instanceof SQL)) throw new Error("not a drizzle predicate");
		const q = new PgDialect().sqlToQuery(where);
		expect(q.sql).toMatch(/"agent_turn_claims"\."state" = \$\d/);
		expect(q.params).toContain("running");
		expect(q.sql).toMatch(/"agent_turn_claims"\."lease_until" >= now\(\)/);
	});

	it("returns null when no row matches", async () => {
		useChain([]);
		expect(await getThread("missing")).toBeNull();
	});
});

describe("renameThread", () => {
	it("updates the title (and bumps updated_at) for the given id", async () => {
		const { calls } = useChain([]);
		await renameThread("t-1", "Renamed");
		expect(calls.update).toHaveBeenCalledTimes(1);
		const setArg = calls.set.mock.calls[0][0];
		expect(setArg.title).toBe("Renamed");
		expect(setArg.updated_at).toBeDefined(); // sql`now()`
		expect(calls.where).toHaveBeenCalledTimes(1);
	});
});

// #5423 review (security): `saveThreadMessages` lived in this "use server" file, so Next compiled it
// into a POST-addressable action — and once it could INSERT, any client could create a thread with
// an id, kind, project and transcript of its choosing. Every export of this file is reachable from
// a browser; the transcript write is not one of them.
describe("the action surface", () => {
	it("exports no transcript write: only the thread actions a client may call", () => {
		expect(Object.keys(agentActions).sort()).toEqual([
			"createThread",
			"deleteThread",
			"getThread",
			"listThreads",
			"renameThread",
		]);
	});

	it("keeps the transcript write in a module that is not a server action and is server-only", () => {
		const src = readFileSync(
			path.resolve(__dirname, "../../lib/agent/thread-transcript.ts"),
			"utf8",
		);
		expect(src).not.toMatch(/^\s*["']use server["'];?\s*$/m);
		expect(src).toMatch(/^import "server-only";$/m);
	});
});

describe("deleteThread", () => {
	// A late save (a turn still streaming at the delete) must be able to tell the user's delete from
	// the reap of an empty row, or it recreates the thread the user just deleted (#5423 review).
	it("replaces the row with a tombstone under the same id, carrying no title and no messages", async () => {
		const removed = { user_id: "user-1", org_id: "org-1", project_id: "proj-3", kind: "agent" };
		const { calls } = useChain([], [[removed], []]);
		await deleteThread("t-1");
		expect(calls.delete).toHaveBeenCalledTimes(1);
		expect(calls.insert).toHaveBeenCalledWith(agentThreads);
		expect(calls.values).toHaveBeenCalledWith({
			id: "t-1",
			user_id: "user-1",
			org_id: "org-1",
			project_id: "proj-3",
			kind: "agent",
			title: "",
			status: "deleted",
		});
		// Owner scope is forwarded.
		expect(vi.mocked(withOwnerScope).mock.calls[0][0]).toBe("user-1");
	});

	it("writes no tombstone when there was no live thread to delete", async () => {
		const { calls } = useChain([], [[]]);
		await deleteThread("t-none");
		expect(calls.delete).toHaveBeenCalledTimes(1);
		expect(calls.insert).not.toHaveBeenCalled();
	});
});

describe("a deleted thread's tombstone is no thread", () => {
	/** The SQL text and params of a recorded `.where()` predicate, as Postgres would receive them. */
	function compiled(where: unknown): { sql: string; params: unknown[] } {
		if (!(where instanceof SQL)) throw new Error("not a drizzle predicate");
		return new PgDialect().sqlToQuery(where);
	}

	it("getThread and renameThread match only a live row", async () => {
		const { calls } = useChain([]);
		await getThread("t-1");
		await renameThread("t-1", "x");
		for (const [where] of calls.where.mock.calls) {
			const q = compiled(where);
			expect(q.sql).toMatch(/"status" <> \$\d/);
			expect(q.params).toContain("deleted");
		}
		expect(calls.where).toHaveBeenCalledTimes(2);
	});

	it("listThreads lists only live rows, and reaps a tombstone a day after the delete", async () => {
		const { calls } = useChain([]);
		await listThreads();
		const [reap, list] = calls.where.mock.calls.map(([w]) => compiled(w));
		expect(reap.sql).toMatch(/"status" = \$\d and "agent_threads"\."updated_at" < now\(\) - interval '1 day'/);
		// The hourly reap of an EMPTY row never takes a tombstone: it is what a late save reads.
		expect(reap.sql).toMatch(/"status" <> \$\d and jsonb_array_length/);
		expect(list.sql).toMatch(/"status" <> \$\d/);
	});
});
