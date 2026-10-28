// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The destroy tree (#5249, #5261), read over GET as `canvas.destroyTree` (#6119; it was the
// `getDestroyTree` server action). What matters: tenants first and the owner last, the owner waiting
// on each tenant by name and status; a non-dedicated environment's tree is itself alone; a NAMED
// environment is read exactly (never the project's default in its place); the row is bound to the
// actor's org, not only to what the PDP answered; and an environment that does not resolve is a typed
// not-found, never another tenant's tree. Tenancy against real Postgres is
// tests/integration/rpc-tenancy.shared.ts (`canvas.destroyTree`).

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/queries/destroy-tree", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/queries/destroy-tree")>()),
	readLiveFabricTenants: vi.fn(async () => []),
}));

import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { ActionRefusal } from "@/lib/actions/result";
import { type DestroyTreeSubject, readLiveFabricTenants } from "@/lib/queries/destroy-tree";
import { readDestroyTree } from "@/lib/rpc/procedures/canvas";

/** The where clause the environment read was filtered by, rendered with its bound parameters. */
let where: { sql: string; params: unknown[] } | null = null;

/** Serves `rows` as the environment read, recording its where clause. */
function mockEnvironmentRead(rows: DestroyTreeSubject[]) {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		from: () => chain,
		innerJoin: () => chain,
		where: (clause: SQL) => {
			where = new PgDialect().sqlToQuery(clause);
			return chain;
		},
		limit: () => Promise.resolve(rows),
	});
	vi.mocked(withActorScope).mockImplementation(async (_actor, fn) =>
		fn({ select: () => chain } as never),
	);
}

const env = (
	id: string,
	name: string,
	placement_mode: DestroyTreeSubject["placement_mode"],
	status: DestroyTreeSubject["status"],
): DestroyTreeSubject => ({ id, name, project_id: "p1", fabric_id: "fab-1", placement_mode, status });

beforeEach(() => {
	vi.clearAllMocks();
	where = null;
	vi.mocked(readLiveFabricTenants).mockImplementation(async () => []);
});

describe("readDestroyTree (canvas.destroyTree)", () => {
	it("returns the tenants first and the owner last, the owner waiting on each by name and status", async () => {
		mockEnvironmentRead([env("env-prod", "prod", "dedicated", "QUEUED")]);
		vi.mocked(readLiveFabricTenants).mockImplementation(async () => [
			env("env-staging", "staging", "vcluster", "ACTIVE"),
			env("env-dev1", "dev-1", "namespace", "FAILED"),
		]);

		const { environmentId, tree } = await readDestroyTree("p1", "env-prod");

		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "p1" });
		expect(environmentId).toBe("env-prod");
		expect(tree.map((n) => n.name)).toEqual(["dev-1", "staging", "prod"]);
		expect(tree[2]).toEqual({
			environment_id: "env-prod",
			name: "prod",
			placement_mode: "dedicated",
			status: "QUEUED",
			owns_fabric: true,
			// A FAILED tenant is named here — the owner's QUEUED destroy is waiting on it, visibly.
			waiting_on: [
				{ name: "dev-1", status: "FAILED" },
				{ name: "staging", status: "ACTIVE" },
			],
		});
		expect(tree[0]).toMatchObject({ owns_fabric: false, waiting_on: [] });
	});

	it("a non-dedicated environment's tree is itself alone, owning nothing", async () => {
		mockEnvironmentRead([env("env-dev1", "dev-1", "namespace", "ACTIVE")]);

		const { tree } = await readDestroyTree("p1", "env-dev1");

		expect(tree).toEqual([
			{
				environment_id: "env-dev1",
				name: "dev-1",
				placement_mode: "namespace",
				status: "ACTIVE",
				owns_fabric: false,
				waiting_on: [],
			},
		]);
	});

	it("reads a named environment exactly, inside the project AND the actor's org", async () => {
		mockEnvironmentRead([env("env-prod", "prod", "dedicated", "ACTIVE")]);

		await readDestroyTree("p1", "env-prod");

		expect(where?.params).toEqual(expect.arrayContaining(["p1", "org-1", "env-prod"]));
		// Never the default in its place: a named environment is not read by `is_default`.
		expect(where?.sql).not.toMatch(/is_default/);
	});

	it("reads the project's default environment when none is named", async () => {
		mockEnvironmentRead([env("env-prod", "prod", "dedicated", "ACTIVE")]);

		await readDestroyTree("p1", null);

		expect(where?.sql).toMatch(/is_default/);
		expect(where?.params).toEqual(expect.arrayContaining(["p1", "org-1"]));
	});

	it("is a typed not-found when the environment does not resolve for this actor", async () => {
		mockEnvironmentRead([]);

		const read = readDestroyTree("p1", "env-of-another-org");

		await expect(read).rejects.toBeInstanceOf(ActionRefusal);
		await expect(read).rejects.toMatchObject({ kind: "not-found" });
		expect(readLiveFabricTenants).not.toHaveBeenCalled();
	});
});
