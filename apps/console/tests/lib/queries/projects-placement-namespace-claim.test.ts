// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6575: the create fan-out (insertProjectWithDefaultFabric, which createProject and
// `POST /api/cli/projects` both run) claims every namespace placement's namespace through
// claimPlacementNamespace — the project's namespace lock plus the read of both sides — in its own
// transaction, BEFORE it inserts the placements, and stores none of them when one is refused. The
// claim itself (lock, then reads) is pinned by the CLI environments route test and, against real
// Postgres, by tests/integration/placement-namespace-lock.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	order: new Array<string>(),
	claim: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
vi.mock("@/lib/projects/placement-namespace-claim", () => ({
	claimPlacementNamespace: (...args: unknown[]) => {
		h.order.push("claim");
		return h.claim(...args);
	},
}));

import { projectEnvironments, projectFabrics, projects } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import { type EnvironmentSpec, insertProjectWithDefaultFabric } from "@/lib/queries/projects";

/** The `name` a row to insert carries, "" when it has none. */
function nameOf(row: unknown): string {
	return typeof row === "object" && row !== null && "name" in row ? String(row.name) : "";
}

/** The rows an insert into `table` returns, given the values it was handed. */
function inserted(table: unknown, values: unknown): Record<string, unknown>[] {
	const rows: unknown[] = Array.isArray(values) ? values : [values];
	if (table === projects) return [{ id: "p1", org_id: "o1" }];
	if (table === projectFabrics) return rows.map((r) => ({ id: `fab-${nameOf(r)}`, name: nameOf(r) }));
	if (table === projectEnvironments) {
		return rows.map((r, i) => ({ id: `env-${i}`, name: nameOf(r), is_default: i === 0 }));
	}
	return [];
}

/** A drizzle-ish transaction: SELECTs find nothing, INSERTs record their table and return rows. */
function fakeTx(): Tx {
	const insert = (table: unknown) => ({
		values: (values: unknown) => {
			if (table === projectEnvironments) h.order.push("insert-environments");
			const done = Promise.resolve(inserted(table, values));
			return {
				returning: () => done,
				onConflictDoNothing: () => Object.assign(Promise.resolve([]), { returning: () => done }),
			};
		},
	});
	const select = () => ({ from: () => ({ where: () => Promise.resolve([]) }) });
	const tx = { insert, select };
	// The fan-out only builds inserts and selects; the fake carries exactly those two.
	return tx as unknown as Tx;
}

const base: Parameters<typeof insertProjectWithDefaultFabric>[1] = {
	project_name: "acme",
	region: "eu-central",
	iac_version: "1.0",
	environment_stage: "production",
	owner: "u1",
	orgId: "o1",
};

const matrix: EnvironmentSpec[] = [
	{ name: "production", stage: "production", placement_mode: "dedicated", is_default: true },
	{ name: "dev", stage: "development", placement_mode: "namespace" },
	{ name: "preview", stage: "development", placement_mode: "namespace", namespace: "preview-ns" },
	{ name: "sandbox", stage: "development", placement_mode: "vcluster" },
];

beforeEach(() => {
	h.order.length = 0;
	h.claim.mockReset();
	h.claim.mockResolvedValue(null);
});

describe("insertProjectWithDefaultFabric — namespace claims (#6575)", () => {
	it("claims each namespace placement's effective namespace on its host Fabric, before inserting the placements", async () => {
		await insertProjectWithDefaultFabric(fakeTx(), { ...base, environments: matrix });
		expect(h.claim.mock.calls.map((c) => c.slice(1))).toEqual([
			["p1", "fab-production", "dev"],
			["p1", "fab-production", "preview-ns"],
		]);
		expect(h.order).toEqual(["claim", "claim", "insert-environments"]);
	});

	it("stores no environment when a claim is refused, and throws the refusal", async () => {
		h.claim.mockImplementation(async (...args: unknown[]) => (args[3] === "preview-ns" ? "taken: preview-ns" : null));
		await expect(insertProjectWithDefaultFabric(fakeTx(), { ...base, environments: matrix })).rejects.toThrow(
			"taken: preview-ns",
		);
		expect(h.order).not.toContain("insert-environments");
	});

	it("claims the legacy shape's Preview namespace too", async () => {
		await insertProjectWithDefaultFabric(fakeTx(), base);
		expect(h.claim.mock.calls.map((c) => c.slice(1))).toEqual([["p1", "fab-production", "preview"]]);
		expect(h.order).toEqual(["claim", "insert-environments"]);
	});
});
