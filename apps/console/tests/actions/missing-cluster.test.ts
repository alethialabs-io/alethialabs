// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6736: "Mark as destroyed" (app/server/actions/missing-cluster.ts) is a person's ruling on a cluster
// found deleted outside Alethia. It takes the environment destroy's permission, RE-DERIVES the
// observation and refuses unless it is still `missing`, refuses while a job is in flight, and on
// success writes the environment and its cluster rows DESTROYED — no job, no cloud call — then
// records who decided it and on what evidence.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/authz/types";

const m = vi.hoisted(() => ({
	authorizeDeferred: vi.fn(),
	readEnvironmentObservation: vi.fn(),
	transitionEnv: vi.fn(),
	recordActivity: vi.fn(),
	emitActionEvent: vi.fn(),
	updates: [] as { table: unknown; set: unknown }[],
	tables: {
		projectEnvironments: { name: "project_environments", id: "id" },
		projectCluster: { name: "project_cluster", project_id: "project_id", environment_id: "environment_id" },
	},
}));

vi.mock("@/lib/authz/guard", () => ({ authorizeDeferred: m.authorizeDeferred }));
vi.mock("@/lib/clusters/missing", () => ({
	readEnvironmentObservation: m.readEnvironmentObservation,
	environmentLabel: (e: { projectName: string; environmentName: string }) => `${e.projectName} / ${e.environmentName}`,
}));
vi.mock("@/lib/db/env-status", () => ({ transitionEnv: m.transitionEnv }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: m.recordActivity }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: m.emitActionEvent }));
vi.mock("@/lib/db/schema", () => ({
	projectEnvironments: m.tables.projectEnvironments,
	projectCluster: m.tables.projectCluster,
}));
vi.mock("@/lib/db", () => ({
	withActorScope: async (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => {
		const tx = {
			update: (table: unknown) => ({
				set: (set: unknown) => ({
					where: () => {
						m.updates.push({ table, set });
						return Promise.resolve();
					},
				}),
			}),
		};
		return fn(tx);
	},
}));

import { markEnvironmentDestroyedAction } from "@/app/server/actions/missing-cluster";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const ACTOR = { userId: "user-1", orgId: "org-1", credential: "session" };
const SCANNED = "2026-11-09T00:00:00.000Z";

/** The environment as the action re-reads it, with `observation`. */
function observed(observation: unknown, projectId = PROJECT) {
	return {
		environmentId: ENV,
		environmentName: "production",
		projectId,
		projectName: "shop",
		status: "ACTIVE",
		observation,
	};
}

const MISSING = { kind: "missing", source: "drift", observedAt: SCANNED, deleted: ["aws_eks_cluster.main"] };

beforeEach(() => {
	vi.clearAllMocks();
	m.updates = [];
	m.authorizeDeferred.mockResolvedValue(ACTOR);
	m.transitionEnv.mockResolvedValue(true);
});

describe("markEnvironmentDestroyedAction", () => {
	it("asks the environment destroy's permission on the project", async () => {
		m.readEnvironmentObservation.mockResolvedValue(observed(MISSING));
		await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });
		expect(m.authorizeDeferred).toHaveBeenCalledWith("destroy", { type: "project", id: PROJECT });
		expect(m.readEnvironmentObservation).toHaveBeenCalledWith("org-1", ENV);
	});

	it("marks the environment and its cluster rows DESTROYED, and records the actor and the evidence", async () => {
		m.readEnvironmentObservation.mockResolvedValue(observed(MISSING));

		const result = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });

		expect(result).toEqual({ ok: true, data: { environmentId: ENV } });
		expect(m.transitionEnv).toHaveBeenCalledWith(expect.anything(), ENV, "markDestroyed", null, {
			orgId: "org-1",
			projectId: PROJECT,
			silent: true,
		});
		expect(m.updates.map((u) => u.table)).toEqual([m.tables.projectEnvironments, m.tables.projectCluster]);
		expect(m.updates[1]?.set).toMatchObject({ status: "DESTROYED" });
		expect(m.recordActivity).toHaveBeenCalledWith(
			ACTOR,
			"mark_destroyed",
			{ type: "environment", id: ENV },
			{
				resourceName: "shop / production",
				reason: `Recorded as destroyed without a cloud call. Evidence: Drift scan at ${SCANNED} found deleted: aws_eks_cluster.main`,
			},
		);
		expect(m.emitActionEvent).toHaveBeenCalledWith(ACTOR, "destroy", { type: "project", id: PROJECT }, true);
	});

	it.each([
		["reported", { kind: "reported", observedAt: SCANNED, source: "probe", fresh: true }],
		["unreachable", { kind: "unreachable", observedAt: SCANNED, message: "timeout" }],
	])("refuses when the cluster is %s, not missing — and writes nothing", async (_, observation) => {
		m.readEnvironmentObservation.mockResolvedValue(observed(observation));

		const result = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("conflict");
			expect("message" in result.error ? result.error.message : "").toMatch(/no longer shows this cluster missing/);
		}
		expect(m.transitionEnv).not.toHaveBeenCalled();
		expect(m.updates).toEqual([]);
		expect(m.recordActivity).not.toHaveBeenCalled();
	});

	it("refuses while a job is in flight: the CAS did not move, so neither the cluster nor the log is written", async () => {
		m.readEnvironmentObservation.mockResolvedValue(observed(MISSING));
		m.transitionEnv.mockResolvedValue(false);

		const result = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
		expect(m.updates).toEqual([]);
		expect(m.recordActivity).not.toHaveBeenCalled();
	});

	it("is not-found for an environment of another project, or not in the actor's org", async () => {
		m.readEnvironmentObservation.mockResolvedValue(observed(MISSING, "33333333-3333-4333-8333-333333333333"));
		const other = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });
		expect(other.ok ? null : other.error.kind).toBe("not-found");

		m.readEnvironmentObservation.mockResolvedValue(null);
		const foreign = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });
		expect(foreign.ok ? null : foreign.error.kind).toBe("not-found");
		expect(m.transitionEnv).not.toHaveBeenCalled();
	});

	it("a denied permission is forbidden, and nothing is read", async () => {
		m.authorizeDeferred.mockRejectedValue(new ForbiddenError("destroy", { type: "project", id: PROJECT }, "no grant"));
		const result = await markEnvironmentDestroyedAction({ projectId: PROJECT, environmentId: ENV });
		expect(result.ok ? null : result.error.kind).toBe("forbidden");
		expect(m.readEnvironmentObservation).not.toHaveBeenCalled();
	});

	it("rejects input that is not a project and an environment id before anything runs", async () => {
		const result = await markEnvironmentDestroyedAction({ projectId: "nope", environmentId: ENV });
		expect(result.ok ? null : result.error.kind).toBe("validation");
		expect(m.authorizeDeferred).not.toHaveBeenCalled();
	});
});
