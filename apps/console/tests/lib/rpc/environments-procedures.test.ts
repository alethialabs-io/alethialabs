// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments page's reads, moved from the `"use server"` actions onto the read router (#6120,
// ADR 0005 D1).
//
// Mocked boundary: the PDP guard, the database (a scripted service-role select and an actor-scoped
// transaction) and the readers this unit calls in-process from other units' modules. Real: the
// procedures, the `query` base (its refusal mapping and actor binding), the org binding
// (lib/promotions/org-binding.ts) and oRPC's input validation.
//
// WHAT THE DATABASE MOCK CANNOT SEE: it answers each select from a script, IN CALL ORDER, and ignores
// `.where(...)` entirely — so nothing here proves WHICH predicate a query carries. That the org-bound
// project lookup really filters on `projects.org_id = actor.orgId` (and the slug lookup likewise) is
// proven against real Postgres by tests/integration/rpc-tenancy.shared.ts (another org's ids and
// slug answer NOT_FOUND) and tests/integration/environments-project-deny.test.ts (a project deny).
//
// Pinned here, given those lookups' answers: the ORDER — a project the org-bound lookup did not find
// is a typed NOT_FOUND before the PDP is asked or any design is read; an environment outside the
// project is a NOT_FOUND; a malformed id is a BAD_REQUEST that never reaches the database; a failed
// active-promotion or protection read fails the page instead of reading as "none"; and no read
// writes. And the list standard's two paged reads (LST-3 #7485): `page` (the table, in memory) and
// `promotions` (the history, SQL keyset) — no count, a malformed cursor a BAD_REQUEST.
//
// ONE CANONICAL READ PER REQUEST (#7877). The last block runs the reads of one
// `[project]/environments` render — the `[project]` layout's switcher seed (`readEnvironmentsForSlug`,
// the body of `workspace.environments`), the overview, the table's pristine and filtered first pages,
// and the promotions history — inside ONE request, and counts the selects by table: one of the
// environment list, one org-bound project lookup. As in
// tests/lib/projects/resolve-project-once-per-request.test.ts, the `react` vitest resolves is the
// CLIENT build, whose `cache()` memoises nothing, so this file swaps in `cache` from React's own
// server build and installs a per-request dispatcher the way the RSC renderer does. Outside
// `inRequest` no dispatcher is installed and nothing is memoised, which every other test here relies
// on (and the last test pins).
//
// #7895 CLOSES THE LAST TWO. Inside the overview, the consistency matrix (`getEnvConsistency`) and the
// reconcile badges (`getEnvReconcileStates`) each used to select the environment list again. They now
// read it through `projectEnvironmentsFor`, the same memo. The final block runs the REAL reconcile read
// (`vi.importActual`) inside the render and counts one list select overall. The matrix's real body
// reads every environment's design through `getProjectAsFormData` in ITS OWN module, which this
// file's database script cannot answer, so here it is a stand-in that keeps its contract — the
// `view` check, then `projectEnvironmentsFor` as the checked actor — and tests/actions/projects.test.ts
// pins that the real one does exactly that.

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** React's server-build internals, captured when the `react` mock below is first evaluated. */
const server = vi.hoisted(() => ({
	internals: undefined as undefined | { A: unknown },
}));
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	const { createRequire } = await import("node:module");
	const path = await import("node:path");
	const require = createRequire(import.meta.url);
	const dir = path.dirname(require.resolve("react/package.json"));
	// The deep path is not in react's `exports`, so it is required by file name.
	const serverReact: {
		cache: typeof actual.cache;
		__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { A: unknown };
	} = require(path.join(dir, "cjs/react.react-server.development.js"));
	server.internals = serverReact.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	return { ...actual, default: actual, cache: serverReact.cache };
});

const h = vi.hoisted(() => ({
	authorizeRead: vi.fn(),
	authorize: vi.fn(),
	/** What each service-role `select … limit()` answers, in call order (an Error rejects). */
	serviceRows: [] as (unknown[] | Error)[],
	/** What each actor-scoped select answers, in call order (an Error rejects). */
	scopedRows: [] as (unknown[] | Error)[],
	/** How many selects were issued on either connection. */
	selects: 0,
	/** The table each select read `from`, in call order — what the per-request tests count. */
	froms: [] as unknown[],
	/** The actor each actor-scoped transaction was opened for. */
	scopes: [] as unknown[],
	/** The switcher's slug lookup (`resolveProjectId`, app/server/actions/resolve.ts). */
	resolveProjectId: vi.fn(),
	getEnvConsistency: vi.fn(),
	getProjectAsFormData: vi.fn(),
	getEnvReconcileStates: vi.fn(),
	diffDesigns: vi.fn(),
	/** The PDP's non-recording answer, by action. A missing key is allowed; "throw" rejects. */
	can: new Map<string, boolean | "throw">(),
	/** Every `can()` question asked, as `action:type:id`. */
	asked: [] as string[],
}));

const ACTOR = { userId: "user-1", orgId: "org-1", credential: "session" as const };
/** The actor `currentActor()` answers with; a test may switch it mid-request. */
const scope = vi.hoisted(() => ({ actor: { userId: "user-1", orgId: "org-1", credential: "session" as const } }));

vi.mock("@/lib/authz", () => ({
	getPdp: () => ({
		can: async (_actor: unknown, action: string, ref: { type: string; id?: string }) => {
			h.asked.push(`${action}:${ref.type}:${ref.id ?? ""}`);
			const answer = h.can.get(action);
			if (answer === "throw") throw new Error("pdp down");
			return { allowed: answer !== false };
		},
	}),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorizeRead: h.authorizeRead,
	authorize: h.authorize,
	currentActor: async () => scope.actor,
}));

/** A chainable select whose terminal (`limit`, or awaiting the chain) answers the next scripted rows. */
function chain(script: () => unknown[] | Error) {
	h.selects += 1;
	const next = async () => {
		const answer = script();
		if (answer instanceof Error) throw answer;
		return answer;
	};
	const node: Record<string, unknown> = {};
	for (const m of ["select", "where", "innerJoin", "leftJoin", "orderBy"]) {
		node[m] = () => node;
	}
	node.from = (table: unknown) => {
		h.froms.push(table);
		return node;
	};
	node.limit = async () => next();
	node.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
		next().then(resolve, reject);
	return node;
}

/** Any write on either connection fails the test: these are reads. */
const noWrites = {
	insert: () => {
		throw new Error("a read procedure wrote to the database");
	},
	update: () => {
		throw new Error("a read procedure wrote to the database");
	},
	delete: () => {
		throw new Error("a read procedure wrote to the database");
	},
};

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ ...noWrites, select: () => chain(() => h.serviceRows.shift() ?? []) }),
	withActorScope: async (actor: unknown, fn: (tx: unknown) => unknown) => {
		h.scopes.push(actor);
		return fn({ ...noWrites, select: () => chain(() => h.scopedRows.shift() ?? []) });
	},
}));
vi.mock("@/app/server/actions/projects", () => ({
	getEnvConsistency: h.getEnvConsistency,
	getProjectAsFormData: h.getProjectAsFormData,
}));
vi.mock("@/app/server/actions/resolve", () => ({ resolveProjectId: h.resolveProjectId }));
vi.mock("@/app/server/actions/reconcile", () => ({ getEnvReconcileStates: h.getEnvReconcileStates }));
vi.mock("@/lib/promotions/diff", () => ({ diffDesigns: h.diffDesigns, structuralHash: () => "hash" }));
// The real reconcile read's own collaborators (#7895 block): no probe, no cluster evidence.
vi.mock("@/lib/probes/persistence", () => ({ getLatestProbesByEnv: async () => new Map() }));
vi.mock("@/lib/clusters/observed-evidence", () => ({
	readClusterEvidence: async () => ({ drift: new Map(), probes: new Map() }),
}));
vi.mock("@/lib/promotions/lifecycle", () => ({
	IN_FLIGHT: ["PENDING_PLAN", "PENDING_APPROVAL", "APPROVED", "DEPLOYING"],
}));

import { notFound } from "next/navigation";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ForbiddenError } from "@/lib/authz/types";
import { projectEnvironments, projects } from "@/lib/db/schema";
import {
	environmentsRouter,
	projectEnvironmentsFor,
	readEnvironmentsForSlug,
} from "@/lib/rpc/procedures/environments";

const client = createRouterClient(environmentsRouter, { context: { actor: ACTOR } });

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV_A = "22222222-2222-4222-8222-222222222222";
const ENV_B = "33333333-3333-4333-8333-333333333333";

/** The code of a typed refusal a call rejected with. */
async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "ok";
	} catch (error) {
		return error instanceof ORPCError ? error.code : String(error);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	h.serviceRows.length = 0;
	h.scopedRows.length = 0;
	h.selects = 0;
	h.froms.length = 0;
	h.scopes.length = 0;
	h.can.clear();
	h.asked.length = 0;
	scope.actor = ACTOR;
	h.authorizeRead.mockImplementation(async () => scope.actor);
	h.resolveProjectId.mockResolvedValue(PROJECT);
	h.getEnvConsistency.mockResolvedValue({ envs: [], rows: [] });
	h.getEnvReconcileStates.mockResolvedValue([]);
});

describe("environments.protectionRules", () => {
	it("a project of another org is NOT_FOUND, and the PDP is never asked about it", async () => {
		h.serviceRows.push([]); // the org-bound project lookup finds nothing
		expect(await codeOf(client.protectionRules({ projectId: PROJECT, environmentId: ENV_A }))).toBe(
			"NOT_FOUND",
		);
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});

	it("an environment outside the project is NOT_FOUND", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([]); // the environment is not one of the project's
		expect(await codeOf(client.protectionRules({ projectId: PROJECT, environmentId: ENV_A }))).toBe(
			"NOT_FOUND",
		);
	});

	it("answers the environment's rules, naming the environment — null when none are set", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([{ id: ENV_A }], []);
		expect(await client.protectionRules({ projectId: PROJECT, environmentId: ENV_A })).toEqual({
			environmentId: ENV_A,
			rules: null,
		});
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
	});

	it("a PDP refusal is a typed FORBIDDEN", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.authorizeRead.mockRejectedValue(new ForbiddenError("view", { type: "project", id: PROJECT }));
		expect(await codeOf(client.protectionRules({ projectId: PROJECT, environmentId: ENV_A }))).toBe(
			"FORBIDDEN",
		);
	});

	it("a malformed id never reaches the database", async () => {
		expect(await codeOf(client.protectionRules({ projectId: "nope", environmentId: ENV_A }))).toBe(
			"BAD_REQUEST",
		);
		expect(h.selects).toBe(0);
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});
});

describe("environments.promotionPreview", () => {
	it("a project of another org is NOT_FOUND before any design is read", async () => {
		h.serviceRows.push([]);
		const input = { projectId: PROJECT, sourceId: ENV_A, targetId: ENV_B, includeRemovals: false };
		expect(await codeOf(client.promotionPreview(input))).toBe("NOT_FOUND");
		expect(h.getProjectAsFormData).not.toHaveBeenCalled();
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});

	it("an environment outside the project is NOT_FOUND before any design is read", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([{ id: ENV_A }]); // only one of the two is the project's
		const input = { projectId: PROJECT, sourceId: ENV_A, targetId: ENV_B, includeRemovals: false };
		expect(await codeOf(client.promotionPreview(input))).toBe("NOT_FOUND");
		expect(h.getProjectAsFormData).not.toHaveBeenCalled();
	});

	it("diffs the two designs and names the pair", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([{ id: ENV_A }, { id: ENV_B }]);
		h.getProjectAsFormData.mockImplementation(async (_p: string, env: string) => ({ formData: { env } }));
		const diff = { changes: [], summary: ["0 changes"], include_removals: true };
		h.diffDesigns.mockReturnValue(diff);
		expect(
			await client.promotionPreview({ projectId: PROJECT, sourceId: ENV_A, targetId: ENV_B, includeRemovals: true }),
		).toEqual({ sourceId: ENV_A, targetId: ENV_B, diff });
		expect(h.diffDesigns).toHaveBeenCalledWith({ env: ENV_A }, { env: ENV_B }, true);
	});
});

describe("environments.overview", () => {
	it("a slug with no project in the ADDRESSED org is NOT_FOUND — never another org's project", async () => {
		h.serviceRows.push([]);
		expect(await codeOf(client.overview({ project: "payments" }))).toBe("NOT_FOUND");
		expect(h.froms).not.toContain(projectEnvironments);
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});

	it("answers the page for the resolved project; a failed enrichment degrades, the list does not", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getEnvConsistency.mockRejectedValue(new Error("a deleted cloud identity"));
		h.scopedRows.push(
			// The canonical environment list, then: no promotion in flight, no protection rules.
			[{ id: ENV_A, name: "dev", stage: "development", is_default: true, updated_at: new Date("2026-10-01T00:00:00Z") }],
			[],
			[],
		);
		const out = await client.overview({ project: "payments" });
		expect(out).toMatchObject({
			projectId: PROJECT,
			facts: { [ENV_A]: { updated_at: "2026-10-01T00:00:00.000Z" } },
			consistency: { envs: [{ id: ENV_A, name: "dev", stage: "development" }], rows: [] },
			activePromotion: null,
			protectionByEnv: {},
		});
		// The history is its own keyset read now; the overview carries neither it nor a list page.
		expect(out).not.toHaveProperty("promotions");
		expect(out).not.toHaveProperty("page");
		// The list was read under the actor's RLS scope, AFTER the PDP answered `view`.
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
		expect(h.scopes[0]).toEqual({ userId: ACTOR.userId, orgId: ACTOR.orgId });
	});

	it("carries per-environment facts keyed by id — no names, stages or default, which the canonical entry owns (#7895)", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
		h.scopedRows.push(
			[
				{ id: ENV_B, name: "qa", stage: "staging", is_default: false, status: "FAILED", byo_admission_enforce: true, updated_at: at(1) },
				{ id: ENV_A, name: "dev", stage: "development", is_default: true, status: "ACTIVE", byo_admission_enforce: false, updated_at: at(2) },
			],
			[],
			[],
		);
		const out = await client.overview({ project: "payments" });
		expect(Object.keys(out.facts).sort()).toEqual([ENV_A, ENV_B].sort());
		expect(out.facts[ENV_B]).toMatchObject({
			status: "FAILED",
			updated_at: "2026-10-01T00:00:00.000Z",
			byo_admission_enforce: true,
		});
		for (const facts of Object.values(out.facts)) {
			expect(facts).not.toHaveProperty("name");
			expect(facts).not.toHaveProperty("stage");
			expect(facts).not.toHaveProperty("is_default");
		}
		expect(out).not.toHaveProperty("envs");
	});

	it("the matrix's fallback still lists the default first, then oldest first", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getEnvConsistency.mockRejectedValue(new Error("a deleted cloud identity"));
		const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
		h.scopedRows.push(
			[
				{ id: ENV_B, name: "qa", stage: "staging", is_default: false, updated_at: at(1) },
				{ id: ENV_A, name: "dev", stage: "development", is_default: true, updated_at: at(2) },
			],
			[],
			[],
		);
		const out = await client.overview({ project: "payments" });
		expect(out.consistency.envs.map((e) => e.id)).toEqual([ENV_A, ENV_B]);
	});

	it("a PDP refusal reads no environment", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.authorizeRead.mockRejectedValue(new ForbiddenError("view", { type: "project", id: PROJECT }));
		expect(await codeOf(client.overview({ project: "payments" }))).toBe("FORBIDDEN");
		expect(h.froms).not.toContain(projectEnvironments);
	});

	it("says what the viewer may do — edit and deploy, asked of THIS project, with nothing recorded (#6819)", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.can.set("deploy", false);
		const out = await client.overview({ project: "payments" });
		expect(out).toMatchObject({ canManage: true, canPromote: false });
		expect(h.asked.sort()).toEqual([`deploy:project:${PROJECT}`, `edit:project:${PROJECT}`]);
	});

	it("is fail-closed on the write side: a PDP error is a read-only page, not a failed one", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.can.set("edit", "throw");
		h.can.set("deploy", "throw");
		const out = await client.overview({ project: "payments" });
		expect(out).toMatchObject({ projectId: PROJECT, canManage: false, canPromote: false });
	});

	it("a failed active-promotion read fails the page — it never reads as 'no promotion in flight'", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([], new Error("promotions read failed"), []);
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});

	it("a failed protection read fails the page — it never reads as 'no protection'", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([], [], new Error("protection read failed"));
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});

	it("a failure of the environment list itself is a failure — not an empty page", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push(new Error("database down"));
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});
});

describe("environments.page — the table, one keyset page at a time (LST-3 #7485)", () => {
	const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
	const ENVS = [
		{ id: ENV_A, name: "dev", stage: "development", status: "ACTIVE", is_default: true, created_at: at(1), updated_at: at(1) },
		{ id: ENV_B, name: "prod", stage: "production", status: "FAILED", is_default: false, created_at: at(2), updated_at: at(2) },
	];

	it("a slug with no project in the ADDRESSED org is NOT_FOUND", async () => {
		h.serviceRows.push([]);
		expect(await codeOf(client.page({ project: "payments" }))).toBe("NOT_FOUND");
		expect(h.froms).not.toContain(projectEnvironments);
	});

	it("the filters narrow the rows, not the facets; newest first; no count", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push(ENVS);
		const out = await client.page({ project: "payments", stages: ["production"] });
		expect(out.rows.map((e) => e.id)).toEqual([ENV_B]);
		expect(out).toMatchObject({ nextCursor: null, universeEmpty: false });
		expect(out).not.toHaveProperty("total");
		// The facet pass never saw the filter: both stages keep their counts.
		expect(out.facets?.stages).toEqual([
			{ value: "development", label: null, count: 1 },
			{ value: "staging", label: null, count: 0 },
			{ value: "production", label: null, count: 1 },
		]);
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
	});

	it("pages: a page of one hands back the cursor, and the next page is the rest, without facets", async () => {
		h.serviceRows.push([{ id: PROJECT }], [{ id: PROJECT }]);
		// Outside a render nothing is memoised: each page reads the list.
		h.scopedRows.push(ENVS, ENVS);
		const first = await client.page({ project: "payments", limit: 1 });
		expect(first.rows.map((e) => e.id)).toEqual([ENV_B]);
		if (first.nextCursor === null) throw new Error("expected a next page");
		const second = await client.page({ project: "payments", limit: 1, cursor: first.nextCursor });
		expect(second.rows.map((e) => e.id)).toEqual([ENV_A]);
		expect(second).toMatchObject({ nextCursor: null, facets: null, universeEmpty: null });
	});

	it("a project with no environment is universeEmpty — the first-run state, not 'no match'", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		const out = await client.page({ project: "payments", search: "x" });
		expect(out).toMatchObject({ rows: [], universeEmpty: true });
	});

	it("a malformed cursor is a BAD_REQUEST that never reaches the database", async () => {
		expect(await codeOf(client.page({ project: "payments", cursor: "not-a-cursor" }))).toBe("BAD_REQUEST");
		expect(h.selects).toBe(0);
	});
});

describe("environments.promotions — the history, one SQL keyset page at a time (LST-3 #7485)", () => {
	const row = (n: number) => ({
		id: `00000000-0000-4000-8000-00000000000${n}`,
		source_environment_id: ENV_A,
		target_environment_id: ENV_B,
		status: "SUCCEEDED",
		error_message: null,
		created_at: new Date(`2026-11-0${n}T00:00:00Z`),
	});

	it("a slug with no project in the ADDRESSED org is NOT_FOUND, and the PDP is never asked", async () => {
		h.serviceRows.push([]);
		expect(await codeOf(client.promotions({ project: "payments" }))).toBe("NOT_FOUND");
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});

	it("answers one page for the resolved project, gated on view, with ISO instants and no count", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([row(3), row(2), row(1)]);
		const out = await client.promotions({ project: "payments", limit: 2 });
		expect(out.rows.map((p) => p.created_at)).toEqual(["2026-11-03T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
		expect(out.nextCursor).not.toBeNull();
		expect(out).toMatchObject({ facets: null, universeEmpty: false });
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
	});

	it("a PDP refusal is a typed FORBIDDEN", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.authorizeRead.mockRejectedValue(new ForbiddenError("view", { type: "project", id: PROJECT }));
		expect(await codeOf(client.promotions({ project: "payments" }))).toBe("FORBIDDEN");
	});

	it("a malformed cursor or an oversized limit is a BAD_REQUEST that never reaches the database", async () => {
		expect(await codeOf(client.promotions({ project: "payments", cursor: "nope" }))).toBe("BAD_REQUEST");
		expect(await codeOf(client.promotions({ project: "payments", limit: 101 }))).toBe("BAD_REQUEST");
		expect(h.selects).toBe(0);
	});
});

describe("readEnvironmentsForSlug — the switcher's read, `workspace.environments` (#7877)", () => {
	const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
	const ROWS = [
		{ id: ENV_A, project_id: PROJECT, name: "dev", stage: "development", is_default: true, status: "ACTIVE", byo_admission_enforce: false, created_at: at(1), updated_at: at(1) },
	];

	it("answers the slim switcher rows, under the actor's RLS scope and without asking the PDP", async () => {
		h.scopedRows.push(ROWS);
		await expect(readEnvironmentsForSlug("payments")).resolves.toEqual([
			{ id: ENV_A, project_id: PROJECT, name: "dev", stage: "development", is_default: true },
		]);
		expect(h.resolveProjectId).toHaveBeenCalledWith("payments");
		expect(h.authorizeRead).not.toHaveBeenCalled();
		expect(h.scopes).toEqual([{ userId: ACTOR.userId, orgId: ACTOR.orgId }]);
	});

	it("a slug that names no project in scope is [] — the switcher hides", async () => {
		h.resolveProjectId.mockImplementation(async () => notFound());
		await expect(readEnvironmentsForSlug("nope")).resolves.toEqual([]);
		expect(h.froms).not.toContain(projectEnvironments);
	});

	it("a lost session and any other failure are rethrown, never an empty switcher", async () => {
		h.resolveProjectId.mockRejectedValueOnce(new UnauthorizedError());
		await expect(readEnvironmentsForSlug("payments")).rejects.toBeInstanceOf(UnauthorizedError);
		h.resolveProjectId.mockRejectedValueOnce(new Error("database down"));
		await expect(readEnvironmentsForSlug("payments")).rejects.toThrow("database down");
	});
});

/**
 * Runs `fn` as one server request: installs a dispatcher holding a fresh per-request cache, as
 * React's RSC renderer does, and removes it afterwards.
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
	const internals = server.internals;
	if (!internals) throw new Error("react's server build was not loaded");
	const caches = new Map<() => unknown, unknown>();
	internals.A = {
		getCacheForType: (create: () => unknown) => {
			if (!caches.has(create)) caches.set(create, create());
			return caches.get(create);
		},
		cacheSignal: () => null,
	};
	try {
		return await fn();
	} finally {
		internals.A = null;
	}
}

describe("one [project]/environments render: one environment-list read, one project resolution (#7877)", () => {
	const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
	const ENVS = [
		{ id: ENV_A, project_id: PROJECT, name: "dev", stage: "development", is_default: true, status: "ACTIVE", byo_admission_enforce: false, created_at: at(1), updated_at: at(1) },
		{ id: ENV_B, project_id: PROJECT, name: "prod", stage: "production", is_default: false, status: "FAILED", byo_admission_enforce: false, created_at: at(2), updated_at: at(2) },
	];

	/** How many selects read each table. */
	const reads = (table: unknown) => h.froms.filter((t) => t === table).length;

	/** Every read the layout and the page issue for `/acme/payments/environments?stages=production`. */
	async function renderEnvironmentsPage() {
		const seed = await readEnvironmentsForSlug("payments"); // the [project] layout's switcher seed
		const overview = await client.overview({ project: "payments" });
		const pristine = await client.page({ project: "payments" });
		const filtered = await client.page({ project: "payments", stages: ["production"] });
		await client.promotions({ project: "payments" });
		return { seed, overview, pristine, filtered };
	}

	beforeEach(() => {
		// The org-bound lookup answers the project; the FIRST actor-scoped select is the list. Every
		// later scoped select (promotion, protection, history) answers its default `[]`.
		h.serviceRows.push([{ id: PROJECT }], [{ id: PROJECT }], [{ id: PROJECT }], [{ id: PROJECT }]);
		h.scopedRows.push(ENVS);
	});

	it("the switcher seed, the overview and both table pages share ONE select of the environment list", async () => {
		const { seed, overview, pristine, filtered } = await inRequest(renderEnvironmentsPage);
		expect(reads(projectEnvironments)).toBe(1);
		// …and every one of them answered from it.
		expect(seed.map((e) => e.id)).toEqual([ENV_A, ENV_B]);
		expect(Object.keys(overview.facts)).toEqual([ENV_A, ENV_B]);
		expect(pristine.rows.map((e) => e.id)).toEqual([ENV_B, ENV_A]);
		expect(filtered.rows.map((e) => e.id)).toEqual([ENV_B]);
	});

	it("the overview, both table pages and the history resolve the slug against the org ONCE", async () => {
		await inRequest(renderEnvironmentsPage);
		expect(reads(projects)).toBe(1);
	});

	it("the PDP is still asked on every gated read — only the queries are shared", async () => {
		await inRequest(renderEnvironmentsPage);
		// overview, two pages, the history: four `view` checks, none skipped by the memo.
		expect(h.authorizeRead).toHaveBeenCalledTimes(4);
	});

	it("the memo is keyed on the actor: another actor in the same request is a fresh, scoped read", async () => {
		await inRequest(async () => {
			await client.page({ project: "payments" });
			scope.actor = { ...ACTOR, orgId: "org-2" };
			await client.page({ project: "payments" });
		});
		expect(reads(projects)).toBe(2);
		expect(reads(projectEnvironments)).toBe(2);
		expect(h.scopes).toEqual([
			{ userId: ACTOR.userId, orgId: "org-1" },
			{ userId: ACTOR.userId, orgId: "org-2" },
		]);
	});

	it("nothing is shared across requests", async () => {
		h.scopedRows.push(ENVS);
		await inRequest(() => client.page({ project: "payments" }));
		await inRequest(() => client.page({ project: "payments" }));
		expect(reads(projects)).toBe(2);
		expect(reads(projectEnvironments)).toBe(2);
	});

	it("outside a render (a GET from the browser) every read queries, as before", async () => {
		h.scopedRows.push(ENVS);
		await client.page({ project: "payments" });
		await client.page({ project: "payments" });
		expect(reads(projects)).toBe(2);
		expect(reads(projectEnvironments)).toBe(2);
	});
});

describe("#7895: one environment-list select per render — the matrix and the reconcile badges included", () => {
	const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
	const ENVS = [
		{ id: ENV_A, project_id: PROJECT, name: "dev", stage: "development", is_default: true, status: "ACTIVE", byo_admission_enforce: false, auto_heal: true, deployed_config_hash: null, last_deployed_at: null, created_at: at(1), updated_at: at(1) },
		{ id: ENV_B, project_id: PROJECT, name: "prod", stage: "production", is_default: false, status: "ACTIVE", byo_admission_enforce: false, auto_heal: false, deployed_config_hash: null, last_deployed_at: at(2), created_at: at(2), updated_at: at(2) },
	];

	/** How many selects read each table. */
	const reads = (table: unknown) => h.froms.filter((t) => t === table).length;

	beforeEach(async () => {
		// The org-bound slug lookup answers the project ONCE (memoised); every later service select
		// (the reconcile read's drift and delivery rows, BYO admission) answers its default `[]`. The
		// FIRST actor-scoped select is the list.
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push(ENVS);
		h.authorize.mockImplementation(async () => scope.actor);
		// The REAL reconcile read: its own `view` check, then the canonical list as that actor.
		const reconcile = await vi.importActual<typeof import("@/app/server/actions/reconcile")>(
			"@/app/server/actions/reconcile",
		);
		h.getEnvReconcileStates.mockImplementation(reconcile.getEnvReconcileStates);
		// The matrix's contract (see the file header): the read check, then the canonical list as the
		// checked actor — never a select of its own.
		h.getEnvConsistency.mockImplementation(async (projectId: string) => {
			const actor = await h.authorizeRead("view", { type: "project", id: projectId });
			const rows = await projectEnvironmentsFor(actor, projectId);
			return { envs: rows.map((e) => ({ id: e.id, name: e.name, stage: e.stage })), rows: [] };
		});
	});

	/** The `[project]` layout's switcher seed, then the page's overview and its pristine table page. */
	async function renderEnvironmentsPage() {
		const seed = await readEnvironmentsForSlug("payments");
		const overview = await client.overview({ project: "payments" });
		const page = await client.page({ project: "payments" });
		return { seed, overview, page };
	}

	it("the seed, the overview — its matrix and its badges — and the table share ONE list select", async () => {
		const { seed, overview, page } = await inRequest(renderEnvironmentsPage);
		expect(reads(projectEnvironments)).toBe(1);
		// Every reader answered from that one select: the badges name both environments, with the
		// columns the canonical read now carries for them.
		expect(seed.map((e) => e.id)).toEqual([ENV_A, ENV_B]);
		expect(overview.reconcile.map((r) => [r.environmentId, r.autoHeal, r.lastDeployedAt])).toEqual([
			[ENV_A, true, null],
			[ENV_B, false, "2026-10-02T00:00:00.000Z"],
		]);
		expect(overview.consistency.envs.map((e) => e.id)).toEqual([ENV_A, ENV_B]);
		expect(page.rows.map((e) => e.id)).toEqual([ENV_B, ENV_A]);
	});

	it("every check is still asked — the badges' recording `view`, the matrix's and each gated read's — and RLS scopes the one select", async () => {
		await inRequest(renderEnvironmentsPage);
		expect(h.authorize).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
		// overview, the matrix, the table page: three read checks; none skipped by the memo.
		expect(h.authorizeRead).toHaveBeenCalledTimes(3);
		expect(h.scopes[0]).toEqual({ userId: ACTOR.userId, orgId: ACTOR.orgId });
	});
});
