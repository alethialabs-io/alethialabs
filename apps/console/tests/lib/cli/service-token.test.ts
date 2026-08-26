// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// Service-account token verification — the NON-INTERACTIVE half of CLI authentication.
//
// The database is mocked at `getServiceDb`, so these drive the DECISION LOGIC: which bearer values
// take the service-token branch at all, what a lookup miss does, and — the one that matters — that
// the revoked and expired filters are part of the QUERY rather than a check somebody could later
// move, reorder, or short-circuit past. A revoked token that still works is the failure this file
// exists to make impossible.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectWhere = vi.fn();
const updateWhere = vi.fn(() => Promise.resolve());

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: selectWhere }) }),
		update: () => ({ set: () => ({ where: updateWhere })
		}),
		insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "row-1", token_prefix: "alethia_sat_abcd1234" }]) }) }),
	}),
}));

/**
 * Every column name a drizzle condition tree references — WITHOUT descending into a column's table.
 *
 * THE FIRST VERSION OF THIS WAS VACUOUS AND PASSED. It walked every property, and a drizzle column
 * carries a `.table` back-reference whose `.columns` holds EVERY column on the table — so it
 * returned the full column list no matter what the WHERE clause said. Deleting the revocation
 * filter from the SUT left the test green, which is the exact defect this file claims to prevent,
 * committed inside the test that claims to prevent it.
 *
 * So: a node that looks like a column is RECORDED AND NOT DESCENDED INTO, and traversal otherwise
 * follows only drizzle's `queryChunks` — the actual structure of the condition — and plain arrays.
 * Verified by mutation: removing `isNull(revoked_at)` from the lookup reds this.
 */
function columnsIn(node: unknown, seen = new Set<unknown>()): string[] {
	if (node === null || typeof node !== "object" || seen.has(node)) return [];
	seen.add(node);
	if (Array.isArray(node)) return node.flatMap((child) => columnsIn(child, seen));
	const record = node as Record<string, unknown>;
	// A column. Record it and STOP — `.table` leads to every other column on the table.
	if (typeof record.name === "string" && typeof record.columnType === "string") {
		return [record.name];
	}
	// Otherwise follow only the condition's own structure.
	return Array.isArray(record.queryChunks) ? columnsIn(record.queryChunks, seen) : [];
}

/** The shape drizzle's `.limit(1)` returns: an array of rows. */
function rows(...r: unknown[]) {
	return { limit: () => Promise.resolve(r) };
}

beforeEach(() => {
	vi.clearAllMocks();
	selectWhere.mockReturnValue(rows());
});

describe("which bearers take the service-token branch", () => {
	it("recognises the prefix and nothing else", async () => {
		const { isServiceToken } = await import("@/lib/cli/service-token");
		expect(isServiceToken("alethia_sat_abc")).toBe(true);
		// A JWT must NOT be routed here, or a real interactive session would be told its token is
		// an invalid service token — an error naming the wrong thing entirely.
		expect(isServiceToken("eyJhbGciOiJIUzI1NiJ9.e30.x")).toBe(false);
		expect(isServiceToken("")).toBe(false);
		expect(isServiceToken("alethia_pat_abc")).toBe(false);
		// Prefix-only, no entropy. It is shaped like one, and must never resolve.
		expect(isServiceToken("alethia_sat_")).toBe(true);
	});

	it("refuses a prefix with no random part WITHOUT touching the database", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		expect(await resolveServiceToken("alethia_sat_")).toBeNull();
		expect(selectWhere, "a degenerate token must not reach a lookup at all").not.toHaveBeenCalled();
	});

	it("returns null for a bearer that is not a service token", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		expect(await resolveServiceToken("eyJ-not-ours")).toBeNull();
		expect(selectWhere).not.toHaveBeenCalled();
	});
});

describe("resolution fails closed", () => {
	it("returns null when no row matches", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		selectWhere.mockReturnValue(rows());
		expect(await resolveServiceToken("alethia_sat_whatever")).toBeNull();
	});

	// THE STRUCTURAL ASSERTION, and the reason this file exists.
	//
	// Revocation and expiry are filters INSIDE the lookup, so there is no window in which a row is
	// fetched and then judged. A check written after the fetch is one a later refactor can reorder,
	// wrap in a condition, or return early past — and the failure mode of that mistake is a revoked
	// token that still works.
	//
	// So assert the columns the WHERE actually CONSULTS, rather than a proxy like its length. If
	// somebody moves the revocation test into JavaScript, `revoked_at` stops appearing here and this
	// goes red — which a shape-free assertion could never notice.
	it("consults token_hash, revoked_at AND expires_at inside the lookup", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		await resolveServiceToken("alethia_sat_whatever");
		expect(selectWhere).toHaveBeenCalledTimes(1);
		const consulted = columnsIn(selectWhere.mock.calls[0][0]);
		for (const column of ["token_hash", "revoked_at", "expires_at"]) {
			expect(consulted, `the lookup does not consult ${column}`).toContain(column);
		}
	});

	it("resolves a live row to its org and creator", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		selectWhere.mockReturnValue(
			rows({
				id: "tok-1",
				organization_id: "org-1",
				name: "ci",
				created_by: "user-1",
				// The stored hash must equal the SUT's own hash of the bearer, or the timing-safe
				// comparison rejects it. Computed the same way the SUT does.
				token_hash: (await import("node:crypto")).createHash("sha256").update("alethia_sat_live", "utf8").digest("hex"),
			}),
		);
		const identity = await resolveServiceToken("alethia_sat_live");
		expect(identity).toEqual({
			tokenId: "tok-1",
			organizationId: "org-1",
			name: "ci",
			createdBy: "user-1",
		});
	});

	// A row whose stored hash does not match the bearer must be REFUSED even though the query
	// returned it. This is what keeps the belt-and-braces comparison honest: without it, a bug in
	// the WHERE clause would be silently rescued by the query engine having returned *something*.
	it("refuses a row whose stored hash does not match the bearer", async () => {
		const { resolveServiceToken } = await import("@/lib/cli/service-token");
		selectWhere.mockReturnValue(
			rows({ id: "tok-1", organization_id: "org-1", name: "ci", created_by: "user-1", token_hash: "not-the-hash" }),
		);
		expect(await resolveServiceToken("alethia_sat_live")).toBeNull();
	});
});

describe("minting", () => {
	it("returns a prefixed token and never the stored hash", async () => {
		const { mintServiceToken, SERVICE_TOKEN_PREFIX, isServiceToken } = await import("@/lib/cli/service-token");
		const minted = await mintServiceToken({ organizationId: "org-1", name: "ci", createdBy: "user-1" });
		expect(minted.token.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
		expect(isServiceToken(minted.token)).toBe(true);
		// 256 bits of base64url is 43 characters; anything much shorter means the entropy budget
		// was quietly reduced, which no other test would notice.
		expect(minted.token.length).toBeGreaterThan(SERVICE_TOKEN_PREFIX.length + 40);
		expect(minted).not.toHaveProperty("token_hash");
	});

	it("mints a DIFFERENT token every time", async () => {
		const { mintServiceToken } = await import("@/lib/cli/service-token");
		const a = await mintServiceToken({ organizationId: "org-1", name: "a", createdBy: "u" });
		const b = await mintServiceToken({ organizationId: "org-1", name: "b", createdBy: "u" });
		expect(a.token).not.toEqual(b.token);
	});
});

describe("the prefix is a security feature", () => {
	it("is stable and distinctive enough for a secret scanner to match", async () => {
		const { SERVICE_TOKEN_PREFIX } = await import("@/lib/cli/service-token");
		// Pinned deliberately. A scanner — gitleaks here, GitHub push protection, a customer's —
		// recognises the STRING. Changing it silently un-protects every token already in the wild,
		// and a credential that looks like random base64 is one nothing can pattern-match.
		expect(SERVICE_TOKEN_PREFIX).toBe("alethia_sat_");
	});
});
