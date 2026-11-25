// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The revision and idempotency reads of the MCP design tools (lib/ai/mcp/design-store.ts), over a
// stood-in transaction: every read runs in the actor's RLS scope, an absent row reads as revision 0
// or null, and a key hash is bound to the caller's organisation and person.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));

import {
	designKeyHash,
	findKeyedDesignWrite,
	findProjectByName,
	readDesignRevision,
} from "@/lib/ai/mcp/design-store";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { txAnswering } from "./tx-stub";

const ACTOR: Actor = { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1" };

/** Runs the scoped callback against a transaction answering `rowSets`. */
function scopeTo(...rowSets: unknown[][]) {
	const tx = txAnswering(...rowSets);
	vi.mocked(withActorScope).mockImplementation(((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
	return tx;
}

beforeEach(() => vi.clearAllMocks());

describe("designKeyHash", () => {
	it("is a SHA-256 hex that differs by organisation, person and key", () => {
		const hash = designKeyHash(ACTOR, "key-1");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(designKeyHash(ACTOR, "key-1")).toBe(hash);
		expect(designKeyHash({ ...ACTOR, userId: "user-2" }, "key-1")).not.toBe(hash);
		expect(designKeyHash({ ...ACTOR, orgId: "org-2" }, "key-1")).not.toBe(hash);
		expect(designKeyHash(ACTOR, "key-2")).not.toBe(hash);
	});
});

describe("readDesignRevision", () => {
	it("reads the latest design-write row in the actor's scope, or 0", async () => {
		scopeTo([{ id: 42 }]);
		expect(await readDesignRevision(ACTOR, "p1")).toBe(42);
		expect(withActorScope).toHaveBeenCalledWith(ACTOR, expect.any(Function));
		scopeTo([]);
		expect(await readDesignRevision(ACTOR, "p1")).toBe(0);
	});
});

describe("findKeyedDesignWrite", () => {
	it("answers the revision of the row that recorded the key, or null", async () => {
		scopeTo([{ id: 9 }]);
		expect(await findKeyedDesignWrite(ACTOR, "p1", "h")).toBe(9);
		scopeTo([]);
		expect(await findKeyedDesignWrite(ACTOR, "p1", "h")).toBeNull();
	});
});

describe("findProjectByName", () => {
	it("answers the organisation's project of that name, or null", async () => {
		scopeTo([{ id: "p1" }]);
		expect(await findProjectByName(ACTOR, " API ")).toBe("p1");
		scopeTo([]);
		expect(await findProjectByName(ACTOR, "web")).toBeNull();
	});
});
