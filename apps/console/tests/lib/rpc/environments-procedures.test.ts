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

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
	authorizeRead: vi.fn(),
	authorize: vi.fn(),
	/** What each service-role `select … limit()` answers, in call order (an Error rejects). */
	serviceRows: [] as (unknown[] | Error)[],
	/** What each actor-scoped select answers, in call order (an Error rejects). */
	scopedRows: [] as (unknown[] | Error)[],
	/** How many selects were issued on either connection. */
	selects: 0,
	getProjectEnvironments: vi.fn(),
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
	currentActor: async () => ACTOR,
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
	for (const m of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy"]) {
		node[m] = () => node;
	}
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
	withActorScope: async (_actor: unknown, fn: (tx: unknown) => unknown) =>
		fn({ ...noWrites, select: () => chain(() => h.scopedRows.shift() ?? []) }),
}));
vi.mock("@/app/server/actions/projects", () => ({
	getProjectEnvironments: h.getProjectEnvironments,
	getEnvConsistency: h.getEnvConsistency,
	getProjectAsFormData: h.getProjectAsFormData,
}));
vi.mock("@/app/server/actions/reconcile", () => ({ getEnvReconcileStates: h.getEnvReconcileStates }));
vi.mock("@/lib/promotions/diff", () => ({ diffDesigns: h.diffDesigns }));
vi.mock("@/lib/promotions/lifecycle", () => ({
	IN_FLIGHT: ["PENDING_PLAN", "PENDING_APPROVAL", "APPROVED", "DEPLOYING"],
}));

import { ForbiddenError } from "@/lib/authz/types";
import { environmentsRouter } from "@/lib/rpc/procedures/environments";

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
	h.can.clear();
	h.asked.length = 0;
	h.authorizeRead.mockResolvedValue(ACTOR);
	h.getProjectEnvironments.mockResolvedValue({ environments: [] });
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
		expect(h.getProjectEnvironments).not.toHaveBeenCalled();
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});

	it("answers the page for the resolved project; a failed enrichment degrades, the list does not", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getProjectEnvironments.mockResolvedValue({
			environments: [
				{ id: ENV_A, name: "dev", stage: "development", is_default: true, updated_at: new Date("2026-10-01T00:00:00Z") },
			],
		});
		h.getEnvConsistency.mockRejectedValue(new Error("a deleted cloud identity"));
		h.scopedRows.push([], []); // no promotion in flight, no protection rules
		const out = await client.overview({ project: "payments" });
		expect(out).toMatchObject({
			projectId: PROJECT,
			envs: [{ id: ENV_A, name: "dev", updated_at: "2026-10-01T00:00:00.000Z" }],
			consistency: { envs: [{ id: ENV_A, name: "dev", stage: "development" }], rows: [] },
			activePromotion: null,
			protectionByEnv: {},
		});
		// The history is its own keyset read now; the overview carries neither it nor a list page.
		expect(out).not.toHaveProperty("promotions");
		expect(out).not.toHaveProperty("page");
		expect(h.getProjectEnvironments).toHaveBeenCalledWith(PROJECT);
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
		h.scopedRows.push(new Error("promotions read failed"), []);
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});

	it("a failed protection read fails the page — it never reads as 'no protection'", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.scopedRows.push([], new Error("protection read failed"));
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});

	it("a failure of the environment list itself is a failure — not an empty page", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getProjectEnvironments.mockRejectedValue(new Error("database down"));
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
		expect(h.getProjectEnvironments).not.toHaveBeenCalled();
	});

	it("the filters narrow the rows, not the facets; newest first; no count", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getProjectEnvironments.mockResolvedValue({ environments: ENVS });
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
		h.getProjectEnvironments.mockResolvedValue({ environments: ENVS });
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
