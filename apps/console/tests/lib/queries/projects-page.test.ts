// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `queryProjectsPage` (lib/queries/projects.ts, LST-4 #7486) — the org overview grid's server half.
//
// What is locked here, each against a recording transaction whose passes are answered BY SHAPE
// (the projection and the table a pass reads), so a test never depends on the order in which
// `Promise.all` happens to await them:
//   - the page boundary: `limit + 1` rows read, `limit` returned, and the cursor names the LAST
//     returned row — exact at the end (a page of exactly `limit` says null);
//   - ties: the order is total (the sort key, then the id) and the cursor predicate is ONE
//     row-value comparison over the same ms-truncated key, so two projects updated in the same
//     millisecond fall to the id, rendered through the real PgDialect rather than inferred;
//   - the `name` order: `lower(name)` then id, ascending, and the cursor row's name read back by id;
//   - facets: the facet passes are handed NOTHING from the query (no WHERE at all — the scope is the
//     transaction's RLS, which is why this builder is in F7_UNDRIVEN), they run on the first page of
//     a walk only, and never for the starred-ids lookup;
//   - an unknown cloud narrows to nothing rather than widening to everything;
//   - the per-card rollups are read for the page's ids only.

import { getTableName, isTable, SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Tx } from "@/lib/db";
import { projectAddons, projectServices } from "@/lib/db/schema";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import { countProjects, queryProjectsPage } from "@/lib/queries/projects";

const dialect = new PgDialect();

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** One recorded pass: its projection keys, the table it reads, and every builder call on it. */
interface Pass {
	keys: string[];
	table: string | null;
	calls: { method: string; args: unknown[] }[];
	awaited: boolean;
	argsOf(method: string): unknown[] | undefined;
}

/** What each pass answers, by shape. Every field is optional; an unseeded pass answers []. */
interface Answers {
	rows?: unknown[];
	clouds?: unknown[];
	repoFacets?: unknown[];
	universe?: unknown[];
	repos?: unknown[];
	envs?: unknown[];
	services?: unknown[];
	addons?: unknown[];
	total?: unknown[];
}

const METHODS = ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"];

/** Which answer a pass gets, decided from what it selects and reads. */
function answerFor(pass: Pass, a: Answers): unknown[] {
	const k = pass.keys.join(",");
	if (k.startsWith("project,")) return a.rows ?? [];
	if (k === "n" && pass.table === "projects") return a.total ?? [];
	if (k === "value,count") return a.clouds ?? [];
	if (k === "url,count") return a.repoFacets ?? [];
	if (k === "id") return a.universe ?? [];
	if (k === "project_id,repo_url") return a.repos ?? [];
	if (k === "project_id,n,last_deployed_at") return a.envs ?? [];
	if (k === "project_id,n" && pass.table === getTableName(projectServices)) return a.services ?? [];
	if (k === "project_id,n" && pass.table === getTableName(projectAddons)) return a.addons ?? [];
	return [];
}

/** A recording transaction: `select` / `selectDistinct` chains that answer from `answers`. */
function recordingTx(answers: Answers = {}): { tx: Tx; passes: Pass[] } {
	const passes: Pass[] = [];
	const start = (projection: Record<string, unknown> = {}) => {
		const calls: Pass["calls"] = [];
		const pass: Pass = {
			keys: Object.keys(projection),
			table: null,
			calls,
			awaited: false,
			argsOf: (method) => calls.find((c) => c.method === method)?.args,
		};
		passes.push(pass);
		const chain: Record<string, unknown> = {};
		for (const method of METHODS) {
			chain[method] = (...args: unknown[]) => {
				calls.push({ method, args });
				if (method === "from" && isTable(args[0])) pass.table = getTableName(args[0]);
				return chain;
			};
		}
		chain.then = (resolve: (value: unknown) => void) => {
			pass.awaited = true;
			return resolve(answerFor(pass, answers));
		};
		return chain;
	};
	const fake = { select: start, selectDistinct: start };
	// The builder only ever calls `select` / `selectDistinct` and the chain methods above.
	const tx: Tx = Object.assign(Object.create(null), fake);
	return { tx, passes };
}

/** A joined grid row as the rows pass returns it. */
function joined(n: number, updatedAt: string, extra: Record<string, unknown> = {}) {
	return {
		project: {
			id: uuid(n),
			project_name: `proj-${n}`,
			updated_at: new Date(updatedAt),
			...extra,
		},
		cloud_provider: "aws",
		env_id: uuid(100 + n),
		env_name: "production",
		env_status: "ACTIVE",
	};
}

/** The rows pass (the one selecting the joined `project`). */
function rowsPass(passes: Pass[]): Pass {
	const pass = passes.find((p) => p.keys[0] === "project");
	if (!pass) throw new Error("no rows pass was issued");
	return pass;
}

/** The three facet passes (clouds, repositories, the universe probe). */
function facetPasses(passes: Pass[]): Pass[] {
	return passes.filter((p) => ["value,count", "url,count", "id"].includes(p.keys.join(",")));
}

/** Renders a recorded SQL argument through the real dialect. */
function render(value: unknown): { sql: string; params: unknown[] } {
	if (!(value instanceof SQL)) throw new Error(`expected a drizzle SQL value, got ${String(value)}`);
	return dialect.sqlToQuery(value);
}

/** Renders a recorded ORDER BY argument list as one comma-joined clause. */
function renderOrder(args: unknown[] | undefined): string {
	const parts = (args ?? []).filter((a): a is SQL => a instanceof SQL);
	return render(sql.join(parts, sql`, `)).sql;
}

describe("queryProjectsPage — the page boundary", () => {
	it("reads limit + 1, returns limit, and the cursor is the last RETURNED row", async () => {
		const { tx, passes } = recordingTx({
			rows: [
				joined(3, "2026-11-20T10:00:03.000Z"),
				joined(2, "2026-11-20T10:00:02.000Z"),
				joined(1, "2026-11-20T10:00:01.000Z"),
			],
		});
		const page = await queryProjectsPage(tx, {}, { limit: 2 });
		expect(rowsPass(passes).argsOf("limit")).toEqual([3]);
		expect(page.rows.map((r) => r.project_name)).toEqual(["proj-3", "proj-2"]);
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: "2026-11-20T10:00:02.000Z", id: uuid(2) });
	});

	it("a page of exactly `limit` rows at the end says null — no empty read to find out", async () => {
		const { tx } = recordingTx({ rows: [joined(2, "2026-11-20T10:00:02.000Z"), joined(1, "2026-11-20T10:00:01.000Z")] });
		const page = await queryProjectsPage(tx, {}, { limit: 2 });
		expect(page.rows).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	it("ties: two projects in one millisecond at the boundary — the cursor carries the id, and the next page compares (key, id) as one row value", async () => {
		const SAME = "2026-11-20T10:00:00.500Z";
		const first = recordingTx({ rows: [joined(9, SAME), joined(8, SAME), joined(7, SAME)] });
		const page = await queryProjectsPage(first.tx, {}, { limit: 2 });
		const cursor = decodeKeysetCursor(page.nextCursor ?? "");
		expect(cursor).toEqual({ at: SAME, id: uuid(8) });

		const order = renderOrder(rowsPass(first.passes).argsOf("orderBy"));
		expect(order).toBe(`date_trunc('milliseconds', "projects"."updated_at") desc, "projects"."id" desc`);

		const second = recordingTx();
		await queryProjectsPage(second.tx, {}, { cursor: cursor ?? undefined, limit: 2 });
		const where = render(rowsPass(second.passes).argsOf("where")?.[0]);
		expect(where.sql).toContain(`(date_trunc('milliseconds', "projects"."updated_at"), "projects"."id") < ($1::timestamptz, $2::uuid)`);
		expect(where.params).toEqual([SAME, uuid(8)]);
	});

	it("a sub-millisecond updated_at mints a ms cursor, agreeing with the ms-truncated order", async () => {
		const { tx } = recordingTx({
			rows: [joined(2, "2026-11-20T10:00:00.123Z"), joined(1, "2026-11-20T10:00:00.001Z")],
		});
		const page = await queryProjectsPage(tx, {}, { limit: 1 });
		expect(decodeKeysetCursor(page.nextCursor ?? "")?.at).toBe("2026-11-20T10:00:00.123Z");
	});
});

describe("queryProjectsPage — the name order", () => {
	it("orders by lower(name) then id ascending, mints a cursor over the id, and reads the cursor row's name back by id", async () => {
		const first = recordingTx({
			rows: [joined(1, "2026-11-20T10:00:00.000Z"), joined(2, "2026-11-20T10:00:00.000Z")],
		});
		const page = await queryProjectsPage(first.tx, { sort: "name" }, { limit: 1 });
		const order = renderOrder(rowsPass(first.passes).argsOf("orderBy"));
		expect(order).toBe(`lower("projects"."project_name") asc, "projects"."id" asc`);
		const cursor = decodeKeysetCursor(page.nextCursor ?? "");
		expect(cursor).toEqual({ at: "1970-01-01T00:00:00.000Z", id: uuid(1) });

		const second = recordingTx();
		await queryProjectsPage(second.tx, { sort: "name" }, { cursor: cursor ?? undefined, limit: 1 });
		const readBack = second.passes.find((p) => p.keys.join(",") === "name,id");
		expect(readBack).toBeDefined();
		const by = render(readBack?.argsOf("where")?.[0]);
		expect(by.sql).toBe(`"cursor_project"."id" = $1`);
		expect(by.params).toEqual([uuid(1)]);
	});
});

describe("queryProjectsPage — the filters reach the rows pass only", () => {
	const NEEDLE = "f7needle";

	it("search is a LIKE-escaped contains-match on the name; a known cloud narrows by provider", async () => {
		const { tx, passes } = recordingTx();
		await queryProjectsPage(tx, { q: ` 50%_${NEEDLE} `, clouds: ["aws"] });
		const where = render(rowsPass(passes).argsOf("where")?.[0]);
		expect(where.sql).toContain(`"projects"."project_name" ilike $1`);
		expect(where.params[0]).toBe(`%50\\%\\_${NEEDLE}%`);
		expect(where.sql).toContain(`"cloud_identities"."provider" in ($2)`);
		expect(where.params[1]).toBe("aws");
	});

	it("an unknown cloud matches NOTHING — it never drops the predicate and widens the view", async () => {
		const { tx, passes } = recordingTx();
		await queryProjectsPage(tx, { clouds: ["not-a-cloud"] });
		expect(render(rowsPass(passes).argsOf("where")?.[0]).sql).toContain("false");
	});

	it("facets: on the first page the facet passes take no WHERE at all, whatever the query", async () => {
		const { tx, passes } = recordingTx({
			clouds: [
				{ value: "gcp", count: 1 },
				{ value: "aws", count: 3 },
			],
			repoFacets: [
				{ url: "https://github.com/acme/zeta.git", count: 1 },
				{ url: "https://github.com/acme/alpha", count: 2 },
			],
			universe: [{ id: uuid(1) }],
		});
		const page = await queryProjectsPage(tx, {
			q: NEEDLE,
			clouds: ["aws"],
			repos: [`https://github.com/${NEEDLE}/x`],
			sort: "name",
		});
		const facetsRead = facetPasses(passes);
		expect(facetsRead).toHaveLength(3);
		for (const pass of facetsRead) expect(pass.argsOf("where")).toBeUndefined();
		expect(page.facets).toEqual({
			clouds: [
				{ value: "aws", count: 3 },
				{ value: "gcp", count: 1 },
			],
			repos: [
				{ url: "https://github.com/acme/alpha", label: "acme/alpha", count: 2 },
				{ url: "https://github.com/acme/zeta.git", label: "acme/zeta", count: 1 },
			],
		});
		expect(page.universeEmpty).toBe(false);
	});

	it("an organization with no project says so as a boolean, never a count", async () => {
		const { tx } = recordingTx({ universe: [] });
		const page = await queryProjectsPage(tx, { q: NEEDLE });
		expect(page.universeEmpty).toBe(true);
		expect(page.rows).toEqual([]);
	});

	it("a later page issues no facet pass and carries facets: null", async () => {
		const { tx, passes } = recordingTx();
		const page = await queryProjectsPage(tx, {}, { cursor: { at: "2026-11-20T10:00:00.000Z", id: uuid(1) }, limit: 2 });
		expect(facetPasses(passes)).toEqual([]);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});

	it("the starred-ids lookup: narrowed by id, no facet pass, and never a next cursor", async () => {
		const { tx, passes } = recordingTx({
			rows: [joined(2, "2026-11-20T10:00:02.000Z"), joined(1, "2026-11-20T10:00:01.000Z")],
		});
		const page = await queryProjectsPage(tx, { ids: [uuid(1), uuid(2)] }, { limit: 1 });
		const where = render(rowsPass(passes).argsOf("where")?.[0]);
		expect(where.sql).toContain(`"projects"."id" in ($1, $2)`);
		expect(facetPasses(passes)).toEqual([]);
		expect(page.facets).toBeNull();
		expect(page.nextCursor).toBeNull();
	});
});

describe("queryProjectsPage — the card rollups", () => {
	it("are read for the page's ids only and joined onto each row", async () => {
		const deployed = new Date("2026-11-19T09:00:00.000Z");
		const { tx, passes } = recordingTx({
			rows: [joined(2, "2026-11-20T10:00:02.000Z"), joined(1, "2026-11-20T10:00:01.000Z")],
			repos: [
				{ project_id: uuid(2), repo_url: "https://github.com/acme/api.git" },
				{ project_id: null, repo_url: "https://github.com/acme/orphan" },
			],
			envs: [{ project_id: uuid(2), n: 3, last_deployed_at: deployed }],
			services: [{ project_id: uuid(2), n: 4 }],
			addons: [{ project_id: uuid(1), n: 1 }],
			universe: [{ id: uuid(1) }],
		});
		const page = await queryProjectsPage(tx, {}, { limit: 50 });
		const [two, one] = page.rows;
		expect(two).toMatchObject({
			id: uuid(2),
			repositories: [{ url: "https://github.com/acme/api.git", label: "acme/api" }],
			environments_count: 3,
			last_deployed_at: deployed,
			services_count: 4,
			addons_count: 0,
			default_environment_id: uuid(102),
			status: "ACTIVE",
		});
		expect(one).toMatchObject({ id: uuid(1), repositories: [], environments_count: 0, last_deployed_at: null, addons_count: 1 });

		const repoPass = passes.find((p) => p.keys.join(",") === "project_id,repo_url");
		const byIds = render(repoPass?.argsOf("where")?.[0]);
		expect(byIds.params).toEqual([uuid(2), uuid(1)]);
	});

	it("an empty page reads no rollup at all", async () => {
		const { tx, passes } = recordingTx({ universe: [{ id: uuid(1) }] });
		await queryProjectsPage(tx, { q: "zzz" });
		expect(passes.filter((p) => p.keys[0] === "project_id")).toEqual([]);
	});
});

describe("countProjects — the Usage card's project total", () => {
	it("counts the org's projects in one pass over the projects table and returns a number", async () => {
		const { tx, passes } = recordingTx({ total: [{ n: "7" }] });
		await expect(countProjects(tx)).resolves.toBe(7);
		expect(passes).toHaveLength(1);
		expect(passes[0]?.table).toBe("projects");
		expect(passes[0]?.calls.some((c) => c.method === "where")).toBe(false);
	});

	it("reads an empty answer as zero", async () => {
		const { tx } = recordingTx({});
		await expect(countProjects(tx)).resolves.toBe(0);
	});
});
