// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Classification on a project-owned resource asks about the owning project
// (lib/classification/resource-project.ts).
//
// Mocked boundary: the service-role lookup (answers per table from a script, ignoring `.where`) and the
// per-project question (`cliMayActOnProject` / `cliViewableProjectIds`). What the lookup's org predicate
// does against real Postgres, and the real PDP's answers, are tests/integration/console-project-bound.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
	const tables: unknown[] = [];
	return { rows: new Map<unknown, unknown[]>(), tables, mayAct: vi.fn(), viewable: vi.fn() };
});
vi.mock("@/lib/db", () => ({
	getServiceDb: () => {
		let table: unknown;
		const chain = {
			select: () => chain,
			from: (t: unknown) => {
				table = t;
				h.tables.push(t);
				return chain;
			},
			innerJoin: () => chain,
			where: async () => h.rows.get(table) ?? [],
		};
		return chain;
	},
}));
vi.mock("@/lib/cli/project-access", () => ({
	cliMayActOnProject: h.mayAct,
	cliViewableProjectIds: h.viewable,
}));

import type { Actor } from "@/lib/authz/types";
import { classifiedIdsViewable, mayClassifyResource } from "@/lib/classification/resource-project";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";

const ACTOR: Actor = { userId: "u1", orgId: "org-1", credential: "session" };
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const ENV = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
	vi.clearAllMocks();
	h.rows.clear();
	h.tables.length = 0;
	h.mayAct.mockResolvedValue(true);
	h.viewable.mockResolvedValue([]);
});

describe("mayClassifyResource", () => {
	it("asks nothing for a kind that does not live in a project", async () => {
		expect(await mayClassifyResource(ACTOR, "runner", P, "edit")).toBe(true);
		expect(h.tables).toEqual([]);
		expect(h.mayAct).not.toHaveBeenCalled();
	});

	it("asks nothing for an id that is not a uuid", async () => {
		expect(await mayClassifyResource(ACTOR, "project", "not-a-uuid", "view")).toBe(true);
		expect(h.tables).toEqual([]);
		expect(h.mayAct).not.toHaveBeenCalled();
	});

	it("leaves a resource not found in the org to the caller's own org check", async () => {
		expect(await mayClassifyResource(ACTOR, "project", P, "view")).toBe(true);
		expect(h.mayAct).not.toHaveBeenCalled();
	});

	it("asks the action about the project itself", async () => {
		h.rows.set(projects, [{ id: P }]);
		h.mayAct.mockResolvedValue(false);
		expect(await mayClassifyResource(ACTOR, "project", P, "edit")).toBe(false);
		expect(h.mayAct).toHaveBeenCalledWith(ACTOR, P, "edit");
	});

	it("asks about the project an environment belongs to", async () => {
		h.rows.set(projectEnvironments, [{ id: ENV, projectId: P }]);
		expect(await mayClassifyResource(ACTOR, "project_environment", ENV, "view")).toBe(true);
		expect(h.mayAct).toHaveBeenCalledWith(ACTOR, P, "view");
	});

	it("asks about the project a cluster belongs to", async () => {
		h.rows.set(projectCluster, [{ id: CLUSTER, projectId: Q }]);
		h.mayAct.mockResolvedValue(false);
		expect(await mayClassifyResource(ACTOR, "project_cluster", CLUSTER, "edit")).toBe(false);
		expect(h.mayAct).toHaveBeenCalledWith(ACTOR, Q, "edit");
	});
});

describe("classifiedIdsViewable", () => {
	it("passes a kind that does not live in a project through untouched", async () => {
		expect(await classifiedIdsViewable(ACTOR, "runner", [P, Q])).toEqual([P, Q]);
		expect(h.viewable).not.toHaveBeenCalled();
	});

	it("passes an empty list through", async () => {
		expect(await classifiedIdsViewable(ACTOR, "project", [])).toEqual([]);
		expect(h.tables).toEqual([]);
	});

	it("passes ids with no project in the org through without asking the PDP", async () => {
		expect(await classifiedIdsViewable(ACTOR, "project", [P, OTHER])).toEqual([P, OTHER]);
		expect(h.viewable).not.toHaveBeenCalled();
	});

	it("leaves out the ids whose project the caller may not view, keeping order and the rest", async () => {
		h.rows.set(projectEnvironments, [
			{ id: ENV, projectId: P },
			{ id: OTHER, projectId: Q },
		]);
		h.viewable.mockResolvedValue([Q]);
		expect(await classifiedIdsViewable(ACTOR, "project_environment", [ENV, CLUSTER, OTHER])).toEqual([
			CLUSTER,
			OTHER,
		]);
		expect(h.viewable).toHaveBeenCalledWith(ACTOR);
		expect(h.mayAct).not.toHaveBeenCalled();
	});
});
