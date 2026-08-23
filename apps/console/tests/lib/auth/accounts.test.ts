// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// resolveAccountId is the single seam every Better Auth 1.7 account selector goes through, so a
// bug here is a bug in all four callers at once — including the runner's git-token route, where a
// wrong answer means a private-repo GitOps deploy fails with "no git access token".
//
// The property worth pinning is the one 1.7 inverted: it must return the LOCAL row id
// (`account.id`), never the provider-side `account.accountId`. In 1.6 the selector took the
// provider-side value, so returning the wrong column is exactly the mistake this migration
// invites — and it fails silently, by matching nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { resolveAccountId } from "@/lib/auth/accounts";
import { getServiceDb } from "@/lib/db";

/** Every string bound into a drizzle SQL tree, found without tripping over its cycles. */
function boundStrings(node: unknown): string[] {
	const found: string[] = [];
	const seen = new WeakSet<object>();
	const walk = (v: unknown) => {
		if (typeof v === "string") {
			found.push(v);
			return;
		}
		if (v === null || typeof v !== "object" || seen.has(v)) return;
		seen.add(v);
		for (const child of Object.values(v)) walk(child);
	};
	walk(node);
	return found;
}

/** A drizzle select chain stub that records its where-clause and yields `rows`. */
function stubDb(rows: Array<{ id: string }>) {
	const limit = vi.fn().mockResolvedValue(rows);
	const where = vi.fn().mockReturnValue({ limit });
	const from = vi.fn().mockReturnValue({ where });
	const select = vi.fn().mockReturnValue({ from });
	return { db: { select }, select, from, where, limit };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveAccountId", () => {
	it("returns the local account.id for a linked provider", async () => {
		const stub = stubDb([{ id: "acct-row-1" }]);
		vi.mocked(getServiceDb).mockReturnValue(stub.db as never);

		await expect(resolveAccountId("user-1", "github")).resolves.toBe("acct-row-1");
	});

	it("selects the id column, and only the id column", async () => {
		const stub = stubDb([{ id: "acct-row-1" }]);
		vi.mocked(getServiceDb).mockReturnValue(stub.db as never);

		await resolveAccountId("user-1", "github");

		// If this ever selects `accountId` instead, every caller starts passing the
		// provider-side identifier to a selector that wants the row id — and matches nothing.
		expect(Object.keys(stub.select.mock.calls[0]?.[0] ?? {})).toEqual(["id"]);
	});

	it("returns null when the user has no link for that provider", async () => {
		const stub = stubDb([]);
		vi.mocked(getServiceDb).mockReturnValue(stub.db as never);

		await expect(resolveAccountId("user-1", "bitbucket")).resolves.toBeNull();
	});

	it("asks for at most one row", async () => {
		const stub = stubDb([{ id: "acct-row-1" }]);
		vi.mocked(getServiceDb).mockReturnValue(stub.db as never);

		await resolveAccountId("user-1", "gitlab");

		expect(stub.limit).toHaveBeenCalledWith(1);
	});

	it("filters on both userId and providerId, never one alone", async () => {
		const stub = stubDb([{ id: "acct-row-1" }]);
		vi.mocked(getServiceDb).mockReturnValue(stub.db as never);

		await resolveAccountId("user-1", "gitlab");

		// A where() built from only one of the two would hand one user another user's token, or
		// the wrong provider's. Both operands must reach the clause. Drizzle's SQL object is
		// cyclic (a column points back at its table), so collect the bound primitives by walking
		// it with a seen-set rather than serialising it.
		expect(stub.where).toHaveBeenCalledTimes(1);
		expect(boundStrings(stub.where.mock.calls[0]?.[0])).toEqual(
			expect.arrayContaining(["user-1", "gitlab"]),
		);
	});
});
