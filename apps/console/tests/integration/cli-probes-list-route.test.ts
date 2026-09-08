// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: GET /api/cli/projects/:id/probes — one bounded latest-state row per environment,
// paged over the project's ENVIRONMENTS (#4202).
//
// The database is real because every claim this route now makes is a SQL claim that a mock
// restates rather than tests: that the LATERAL reads ONE probe row per environment out of an
// append-only history and still returns the newest one; that the org boundary is the join to
// `projects` and not the caller's word; that an environment with no probe row comes back as
// `null` rather than `false`; and that the cursor walks environments to exhaustion without
// repeating or losing one across a page boundary that equal `created_at` values straddle.

import { randomUUID } from "node:crypto";
import { type SQLWrapper, and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));

import { GET } from "@/app/api/cli/projects/[id]/probes/route";
import { authorizeCli } from "@/lib/authz/guard";
import { MAX_PAGE_SIZE, type PageInfo } from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import {
	environmentProbes,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import {
	getLatestProbesByEnv,
	latestProbesQuery,
} from "@/lib/probes/persistence";
import {
	explainSchema,
	scanOf,
	sortsRowsOf,
} from "../support/explain-plan";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();
const PROJECT_BARE = randomUUID();

// Environment ids are FIXED rather than random: the page order is `created_at DESC, id DESC`,
// and TIE_HIGH/TIE_LOW share a `created_at` so only the id decides which side of a one-row page
// boundary each lands on. A random pair would make that assertion pass or fail by coin flip.
const ENV_NEWEST = "e0000000-0000-4000-8000-000000000004";
const ENV_TIE_HIGH = "f0000000-0000-4000-8000-000000000003";
const ENV_TIE_LOW = "10000000-0000-4000-8000-000000000002";
const ENV_OLDEST = "e0000000-0000-4000-8000-000000000001";
const ENV_B = randomUUID();

const pageSchema = z.object({
	mode: z.enum(["exact", "capped"]),
	limit: z.number().int().positive(),
	total: z.number().int().nonnegative(),
	next_cursor: z.string().nullable(),
});
const bodySchema = z.object({
	probes: z.array(
		z.object({
			environment_id: z.string(),
			environment: z.string(),
			reachable: z.boolean().nullable(),
			message: z.string().nullable(),
			probed_at: z.string().nullable(),
		}),
	),
	page: pageSchema,
});
type Body = z.infer<typeof bodySchema>;

/** Points the stubbed PDP guard at one tenant for the next request. */
function actingAs(userId: string, orgId: string): void {
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId, orgId },
		credential: "session",
		orgScope: [orgId, userId],
	});
}

/** Calls the route and returns its status plus unparsed JSON body. */
async function request(projectId: string, query = "") {
	const response = await GET(
		new Request(
			`http://console.test/api/cli/projects/${projectId}/probes${query}`,
		),
		{ params: Promise.resolve({ id: projectId }) },
	);
	return { status: response.status, body: await response.json() };
}

/** Calls a successful page and validates the complete wire envelope. */
async function get(projectId: string, query = ""): Promise<Body> {
	const result = await request(projectId, query);
	if (result.status !== 200) {
		throw new Error(
			`expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
		);
	}
	return bodySchema.parse(result.body);
}

/** Walks the collection to cursor exhaustion with a hard loop bound. */
async function walk(projectId: string, pageSize: number) {
	const probes: Body["probes"] = [];
	const pages: PageInfo[] = [];
	let cursor = "";
	for (let page = 0; page < 30; page++) {
		const body = await get(
			projectId,
			`?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		probes.push(...body.probes);
		pages.push(body.page);
		if (body.page.next_cursor === null) return { probes, pages };
		cursor = body.page.next_cursor;
	}
	throw new Error("probe cursor did not exhaust in 30 pages");
}

/**
 * Returns `query`'s plan as JSON text with sequential scans disabled — the same instrument
 * `cli-paging.test.ts` uses, and for the same reason: on a table small enough to live in a test
 * the question worth asking is CAN this index answer the query, ordering included, not whether
 * Postgres bothers at this cardinality. `enable_sort` stays ON, so "no Sort node" is an
 * observation rather than a tautology. SET LOCAL inside a transaction because postgres-js pools
 * connections and a bare SET would land on whichever one it liked.
 */
async function explain(query: SQLWrapper): Promise<string> {
	const rows = await getServiceDb().transaction(async (tx) => {
		await tx.execute(sql`set local enable_seqscan = off`);
		return tx.execute(sql`explain (format json) ${query}`);
	});
	return JSON.stringify(explainSchema.parse(rows));
}

describeIfDb("GET project probes — bounded latest state, paged (#4202)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values([
			{
				id: PROJECT_A,
				org_id: ORG_A,
				user_id: USER_A,
				project_name: `probes-a-${PROJECT_A}`,
				slug: `probes-a-${PROJECT_A}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
			{
				id: PROJECT_B,
				org_id: ORG_B,
				user_id: USER_B,
				project_name: `probes-b-${PROJECT_B}`,
				slug: `probes-b-${PROJECT_B}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
			{
				// No environments at all — the empty collection, which is not the same shape as a
				// project whose environments have simply never been probed.
				id: PROJECT_BARE,
				org_id: ORG_A,
				user_id: USER_A,
				project_name: `probes-bare-${PROJECT_BARE}`,
				slug: `probes-bare-${PROJECT_BARE}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
		]);
		await db.insert(projectEnvironments).values([
			{
				id: ENV_OLDEST,
				project_id: PROJECT_A,
				org_id: ORG_A,
				user_id: USER_A,
				name: "production",
				is_default: true,
				created_at: new Date("2025-01-01T00:00:00.000Z"),
			},
			{
				id: ENV_TIE_LOW,
				project_id: PROJECT_A,
				org_id: ORG_A,
				user_id: USER_A,
				name: "tie-low",
				is_default: false,
				created_at: new Date("2025-02-01T00:00:00.000Z"),
			},
			{
				id: ENV_TIE_HIGH,
				project_id: PROJECT_A,
				org_id: ORG_A,
				user_id: USER_A,
				name: "tie-high",
				is_default: false,
				created_at: new Date("2025-02-01T00:00:00.000Z"),
			},
			{
				id: ENV_NEWEST,
				project_id: PROJECT_A,
				org_id: ORG_A,
				user_id: USER_A,
				name: "staging",
				is_default: false,
				created_at: new Date("2025-03-01T00:00:00.000Z"),
			},
			{
				id: ENV_B,
				project_id: PROJECT_B,
				org_id: ORG_B,
				user_id: USER_B,
				name: "production",
				is_default: true,
				created_at: new Date("2025-01-01T00:00:00.000Z"),
			},
		]);

		// ENV_NEWEST carries a HISTORY, not a state: five append-only rows whose newest says the
		// cluster went dark. The read must answer with the fifth and touch nothing else.
		await db.insert(environmentProbes).values([
			{
				project_id: PROJECT_A,
				environment_id: ENV_NEWEST,
				reachable: true,
				message: "first ok",
				probed_at: new Date("2026-01-01T00:00:00.000Z"),
			},
			{
				project_id: PROJECT_A,
				environment_id: ENV_NEWEST,
				reachable: false,
				message: "blip",
				probed_at: new Date("2026-01-01T00:10:00.000Z"),
			},
			{
				project_id: PROJECT_A,
				environment_id: ENV_NEWEST,
				reachable: true,
				message: "recovered",
				probed_at: new Date("2026-01-01T00:20:00.000Z"),
			},
			{
				project_id: PROJECT_A,
				environment_id: ENV_NEWEST,
				reachable: true,
				message: "still ok",
				probed_at: new Date("2026-01-01T00:30:00.000Z"),
			},
			{
				project_id: PROJECT_A,
				environment_id: ENV_NEWEST,
				reachable: false,
				message: "gone dark",
				probed_at: new Date("2026-01-01T00:40:00.000Z"),
			},
			// One row each — the ordinary case sitting next to the deep one.
			{
				project_id: PROJECT_A,
				environment_id: ENV_TIE_HIGH,
				reachable: true,
				message: "up",
				probed_at: new Date("2026-01-01T00:05:00.000Z"),
			},
			{
				project_id: PROJECT_A,
				environment_id: ENV_OLDEST,
				reachable: false,
				message: "dial timeout",
				probed_at: new Date("2026-01-01T00:06:00.000Z"),
			},
			// ENV_TIE_LOW gets NOTHING: never probed is a third value, and it must survive the
			// INNER lateral as `null` on the wire rather than being dropped from the list.
			{
				project_id: PROJECT_B,
				environment_id: ENV_B,
				reachable: true,
				message: "tenant b",
				probed_at: new Date("2026-01-01T00:07:00.000Z"),
			},
		]);
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(projects)
			.where(inArray(projects.id, [PROJECT_A, PROJECT_B, PROJECT_BARE]));
	});

	it("returns the newest probe per environment out of a deep history", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(PROJECT_A, "?limit=20");
		const byEnv = new Map(body.probes.map((p) => [p.environment_id, p]));

		expect(byEnv.get(ENV_NEWEST)).toMatchObject({
			environment: "staging",
			reachable: false,
			message: "gone dark",
			probed_at: "2026-01-01T00:40:00.000Z",
		});
		expect(byEnv.get(ENV_TIE_HIGH)).toMatchObject({
			reachable: true,
			message: "up",
		});
		expect(byEnv.get(ENV_OLDEST)).toMatchObject({
			reachable: false,
			message: "dial timeout",
		});
		// One row out per environment, never one per probe.
		expect(body.probes).toHaveLength(4);
		expect(body.page).toMatchObject({ mode: "exact", total: 4 });
	});

	it("reports a never-probed environment as null, not as unreachable", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(PROJECT_A, "?limit=20");
		const never = body.probes.find((p) => p.environment_id === ENV_TIE_LOW);
		expect(never).toBeDefined();
		expect(never?.reachable).toBeNull();
		expect(never?.message).toBeNull();
		expect(never?.probed_at).toBeNull();
	});

	it("serves an empty page for a project with no environments", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(PROJECT_BARE, "?limit=20");
		expect(body.probes).toEqual([]);
		expect(body.page).toMatchObject({
			mode: "exact",
			total: 0,
			next_cursor: null,
		});
	});

	it("walks environments to cursor exhaustion without a gap or a duplicate", async () => {
		actingAs(USER_A, ORG_A);
		const { probes, pages } = await walk(PROJECT_A, 1);
		expect(probes.map((p) => p.environment_id)).toEqual([
			ENV_NEWEST,
			ENV_TIE_HIGH,
			ENV_TIE_LOW,
			ENV_OLDEST,
		]);
		expect(new Set(probes.map((p) => p.environment_id)).size).toBe(4);
		expect(pages).toHaveLength(4);
		expect(pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true);
		expect(pages[pages.length - 1]?.next_cursor).toBeNull();
		// The total is the collection, not the remainder — it must not tick down as we page.
		expect(pages.every((p) => p.total === 4)).toBe(true);

		// The same walk at a page size that straddles the equal-created_at pair differently.
		const bigger = await walk(PROJECT_A, 2);
		expect(bigger.probes.map((p) => p.environment_id)).toEqual(
			probes.map((p) => p.environment_id),
		);
		expect(bigger.pages).toHaveLength(2);
	});

	it("serves the compatibility first page at the maximum bounded size", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(PROJECT_A);
		expect(body.page.limit).toBe(MAX_PAGE_SIZE);
		expect(body.probes).toHaveLength(4);
		expect(body.page.next_cursor).toBeNull();
	});

	it("refuses a malformed cursor and one minted for another list or tenant", async () => {
		actingAs(USER_A, ORG_A);
		const malformed = await request(PROJECT_A, "?cursor=not-a-cursor");
		expect(malformed.status).toBe(400);
		expect(malformed.body).toMatchObject({ error: "cursor is malformed" });

		const badLimit = await request(PROJECT_A, "?limit=-3");
		expect(badLimit.status).toBe(400);

		const first = await get(PROJECT_A, "?limit=1");
		const cursor = encodeURIComponent(first.page.next_cursor ?? "");
		// A probes cursor carries the `project-probes` list name, so the environments list — the
		// collection it happens to page over — must not accept it either.
		const { GET: environmentsGET } = await import(
			"@/app/api/cli/projects/[id]/environments/route"
		);
		const crossList = await environmentsGET(
			new Request(
				`http://console.test/api/cli/projects/${PROJECT_A}/environments?cursor=${cursor}`,
			),
			{ params: Promise.resolve({ id: PROJECT_A }) },
		);
		expect(crossList.status).toBe(400);

		actingAs(USER_B, ORG_B);
		const foreign = await request(PROJECT_B, `?cursor=${cursor}`);
		expect(foreign.status).toBe(400);
		expect(foreign.body).toMatchObject({
			error: "cursor was issued for a different list or organization",
		});
	});

	it("never resolves or reads another tenant's project", async () => {
		actingAs(USER_B, ORG_B);
		const denied = await request(PROJECT_A, "?limit=20");
		expect(denied.status).toBe(404);
		expect(denied.body).toMatchObject({ error: "Project not found" });

		const own = await get(PROJECT_B, "?limit=20");
		expect(own.probes).toHaveLength(1);
		expect(own.probes[0]).toMatchObject({
			environment_id: ENV_B,
			message: "tenant b",
		});

		// The org filter is inside the read itself, not only in the route's project lookup.
		const wrongOrg = await getLatestProbesByEnv(PROJECT_A, ORG_B);
		expect(wrongOrg.size).toBe(0);
		const rightOrg = await getLatestProbesByEnv(PROJECT_A, ORG_A);
		expect(rightOrg.size).toBe(3); // ENV_TIE_LOW has no probe row and stays absent
	});

	it("asks for no probe rows at all when the page of environments is empty", async () => {
		// An `inArray(col, [])` would be a query, and a wrong one; the empty page must not issue
		// a statement whose predicate no environment can satisfy.
		const none = await getLatestProbesByEnv(PROJECT_A, ORG_A, []);
		expect(none.size).toBe(0);

		const one = await getLatestProbesByEnv(PROJECT_A, ORG_A, [ENV_NEWEST]);
		expect(one.size).toBe(1);
		expect(one.get(ENV_NEWEST)?.message).toBe("gone dark");
	});

	it("plans one index lookup per environment instead of sorting the history", async () => {
		const db = getServiceDb();
		// Without stats the planner estimates one matching row, a sort of one row is free, and
		// the choice stops being about the index. Measured on Postgres 17 in the sibling suite.
		await db.execute(sql`analyze environment_probes`);

		// The EXPLAINed statement is the one lib/probes/persistence.ts issues, not a copy.
		const planned = await explain(latestProbesQuery(PROJECT_A, ORG_A));
		// The node that READS the probes, not the serialized plan. See scanOf.
		expect(scanOf(planned, "environment_probes")["Index Name"]).toBe(
			"idx_environment_probes_env_time",
		);
		// An index that is scanned and then sorted has bought nothing. Asked of the probe history
		// alone, so a merge join the outer plan chooses cannot answer for it.
		expect(sortsRowsOf(planned, "environment_probes")).toBe(false);

		// THE CONTROL, and it is the shape this change REPLACED: read every probe row for the
		// project newest-first and dedupe in JS. Without it "uses the index, no Sort" is not
		// evidence of anything, because nothing here would fail if the instrument could not tell
		// the two apart. The old shape cannot use idx_environment_probes_env_time at all — the
		// index leads on environment_id and this query has no equality on it — so it reads the
		// whole history and sorts it, which is the cost being removed.
		const control = await explain(
			db
				.select({
					environment_id: environmentProbes.environment_id,
					reachable: environmentProbes.reachable,
					probed_at: environmentProbes.probed_at,
				})
				.from(environmentProbes)
				.innerJoin(projects, eq(environmentProbes.project_id, projects.id))
				.where(
					and(
						eq(environmentProbes.project_id, PROJECT_A),
						eq(projects.org_id, ORG_A),
					),
				)
				.orderBy(desc(environmentProbes.probed_at)),
		);
		// The control SORTS the history, which is the cost being removed, and the assertion says
		// exactly that rather than "a Sort appears somewhere".
		//
		// ⚠ THIS FAILED ONCE, and the cause was the reader rather than the claim. The rule was "a
		// Sort whose subtree reads this relation AND NOTHING ELSE" — but this query joins `projects`
		// and sorts AFTER the join, so the Sort's subtree reads two relations and the rule answered
		// `false` for a plan whose entire cost is sorting the history. `sortsRowsOf` now asks
		// whether the scan is anywhere beneath a Sort, which is the question, and the offline suite
		// pins both shapes.
		//
		// The alternative reading offered for that failure was that the control can skip the sort by
		// walking `idx_environment_probes_env_time`. It cannot: that index leads on `environment_id`
		// and this query has no equality on it, so reading it in index order yields rows grouped by
		// environment, not ordered by `probed_at`. The failure message carries the plan so the next
		// run decides this on evidence rather than on either argument.
		// Written as a value comparison rather than `toBe(true)` so a failure PRINTS the plan:
		// `expect` takes no message argument here (vitest/valid-expect), and a bare
		// `expected false to be true` is what made the first failure an argument instead of a
		// measurement.
		const sorted = "the control sorts the probe history";
		expect(sortsRowsOf(control, "environment_probes") ? sorted : control).toBe(
			sorted,
		);
		// NOTHING IS ASSERTED ABOUT WHICH INDEX THE CONTROL TOUCHES, deliberately. The obvious
		// second assertion — that the old shape cannot reach idx_environment_probes_env_time — is
		// not true: the index leads on environment_id and this query has no equality on it, so it
		// cannot serve the PREDICATE or the ORDERING, but with sequential scans disabled Postgres
		// may still read the whole relation through it with no Index Cond at all, simply as a way
		// to reach the heap. A correct control would then fail while proving nothing. The sort is
		// the difference between the two shapes, and the sort is what is asserted.
	});
});
