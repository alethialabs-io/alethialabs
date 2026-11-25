// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support reads, moved from the `"use server"` actions onto the read router (#6130, ADR 0005 D1).
//
// Mocked boundary: the PDP guard, the tiered support scope and the two query builders. Real: the
// procedures, the `query` base (its refusal mapping and actor binding) and oRPC's input validation.
// Pinned: the bucket reaches the builder as the lifecycle filter, and search / severity / type reach
// it as they were sent (#7396); a case the caller cannot see is a
// typed NOT_FOUND (not an empty value, not a 500); a malformed id never reaches the database; a PDP
// refusal is a typed FORBIDDEN; and the case read WRITES nothing (it used to stamp the watermark).

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { authorizeQuiet, queryCasesPage, getCaseWithThread, tx } = vi.hoisted(() => ({
	authorizeQuiet: vi.fn(),
	queryCasesPage: vi.fn(),
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
vi.mock("@/lib/queries/support", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/queries/support")>()),
	queryCasesPage,
	getCaseWithThread,
}));

import { ForbiddenError } from "@/lib/authz/types";
import { encodeKeysetCursor, KEYSET_DEFAULT_LIMIT, KEYSET_MAX_LIMIT } from "@/lib/queries/keyset";
import { supportRouter } from "@/lib/rpc/procedures/support";

const ACTOR = { userId: "user-1", orgId: "org-1", credential: "session" as const };
const CASE = "11111111-1111-4111-8111-111111111111";
const client = createRouterClient(supportRouter, { context: { actor: ACTOR } });

beforeEach(() => {
	vi.clearAllMocks();
	authorizeQuiet.mockResolvedValue(ACTOR);
	queryCasesPage.mockResolvedValue({ rows: [], nextCursor: null, facets: null, universeEmpty: null });
});

describe("support.cases", () => {
	it.each([
		["all", {}],
		["active", { status: "active" }],
		["resolved", { status: "resolved" }],
	] as const)("bucket %s reaches the builder as %j, for the resolved actor", async (bucket, filter) => {
		await client.cases({ bucket });
		expect(authorizeQuiet).toHaveBeenCalledWith("view", { type: "support_case" });
		// No cursor is the first page — one page, never the whole list (#7389).
		expect(queryCasesPage).toHaveBeenCalledWith(
			tx,
			ACTOR.userId,
			{ ...filter, search: undefined, severity: undefined, type: undefined },
			{ cursor: undefined, limit: KEYSET_DEFAULT_LIMIT },
		);
	});

	it("passes search, severity and type through to the builder (#7396)", async () => {
		await client.cases({ bucket: "active", search: "registry", severity: ["urgent"], type: ["billing"] });
		expect(queryCasesPage).toHaveBeenCalledWith(
			tx,
			ACTOR.userId,
			{ status: "active", search: "registry", severity: ["urgent"], type: ["billing"] },
			{ cursor: undefined, limit: KEYSET_DEFAULT_LIMIT },
		);
	});

	it("refuses an over-long search before reading", async () => {
		await expect(client.cases({ bucket: "all", search: "x".repeat(201) })).rejects.toBeInstanceOf(ORPCError);
		expect(queryCasesPage).not.toHaveBeenCalled();
	});

	it("decodes the opaque cursor and passes it to the builder as the page's keyset position", async () => {
		const position = { at: "2026-11-20T10:00:00.123Z", id: CASE };
		await client.cases({ bucket: "all", cursor: encodeKeysetCursor(position), limit: 20 });
		expect(queryCasesPage).toHaveBeenCalledWith(
			tx,
			ACTOR.userId,
			{ search: undefined, severity: undefined, type: undefined },
			{ cursor: position, limit: 20 },
		);
	});

	it.each([
		["not a cursor at all", "nope"],
		["an object, the pre-#7494 cursor shape", { at: "2026-11-20T10:00:00.123Z", id: CASE }],
		["a cursor whose id is not a case id", encodeKeysetCursor({ at: "2026-11-20T10:00:00.123Z", id: "c-1" })],
	])("refuses %s as a 400 before reading — never page one", async (_name, cursor) => {
		// @ts-expect-error — the point is a value the input type does not allow
		const error = await client.cases({ bucket: "all", cursor }).catch((e: unknown) => e);
		expect(error instanceof ORPCError ? error.code : error).toBe("BAD_REQUEST");
		expect(queryCasesPage).not.toHaveBeenCalled();
	});

	it("refuses a limit above the contract's maximum rather than clamping it", async () => {
		await expect(client.cases({ bucket: "all", limit: KEYSET_MAX_LIMIT + 1 })).rejects.toBeInstanceOf(ORPCError);
		expect(queryCasesPage).not.toHaveBeenCalled();
	});

	it("refuses an unknown bucket before reading", async () => {
		// @ts-expect-error — the point is a value the input type does not allow
		await expect(client.cases({ bucket: "everything" })).rejects.toBeInstanceOf(ORPCError);
		expect(queryCasesPage).not.toHaveBeenCalled();
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
