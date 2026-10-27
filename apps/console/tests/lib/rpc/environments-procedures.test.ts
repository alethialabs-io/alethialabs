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
// Pinned: an id-addressed read binds its project to the ADDRESSED org before the PDP is asked — a
// project of another org is a typed NOT_FOUND and the PDP never hears of it (an org-wide grant would
// answer for any id); an environment outside the project is a NOT_FOUND; the overview resolves the
// slug inside the addressed org; a malformed id never reaches the database; and no read writes.

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
	authorizeRead: vi.fn(),
	authorize: vi.fn(),
	/** What each service-role `select … limit()` answers, in call order. */
	serviceRows: [] as unknown[][],
	/** What each actor-scoped select answers, in call order. */
	scopedRows: [] as unknown[][],
	getProjectEnvironments: vi.fn(),
	getEnvConsistency: vi.fn(),
	getProjectAsFormData: vi.fn(),
	getEnvReconcileStates: vi.fn(),
	diffDesigns: vi.fn(),
}));

const ACTOR = { userId: "user-1", orgId: "org-1", credential: "session" as const };

vi.mock("@/lib/authz/guard", () => ({
	authorizeRead: h.authorizeRead,
	authorize: h.authorize,
	currentActor: async () => ACTOR,
}));

/** A chainable select whose terminal (`limit`, or awaiting the chain) answers the next scripted rows. */
function chain(next: () => unknown[]) {
	const node: Record<string, unknown> = {};
	for (const m of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy"]) {
		node[m] = () => node;
	}
	node.limit = async () => next();
	node.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
		Promise.resolve(next()).then(resolve, reject);
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
		await expect(
			client.protectionRules({ projectId: "nope", environmentId: ENV_A }),
		).rejects.toBeInstanceOf(ORPCError);
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
		h.scopedRows.push([], []); // no promotions, no protection rules
		const out = await client.overview({ project: "payments" });
		expect(out).toMatchObject({
			projectId: PROJECT,
			envs: [{ id: ENV_A, name: "dev", updated_at: "2026-10-01T00:00:00.000Z" }],
			consistency: { envs: [{ id: ENV_A, name: "dev", stage: "development" }], rows: [] },
			promotions: [],
			activePromotion: null,
			protectionByEnv: {},
		});
		expect(h.getProjectEnvironments).toHaveBeenCalledWith(PROJECT);
	});

	it("a failure of the environment list itself is a failure — not an empty page", async () => {
		h.serviceRows.push([{ id: PROJECT }]);
		h.getProjectEnvironments.mockRejectedValue(new Error("database down"));
		await expect(client.overview({ project: "payments" })).rejects.toBeTruthy();
	});
});
