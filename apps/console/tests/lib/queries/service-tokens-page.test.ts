// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The service tokens list's read (AGT-L2-U3): one keyset page, named projects and environments, and
// the Status facet over the org's unfiltered tokens on the first page only. The facet pass's
// independence from the filters is asserted by filter-standard-facets.test.ts (F7); this file pins
// the page's shape.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockChainDb } from "./_list-query-db";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { queryServiceTokensPage } from "@/lib/queries/service-tokens";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const WEB = "22222222-2222-4222-8222-222222222222";
const STAGING = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

/** A token row as the rows pass selects it. */
function tokenRow(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: `token-${id.slice(0, 4)}`,
		token_prefix: "alethia_sat_3f9aK2xQ",
		scopes: ["read", "plan", "apply"],
		project_ids: [WEB],
		auto_approve_environment_ids: [STAGING, GONE],
		created_at: new Date(createdAt),
		created_by: "user-1",
		creator_name: "Dana Petrova",
		expires_at: null,
		last_used_at: new Date("2026-11-25T11:48:00.000Z"),
		revoked_at: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryServiceTokensPage", () => {
	it("cuts one page, names the projects and environments, and counts the facet over the org", async () => {
		const { db, chains } = mockChainDb([
			// rows pass: limit 1 reads 2, so a next page exists
			[
				tokenRow("aaaaaaaa-0000-4000-8000-000000000001", "2026-11-25T10:00:00.000Z"),
				tokenRow("aaaaaaaa-0000-4000-8000-000000000002", "2026-11-24T10:00:00.000Z"),
			],
			// project names, then environment names (an id from elsewhere names nothing)
			[{ id: WEB, name: "web" }],
			[{ id: STAGING, name: "staging", projectId: WEB, projectName: "web", stage: "staging" }],
			// facet pass
			[
				{ status: "active", n: 2 },
				{ status: "revoked", n: 1 },
			],
		]);
		getServiceDb.mockReturnValue(db);

		const page = await queryServiceTokensPage(ORG, {}, { limit: 1 }, NOW);

		expect(page.rows).toHaveLength(1);
		expect(page.nextCursor).not.toBeNull();
		const [row] = page.rows;
		expect(row?.projects).toEqual([{ id: WEB, name: "web" }]);
		expect(row?.autoApproveEnvironments).toEqual([
			{ id: STAGING, name: "staging", projectId: WEB, projectName: "web", stage: "staging" },
		]);
		expect(row?.status).toBe("active");
		expect(row?.createdBy).toEqual({ id: "user-1", name: "Dana Petrova" });
		expect(page.facets?.status).toEqual([
			{ value: "active", label: null, count: 2 },
			{ value: "expired", label: null, count: 0 },
			{ value: "revoked", label: null, count: 1 },
		]);
		expect(page.universeEmpty).toBe(false);
		// rows, two name lookups, one facet pass — nothing else
		expect(chains.filter((c) => c.awaited)).toHaveLength(4);
	});

	it("reads an unlimited token's projects as every project, and an expired one as expired", async () => {
		const { db } = mockChainDb([
			[
				tokenRow("aaaaaaaa-0000-4000-8000-000000000003", "2026-11-20T10:00:00.000Z", {
					project_ids: null,
					auto_approve_environment_ids: [],
					expires_at: new Date("2026-11-21T00:00:00.000Z"),
				}),
			],
			[{ status: "expired", n: 1 }],
		]);
		getServiceDb.mockReturnValue(db);

		const page = await queryServiceTokensPage(ORG, { status: ["expired"] }, { limit: 50 }, NOW);

		expect(page.rows[0]?.projects).toBeNull();
		expect(page.rows[0]?.autoApproveEnvironments).toEqual([]);
		expect(page.rows[0]?.status).toBe("expired");
		expect(page.nextCursor).toBeNull();
	});

	it("says the universe is empty when the org has no token at all", async () => {
		const { db } = mockChainDb([[], []]);
		getServiceDb.mockReturnValue(db);

		const page = await queryServiceTokensPage(ORG, {}, { limit: 50 }, NOW);

		expect(page.rows).toEqual([]);
		expect(page.universeEmpty).toBe(true);
		expect(page.facets?.status.map((o) => o.count)).toEqual([0, 0, 0]);
	});

	it("sends no facets on a later page, and runs no facet pass for it", async () => {
		const { db, chains } = mockChainDb([[]]);
		getServiceDb.mockReturnValue(db);

		const page = await queryServiceTokensPage(
			ORG,
			{},
			{ cursor: { at: "2026-11-24T10:00:00.000Z", id: "aaaaaaaa-0000-4000-8000-000000000002" }, limit: 50 },
			NOW,
		);

		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
		expect(chains.filter((c) => c.awaited)).toHaveLength(1);
	});
});
