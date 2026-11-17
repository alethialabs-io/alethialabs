// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6831: what `canvas.environmentStatus` says about deploying. Two answers are pinned: the deploy
// state (never, ahead, in sync) read from the environment's deployed fingerprint and the saved
// design's, and the refusal for a project whose cloud account is on a cloud this deployment does not
// offer. The refusal is asked through the real `assertProjectCloudOffered` and the real offered set,
// so this read and that check cannot give two answers.
//
// Only the database, the actor and the reads this test is not about are stubbed. The environment has
// no component, job, drift, probe or module row: every select but the environment's answers nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted<{
	selects: number;
	deployedHash: string | null;
	designHash: string | Error;
	accountCloud: string | null;
	tables: { projects: unknown; cloudIdentities: unknown };
}>(() => ({
	selects: 0,
	deployedHash: null,
	designHash: "design-1",
	accountCloud: "aws",
	tables: { projects: null, cloudIdentities: null },
}));

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
	currentActor: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(async () => "env-1"),
}));
vi.mock("@/app/server/actions/cost", () => ({ getLatestEnvironmentCost: vi.fn(async () => null) }));
vi.mock("@/lib/gitops/deploy-status", () => ({ readGitopsDeployStatus: vi.fn(async () => null) }));
vi.mock("@/app/server/actions/projects", () => ({
	getProjectAsFormData: vi.fn(async () => {
		if (h.designHash instanceof Error) throw h.designHash;
		return { formData: { hash: h.designHash }, provider: "aws" };
	}),
}));
// The fingerprint itself is lib/promotions' and has its own tests; here it is the design's marker.
vi.mock("@/lib/promotions/diff", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/promotions/diff")>()),
	structuralHash: (design: { hash: string }) => design.hash,
}));
vi.mock("@/lib/db", () => {
	/** A chain answering `rows` wherever it is awaited. */
	const chainOf = (rowsOf: (table: unknown) => unknown[]) => {
		let rows: unknown[] = [];
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			from: (table: unknown) => {
				rows = rowsOf(table);
				return db;
			},
			innerJoin: () => db,
			where: () => db,
			orderBy: () => db,
			limit: () => db,
			then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
				Promise.resolve(rows).then(resolve, reject),
		});
		return db;
	};
	return {
		// The first select is the environment's row; nothing else exists in this environment.
		getServiceDb: () => ({
			select: () => {
				const first = h.selects++ === 0;
				return chainOf(() =>
					first
						? [
								{
									id: "env-1",
									name: "production",
									stage: "production",
									status: "ACTIVE",
									deployed_config_hash: h.deployedHash,
								},
							]
						: [],
				);
			},
		}),
		// The scope the cloud check runs in: it reads the project's account, then that account's cloud.
		withActorScope: vi.fn(async (_actor: unknown, fn: (tx: unknown) => unknown) =>
			fn({
				select: () =>
					chainOf((table) => {
						if (table === h.tables.projects) return [{ cloud_identity_id: h.accountCloud ? "ci-1" : null }];
						if (table === h.tables.cloudIdentities) return h.accountCloud ? [{ provider: h.accountCloud }] : [];
						return [];
					}),
			}),
		),
		withScope: vi.fn(),
	};
});

import { withHiddenClouds } from "@/lib/cloud-providers/availability";
import { cloudIdentities, projects } from "@/lib/db/schema";
import { readEnvironmentStatus } from "@/lib/rpc/procedures/canvas";

beforeEach(() => {
	h.selects = 0;
	h.deployedHash = null;
	h.designHash = "design-1";
	h.accountCloud = "aws";
	h.tables = { projects, cloudIdentities };
});

describe("readEnvironmentStatus — deployState", () => {
	it("an environment with no deployed fingerprint was never deployed", async () => {
		const status = await readEnvironmentStatus("p1", null);
		expect(status.environment?.id).toBe("env-1");
		expect(status.deployState).toBe("never");
		expect(status.updatePending).toBe(false);
	});

	it("a saved design that differs from the deployed one is ahead, and updatePending says the same", async () => {
		h.deployedHash = "design-0";
		const status = await readEnvironmentStatus("p1", null);
		expect(status.deployState).toBe("ahead");
		expect(status.updatePending).toBe(true);
	});

	it("a saved design equal to the deployed one is in sync", async () => {
		h.deployedHash = "design-1";
		const status = await readEnvironmentStatus("p1", null);
		expect(status.deployState).toBe("in-sync");
		expect(status.updatePending).toBe(false);
	});

	it("a deployed environment whose design cannot be read is in sync, and the read still answers", async () => {
		h.deployedHash = "design-0";
		h.designHash = new Error("Cloud identity not found");
		const status = await readEnvironmentStatus("p1", null);
		expect(status.deployState).toBe("in-sync");
		expect(status.updatePending).toBe(false);
	});
});

describe("readEnvironmentStatus — deployRefusal", () => {
	it("a project on an offered cloud is not refused", async () => {
		expect((await readEnvironmentStatus("p1", null)).deployRefusal).toBeNull();
	});

	it("a project on a cloud this deployment does not offer is refused, whatever its deploy state", async () => {
		h.accountCloud = "alibaba";
		h.deployedHash = "design-0";
		const status = await readEnvironmentStatus("p1", null);
		expect(status.deployRefusal).toEqual({
			reason: "cloud-not-offered",
			message: expect.stringContaining("is not available in this release."),
		});
		// The refusal is beside the state, not in place of it.
		expect(status.deployState).toBe("ahead");
	});

	it("the same project is not refused once the operator setting offers that cloud", async () => {
		h.accountCloud = "alibaba";
		const status = await withHiddenClouds(["alibaba"], () => readEnvironmentStatus("p1", null));
		expect(status.deployRefusal).toBeNull();
	});

	it("a project with no cloud account is not refused: there is no cloud to refuse", async () => {
		h.accountCloud = null;
		expect((await readEnvironmentStatus("p1", null)).deployRefusal).toBeNull();
	});
});
