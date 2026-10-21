// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support reads, moved from the `"use server"` actions onto the read router (#6130, ADR 0005 D1).
//
// Mocked boundary: the PDP guard, the tiered support scope and the two query builders. Real: the
// procedures, the `query` base (its refusal mapping and actor binding) and oRPC's input validation.
// Pinned: the bucket reaches the builder as the lifecycle filter; a case the caller cannot see is a
// typed NOT_FOUND (not an empty value, not a 500); a malformed id never reaches the database; a PDP
// refusal is a typed FORBIDDEN; and the case read WRITES nothing (it used to stamp the watermark).

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { authorizeQuiet, listCasesForOwner, getCaseWithThread, tx } = vi.hoisted(() => ({
	authorizeQuiet: vi.fn(),
	listCasesForOwner: vi.fn(),
	getCaseWithThread: vi.fn(),
	// The scoped transaction: any write on it fails the test.
	tx: {
		insert: () => {
			throw new Error("a read procedure wrote to the database");
		},
		update: () => {
			throw new Error("a read procedure wrote to the database");
		},
	},
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeQuiet }));
vi.mock("@/lib/support/scope", () => ({
	withSupportScope: async (_actor: unknown, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("@/lib/queries/support", () => ({ listCasesForOwner, getCaseWithThread }));

import { ForbiddenError } from "@/lib/authz/types";
import { supportRouter } from "@/lib/rpc/procedures/support";

const ACTOR = { userId: "user-1", orgId: "org-1", credential: "session" as const };
const CASE = "11111111-1111-4111-8111-111111111111";
const client = createRouterClient(supportRouter, { context: { actor: ACTOR } });

beforeEach(() => {
	vi.clearAllMocks();
	authorizeQuiet.mockResolvedValue(ACTOR);
	listCasesForOwner.mockResolvedValue([]);
});

describe("support.cases", () => {
	it.each([
		["all", {}],
		["active", { status: "active" }],
		["resolved", { status: "resolved" }],
	] as const)("bucket %s reaches the builder as %j, for the resolved actor", async (bucket, filter) => {
		await client.cases({ bucket });
		expect(authorizeQuiet).toHaveBeenCalledWith("view", { type: "support_case" });
		expect(listCasesForOwner).toHaveBeenCalledWith(tx, ACTOR.userId, filter);
	});

	it("refuses an unknown bucket before reading", async () => {
		// @ts-expect-error — the point is a value the input type does not allow
		await expect(client.cases({ bucket: "everything" })).rejects.toBeInstanceOf(ORPCError);
		expect(listCasesForOwner).not.toHaveBeenCalled();
	});

	it("a PDP refusal is a typed FORBIDDEN, not a 500", async () => {
		authorizeQuiet.mockRejectedValue(new ForbiddenError("view", { type: "support_case" }, "no"));
		const error = await client.cases({ bucket: "all" }).catch((e: unknown) => e);
		expect(error instanceof ORPCError && error.defined ? error.code : error).toBe("FORBIDDEN");
	});
});

describe("support.case", () => {
	it("answers the case with its thread, and writes nothing (the watermark is its own action)", async () => {
		const found = { case: { id: CASE }, messages: [], attachments: [] };
		getCaseWithThread.mockResolvedValue(found);
		await expect(client.case({ id: CASE })).resolves.toEqual(found);
		expect(authorizeQuiet).toHaveBeenCalledWith("view", { type: "support_case", id: CASE });
		expect(getCaseWithThread).toHaveBeenCalledWith(tx, CASE);
	});

	it("a case the caller cannot see is a typed NOT_FOUND — never an empty value", async () => {
		getCaseWithThread.mockResolvedValue(null);
		const error = await client.case({ id: CASE }).catch((e: unknown) => e);
		expect(error instanceof ORPCError && error.defined ? error.code : error).toBe("NOT_FOUND");
	});

	it("a malformed id is refused before the database is asked", async () => {
		await expect(client.case({ id: "d38f58b3" })).rejects.toBeInstanceOf(ORPCError);
		expect(authorizeQuiet).not.toHaveBeenCalled();
		expect(getCaseWithThread).not.toHaveBeenCalled();
	});
});
