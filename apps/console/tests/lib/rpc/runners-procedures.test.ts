// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6123: the runners domain's read procedures. Tenancy (address beats session, a non-member is a 404)
// is proved for every procedure by tests/integration/rpc-tenancy.*, and RLS by
// tests/integration/runners-org-bounded.test.ts; this file pins what each read RETURNS — above all
// that no runner read selects or returns the credential column — and what it does not do.

import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The database stand-in. A read is `select(projection).from(table)…`, awaited at the end of its
 * chain; the answer is chosen by the TABLE and by the path (`tx` = the RLS path through
 * `withActorScope`, `svc` = the service path), so the reads `Promise.all` runs side by side cannot
 * take each other's rows whatever order they resolve in. Every projection is recorded.
 */
const h = vi.hoisted(() => ({
	rows: new Map<string, unknown[]>(),
	projections: [] as { path: string; table: string; projection: unknown }[],
	hours: [] as { runner_id: string; provisioned_hours: number }[],
	mode: "self-managed" as "hosted" | "self-managed",
	jobsForbidden: false,
	wheres: [] as { path: string; table: string; where: unknown }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), authorizeQuiet: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: () => h.mode }));
vi.mock("@/lib/queries/runner-usage", () => ({
	queryProvisionedHours: vi.fn(async () => h.hours),
	provisionedHoursByProvider: vi.fn(),
	jobMinutesByProvider: vi.fn(),
}));
vi.mock("@/lib/fleet/queue", () => ({ latestReleaseVersion: vi.fn(), managedRunnerRowsForProvider: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
// Job visibility follows project visibility (lib/jobs/visibility.ts, #6121): the overlay must apply
// the same predicate. A marker stands in for it, so the test sees whether it reached the WHERE.
vi.mock("@/lib/jobs/visibility", async () => {
	const { sql } = await import("drizzle-orm");
	return { jobVisibleTo: vi.fn(async () => sql`job_visible_marker`) };
});
vi.mock("@/lib/db", async () => {
	const { getTableName } = await import("drizzle-orm");
	const { Table } = await import("drizzle-orm");
	/** One select chain on `path`; awaiting it answers the rows seeded for `path:table`. */
	const chain = (path: string) => {
		let table = "";
		const c = {
			select: (projection: unknown) => {
				h.projections.push({ path, table: "", projection });
				return c;
			},
			from: (t: unknown) => {
				table = t instanceof Table ? getTableName(t) : String(t);
				const last = h.projections.at(-1);
				if (last && last.table === "") last.table = table;
				return c;
			},
			leftJoin: () => c,
			where: (w: unknown) => {
				h.wheres.push({ path, table, where: w });
				return c;
			},
			orderBy: () => c,
			limit: () => c,
			then: (resolve: (v: unknown) => void) => resolve(h.rows.get(`${path}:${table}`) ?? []),
		};
		return c;
	};
	return {
		getServiceDb: () => chain("svc"),
		withActorScope: (_actor: unknown, fn: (tx: unknown) => unknown) => fn(chain("tx")),
	};
});

import { authorize, authorizeQuiet } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { runners } from "@/lib/db/schema";
import {
	readOwnRunnerViews,
	readReleaseNotes,
	readRunnersData,
	readRunnersPage,
	RUNNER_CHANGELOG_LENGTH,
} from "@/lib/rpc/procedures/runners";

const ORG = "o1";
const USER = "u1";

/** A selected own-runner row, as the RLS read returns it. */
function own(over: Record<string, unknown> = {}, release: unknown = null) {
	return {
		runner: {
			id: "r1",
			name: "edge",
			operator: "self",
			provisioning: "deployed",
			supported_providers: ["aws"],
			status: "ONLINE",
			last_heartbeat: new Date("2026-10-01T00:00:00Z"),
			version: "1.2.0",
			location: null,
			is_default: false,
			org_id: ORG,
			// Computed in SQL from cloud_identity_id + metadata (RUNNER_COLUMNS); the row carries only these.
			in_place: false,
			cloud_instance_id: null,
			...over,
		},
		release,
	};
}

/** A selected managed-runner row, as the service read returns it. */
function managed(over: Record<string, unknown> = {}) {
	return own({ id: "m1", name: "fleet-1", operator: "managed", provisioning: null, org_id: null, location: "fsn1", ...over });
}

const RELEASE = {
	version: "1.3.0",
	release_notes: "notes",
	released_at: new Date("2026-09-01T00:00:00Z"),
	github_release_url: null,
	commit_sha: null,
	is_breaking: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	h.rows = new Map();
	h.projections = [];
	h.hours = [];
	h.mode = "self-managed";
	h.jobsForbidden = false;
	h.wheres = [];
	vi.mocked(authorize).mockImplementation(async () => ({ userId: USER, orgId: ORG }));
	vi.mocked(authorizeQuiet).mockImplementation(async (_action, resource) => {
		if (h.jobsForbidden && resource.type === "job") throw new ForbiddenError("view", { type: "job" });
		return { userId: USER, orgId: ORG };
	});
});

describe("no runner read selects or returns the credential column", () => {
	it("every runners projection names columns, and the credential and raw tenancy columns are not among them", async () => {
		h.rows.set("tx:runners", [own()]);
		h.rows.set("svc:runners", [managed()]);
		await readRunnersData();
		const runnerSelects = h.projections.filter((p) => p.table === "runners");
		// Both paths: the RLS read of the org's own runners and the service read of the managed fleet.
		expect(runnerSelects.map((p) => p.path).sort()).toEqual(["svc", "tx"]);
		const all = getTableColumns(runners);
		for (const { projection } of runnerSelects) {
			expect(projection).toBeTypeOf("object");
			const runnerColumns = Object.values(Reflect.get(Object(projection), "runner"));
			// A projection, never the whole table object (which is what `select({ runner: runners })` did).
			expect(runnerColumns).not.toContain(undefined);
			expect(runnerColumns).not.toContain(all.token_hash);
			// Not even into server memory: the facts the UI needs from it are derived in SQL.
			expect(runnerColumns).not.toContain(all.metadata);
			expect(runnerColumns).not.toContain(all.cloud_identity_id);
			expect(runnerColumns).not.toContain(all.user_id);
			expect(runnerColumns).not.toContain(all.mode);
		}
	});

	it("a runner view carries exactly the fields the UI renders", async () => {
		h.rows.set("tx:runners", [own({ token_hash: "leak", user_id: USER, mode: "self", target_release_id: "x" })]);
		const [view] = (await readRunnersData()).runners;
		expect(Object.keys(view).sort()).toEqual(
			[
				"active_job",
				"cloud_instance_id",
				"id",
				"in_place",
				"is_default",
				"last_heartbeat",
				"location",
				"name",
				"operator",
				"personal_elsewhere",
				"provisioned_hours",
				"provisioning",
				"runner_releases",
				"status",
				"supported_providers",
				"version",
			].sort(),
		);
	});

	it("the two derived facts pass through as the database computed them; managed-only VM ids stay managed-only", async () => {
		h.rows.set("tx:runners", [
			own({ id: "a", in_place: true }),
			own({ id: "b", in_place: false, cloud_instance_id: "vm-should-not-show" }),
		]);
		h.rows.set("svc:runners", [managed({ cloud_instance_id: "vm-7" })]);
		const views = (await readRunnersData()).runners;
		expect(views.map((v) => [v.id, v.in_place, v.cloud_instance_id])).toEqual([
			["a", true, null],
			["b", false, null],
			["m1", false, "vm-7"],
		]);
	});

	it("the mention picker's list (getRunnersWithReleases) is the same projected view", async () => {
		h.rows.set("tx:runners", [own({ token_hash: "leak", metadata: { secret: true } })]);
		const [view] = await readOwnRunnerViews();
		expect(view).not.toHaveProperty("token_hash");
		expect(view).not.toHaveProperty("metadata");
	});
});

describe("runners.list — the universe, the latest release and the changelog", () => {
	it("composes the org's runners then the managed fleet, with managed hours and the release changelog", async () => {
		h.rows.set("tx:runners", [own()]);
		h.rows.set("svc:runners", [managed({ cloud_instance_id: "vm-7" })]);
		h.rows.set("tx:runner_releases", [RELEASE]);
		h.hours = [{ runner_id: "m1", provisioned_hours: 12 }];
		const data = await readRunnersData();
		expect(data.runners.map((r) => r.id)).toEqual(["r1", "m1"]);
		expect(data.runners[1]).toMatchObject({ provisioned_hours: 12, cloud_instance_id: "vm-7", is_default: false });
		expect(data.runners[0]).toMatchObject({ provisioned_hours: null, cloud_instance_id: null });
		expect(data.latestRelease).toEqual({ ...RELEASE, released_at: "2026-09-01T00:00:00.000Z" });
		expect(data.releases).toHaveLength(1);
	});

	it("on the hosted SaaS the managed fleet is neither read nor returned", async () => {
		h.mode = "hosted";
		h.rows.set("tx:runners", [own()]);
		h.rows.set("svc:runners", [managed()]);
		const data = await readRunnersData();
		expect(data.runners.map((r) => r.id)).toEqual(["r1"]);
		expect(h.projections.some((p) => p.path === "svc" && p.table === "runners")).toBe(false);
	});

	it("reads `is_default` as the default of the ADDRESSED org, and flags a personal runner seen from a team org", async () => {
		h.rows.set("tx:runners", [
			own({ id: "here", is_default: true, org_id: ORG }),
			own({ id: "mine", is_default: true, org_id: USER }),
		]);
		const views = (await readRunnersData()).runners;
		expect(views.map((v) => [v.id, v.is_default, v.personal_elsewhere])).toEqual([
			["here", true, false],
			["mine", false, true],
		]);
	});

	it("asks for the changelog's length and authorizes `view` on runner", async () => {
		await readRunnersData();
		expect(authorize).toHaveBeenCalledWith("view", { type: "runner" });
		expect(RUNNER_CHANGELOG_LENGTH).toBe(8);
	});

	it("joins each runner to the job in flight on it: a lifecycle job by its target, any other by its runner", async () => {
		h.rows.set("tx:runners", [own({ id: "a" }), own({ id: "b" })]);
		h.rows.set("tx:jobs", [
			{ id: "j1", job_type: "UPDATE_RUNNER", runner_id: "b", target: "a", project_name: null },
			{ id: "j2", job_type: "PLAN", runner_id: "b", target: null, project_name: "shop" },
		]);
		const views = (await readRunnersData()).runners;
		expect(views.map((v) => [v.id, v.active_job])).toEqual([
			["a", { id: "j1", job_type: "UPDATE_RUNNER", project_name: null }],
			["b", { id: "j2", job_type: "PLAN", project_name: "shop" }],
		]);
		// Asked quietly: a refetched probe must not record an activity entry on every hint.
		expect(authorizeQuiet).toHaveBeenCalledWith("view", { type: "job" });
		expect(authorize).not.toHaveBeenCalledWith("view", { type: "job" });
	});

	it("the overlay reads only jobs the reader may see: the project-visibility predicate is in its WHERE", async () => {
		const { PgDialect } = await import("drizzle-orm/pg-core");
		const { SQL } = await import("drizzle-orm");
		await readRunnersData();
		const jobsWhere = h.wheres.find((w) => w.table === "jobs")?.where;
		if (!(jobsWhere instanceof SQL)) throw new Error("the overlay built no WHERE");
		expect(new PgDialect().sqlToQuery(jobsWhere).sql).toContain("job_visible_marker");
	});

	it("a reader who may not see jobs gets the runners without an overlay, not a refused page", async () => {
		h.jobsForbidden = true;
		h.rows.set("tx:runners", [own()]);
		h.rows.set("tx:jobs", [{ id: "j1", job_type: "PLAN", runner_id: "r1", target: null, project_name: null }]);
		const [view] = (await readRunnersData()).runners;
		expect(view.active_job).toBeNull();
	});

	it("propagates a refused runner read (it is the page's FORBIDDEN, not an empty list)", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view", { type: "runner" }));
		await expect(readRunnersData()).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe("runners.page — the grid", () => {
	it("narrows by the query and counts facets over every runner", async () => {
		h.rows.set("tx:runners", [own({ id: "a", status: "ONLINE" }), own({ id: "b", status: "OFFLINE", supported_providers: ["gcp"] })]);
		const page = await readRunnersPage({ statuses: ["OFFLINE"] });
		expect(page.rows.map((r) => r.id)).toEqual(["b"]);
		expect(page.total).toBe(2);
		expect(page.facets.clouds.map((c) => c.value)).toEqual(["aws", "gcp"]);
	});
});

describe("runners.releaseNotes", () => {
	it("returns the matched version, ISO-dated, or null", async () => {
		h.rows.set("tx:runner_releases", [RELEASE]);
		expect((await readReleaseNotes("1.3.0"))?.released_at).toBe("2026-09-01T00:00:00.000Z");
		h.rows.set("tx:runner_releases", []);
		expect(await readReleaseNotes("0.0.0")).toBeNull();
	});
});
