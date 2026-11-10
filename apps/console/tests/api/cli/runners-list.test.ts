// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/runners: the CLI list follows the console's deployment rule for managed runners
// (lib/rpc/procedures/runners.ts). On a self-managed deployment the managed fleet is listed beside
// the org's runners; on the hosted SaaS the list is the addressed org's runners alone. The rule is
// read off the WHERE clause the route builds, rendered by drizzle's own dialect.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ where: [] as unknown[], mode: "hosted" as "hosted" | "self-managed" }));

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: () => h.mode }));
vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: (w: unknown) => {
			h.where.push(w);
			return chain;
		},
		orderBy: async () => [],
	};
	return { getServiceDb: () => chain };
});

import { GET } from "@/app/api/cli/runners/route";
import { authorizeCli } from "@/lib/authz/guard";

const ORG = "7b0c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

/** The rendered SQL of the route's WHERE clause for one request. */
async function whereSql(): Promise<string> {
	h.where = [];
	const res = await GET(new Request("http://console.test/api/cli/runners"));
	expect(res.status).toBe(200);
	const [where] = h.where;
	const isSql = (v: unknown): v is SQL => typeof v === "object" && v !== null && "queryChunks" in v;
	if (!isSql(where)) throw new Error("the route built no WHERE clause");
	return new PgDialect().sqlToQuery(where).sql;
}

beforeEach(() => {
	vi.mocked(authorizeCli).mockResolvedValue({ actor: { userId: "u1", orgId: ORG } } as never);
});

describe("GET /api/cli/runners — managed runners follow the deployment", () => {
	it("on the hosted SaaS lists only the addressed org's runners — never the managed fleet", async () => {
		h.mode = "hosted";
		const sql = await whereSql();
		expect(sql).toContain('"org_id"');
		expect(sql).not.toContain('"operator"');
	});

	it("on a self-managed deployment also lists the managed fleet the operator runs", async () => {
		h.mode = "self-managed";
		const sql = await whereSql();
		expect(sql).toContain('"org_id"');
		expect(sql).toContain('"operator"');
	});
});
