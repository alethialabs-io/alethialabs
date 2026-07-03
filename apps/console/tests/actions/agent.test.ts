// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the agent-thread actions: stub requireOwner + withOwnerScope
// (run the real callback against a thenable drizzle chain that records .values()/.set()/.where()
// writes), keep titleFrom real, and assert the owner-scoping, title derivation, returned shapes,
// and which write each mutating action issues.

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));

import {
	createThread,
	deleteThread,
	getThread,
	listThreads,
	renameThread,
	saveThreadMessages,
} from "@/app/server/actions/agent";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";

/**
 * A drizzle-ish chain whose every builder returns itself, awaits to `rows`, and records the
 * args handed to the mutating verbs so tests can assert the exact write.
 */
function mockChain(rows: unknown[]) {
	const calls = {
		insert: vi.fn(),
		values: vi.fn(),
		update: vi.fn(),
		set: vi.fn(),
		where: vi.fn(),
		delete: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
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
		returning: () => db,
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
		delete: (...a: unknown[]) => {
			calls.delete(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	return { db, calls };
}

/** Wire withOwnerScope to invoke the real callback against the given chain. */
function useChain(rows: unknown[]) {
	const { db, calls } = mockChain(rows);
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
		expect(calls.values).toHaveBeenCalledWith({
			user_id: "user-1",
			org_id: "user-1",
			title: "Hello world",
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

	it("throws when there is no authenticated owner", async () => {
		vi.mocked(requireOwner).mockRejectedValue(new Error("Unauthorized"));
		await expect(createThread("x")).rejects.toThrow(/Unauthorized/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("listThreads", () => {
	it("returns the owner's threads ordered by the chain (RLS scoped)", async () => {
		const rows = [{ id: "t-1" }, { id: "t-2" }];
		const { calls } = useChain(rows);
		const result = await listThreads();
		expect(result).toBe(rows);
		expect(calls.orderBy).toHaveBeenCalledTimes(1);
	});
});

describe("getThread", () => {
	it("returns the first matching row when present", async () => {
		const row = { id: "t-7", title: "Found" };
		const { calls } = useChain([row]);
		const thread = await getThread("t-7");
		expect(thread).toBe(row);
		expect(calls.limit).toHaveBeenCalledWith(1);
		expect(calls.where).toHaveBeenCalledTimes(1);
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

describe("saveThreadMessages", () => {
	it("persists the transcript (and bumps updated_at) for the thread", async () => {
		const { calls } = useChain([]);
		const messages = [
			{ id: "m-1", role: "user", parts: [] },
		] as unknown as UIMessage[];
		await saveThreadMessages("t-9", messages);
		expect(calls.update).toHaveBeenCalledTimes(1);
		const setArg = calls.set.mock.calls[0][0];
		expect(setArg.messages).toBe(messages);
		expect(setArg.updated_at).toBeDefined();
	});
});

describe("deleteThread", () => {
	it("issues a scoped delete for the given id", async () => {
		const { calls } = useChain([]);
		await deleteThread("t-1");
		expect(calls.delete).toHaveBeenCalledTimes(1);
		expect(calls.where).toHaveBeenCalledTimes(1);
		// Owner scope is forwarded.
		expect(vi.mocked(withOwnerScope).mock.calls[0][0]).toBe("user-1");
	});
});
