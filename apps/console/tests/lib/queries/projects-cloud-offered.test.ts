// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6811: a new project is accepted only on a cloud this deployment offers. The check is in
// insertProjectWithDefaultFabric, the one insert path for a project (the console create, the
// duplicate and `POST /api/cli/projects` all run it), and it reads the cloud from the stored
// account row, before anything is written. `assertProjectCloudOffered` is the same question asked
// of a project that already exists.
//
// The offered set is fixed here by decision (2026-11-17): AWS, GCP, Azure and Hetzner are offered;
// Alibaba, DigitalOcean and Civo are not. The same refusals against real Postgres are in
// tests/integration/cloud-availability/.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
vi.mock("@/lib/projects/placement-namespace-claim", () => ({
	claimPlacementNamespace: vi.fn(async () => null),
}));

import { CloudNotOfferedError, withHiddenClouds } from "@/lib/cloud-providers/availability";
import type { Tx } from "@/lib/db";
import { cloudIdentities, projectEnvironments, projectFabrics, projects } from "@/lib/db/schema";
import {
	assertProjectCloudOffered,
	insertProjectWithDefaultFabric,
	projectCloudRefusal,
} from "@/lib/queries/projects";

/** What the fake transaction holds, and what it was asked to write. */
interface Store {
	/** The cloud of the one account row the transaction can read; `null` when it can read none. */
	accountCloud: string | null;
	/** The account the one existing project is bound to; `undefined` when there is no project. */
	projectAccount?: string | null;
	/** Every table an insert was issued against, in order. */
	inserts: unknown[];
}

/** The rows a select from `table` answers. */
function selected(store: Store, table: unknown): Record<string, unknown>[] {
	if (table === cloudIdentities) return store.accountCloud === null ? [] : [{ provider: store.accountCloud }];
	if (table === projects) {
		return store.projectAccount === undefined ? [] : [{ cloud_identity_id: store.projectAccount }];
	}
	return [];
}

/** The rows an insert into `table` returns. */
function inserted(table: unknown): Record<string, unknown>[] {
	if (table === projects) return [{ id: "p1", org_id: "o1" }];
	if (table === projectFabrics) return [{ id: "fab-1", name: "production" }];
	if (table === projectEnvironments) return [{ id: "env-1" }, { id: "env-2" }];
	return [];
}

/** A drizzle-ish transaction over `store`: selects answer by table, inserts are recorded. */
function fakeTx(store: Store): Tx {
	const select = () => ({
		from: (table: unknown) => ({ where: () => Promise.resolve(selected(store, table)) }),
	});
	const insert = (table: unknown) => ({
		values: () => {
			store.inserts.push(table);
			const done = Promise.resolve(inserted(table));
			return {
				returning: () => done,
				onConflictDoNothing: () => Object.assign(Promise.resolve([]), { returning: () => done }),
			};
		},
	});
	const tx = { select, insert };
	// The create core only builds selects and inserts; the fake carries exactly those two.
	return tx as unknown as Tx;
}

const base: Parameters<typeof insertProjectWithDefaultFabric>[1] = {
	project_name: "acme",
	region: "eu-central",
	iac_version: "1.0",
	environment_stage: "production",
	cloud_identity_id: "ci-1",
	owner: "u1",
	orgId: "o1",
};

const OFFERED = ["aws", "gcp", "azure", "hetzner"] as const;
const HIDDEN = ["alibaba", "digitalocean", "civo"] as const;

describe("insertProjectWithDefaultFabric — the cloud of a new project", () => {
	it.each(HIDDEN)("refuses an account on %s and writes nothing", async (cloud) => {
		const store: Store = { accountCloud: cloud, inserts: [] };
		await expect(insertProjectWithDefaultFabric(fakeTx(store), base)).rejects.toBeInstanceOf(
			CloudNotOfferedError,
		);
		expect(store.inserts).toEqual([]);
	});

	it("says which cloud, and nothing else", async () => {
		const store: Store = { accountCloud: "alibaba", inserts: [] };
		await expect(insertProjectWithDefaultFabric(fakeTx(store), base)).rejects.toThrow(
			/^Alibaba Cloud is not available in this release\.$/,
		);
	});

	it.each(OFFERED)("creates the project for an account on %s", async (cloud) => {
		const store: Store = { accountCloud: cloud, inserts: [] };
		const created = await insertProjectWithDefaultFabric(fakeTx(store), base);
		expect(created.project.id).toBe("p1");
		expect(store.inserts).toContain(projects);
	});

	it.each(HIDDEN)("creates it on %s once the operator setting names that cloud", async (cloud) => {
		const store: Store = { accountCloud: cloud, inserts: [] };
		const created = await withHiddenClouds([cloud], () =>
			insertProjectWithDefaultFabric(fakeTx(store), base),
		);
		expect(created.project.id).toBe("p1");
	});

	it("re-enabling one cloud leaves the others refused", async () => {
		const store: Store = { accountCloud: "alibaba", inserts: [] };
		await withHiddenClouds(["civo"], () =>
			expect(insertProjectWithDefaultFabric(fakeTx(store), base)).rejects.toBeInstanceOf(
				CloudNotOfferedError,
			),
		);
		expect(store.inserts).toEqual([]);
	});

	it("asks nothing about a project with no account", async () => {
		// The account row would be refused if it were read; a project without one never reads it.
		const store: Store = { accountCloud: "alibaba", inserts: [] };
		const created = await insertProjectWithDefaultFabric(fakeTx(store), {
			...base,
			cloud_identity_id: null,
		});
		expect(created.project.id).toBe("p1");
	});

	it("does not refuse an id that matches no row it can read", async () => {
		// Whether the caller may use an account is asked by each write path before this point.
		const store: Store = { accountCloud: null, inserts: [] };
		const created = await insertProjectWithDefaultFabric(fakeTx(store), base);
		expect(created.project.id).toBe("p1");
	});
});

describe("assertProjectCloudOffered — an existing project", () => {
	it.each(HIDDEN)("refuses a project whose account is on %s", async (cloud) => {
		const store: Store = { accountCloud: cloud, projectAccount: "ci-1", inserts: [] };
		await expect(assertProjectCloudOffered(fakeTx(store), "p1")).rejects.toBeInstanceOf(
			CloudNotOfferedError,
		);
	});

	it.each(OFFERED)("passes a project whose account is on %s", async (cloud) => {
		const store: Store = { accountCloud: cloud, projectAccount: "ci-1", inserts: [] };
		await expect(assertProjectCloudOffered(fakeTx(store), "p1")).resolves.toBeUndefined();
	});

	it("passes it once the operator setting names the cloud", async () => {
		const store: Store = { accountCloud: "alibaba", projectAccount: "ci-1", inserts: [] };
		await expect(
			withHiddenClouds(["alibaba"], () => assertProjectCloudOffered(fakeTx(store), "p1")),
		).resolves.toBeUndefined();
	});

	it("passes a project with no account, and an id that matches no project", async () => {
		const unbound: Store = { accountCloud: "alibaba", projectAccount: null, inserts: [] };
		await expect(assertProjectCloudOffered(fakeTx(unbound), "p1")).resolves.toBeUndefined();
		const missing: Store = { accountCloud: "alibaba", inserts: [] };
		await expect(assertProjectCloudOffered(fakeTx(missing), "nope")).resolves.toBeUndefined();
	});

	it("writes nothing", async () => {
		const store: Store = { accountCloud: "aws", projectAccount: "ci-1", inserts: [] };
		await assertProjectCloudOffered(fakeTx(store), "p1");
		expect(store.inserts).toEqual([]);
	});
});

// #6964: the same question for the service-role paths that skip or block rather than throw.
describe("projectCloudRefusal — the refusal as a value", () => {
	it("returns the refusal for a project on a cloud that is not offered", async () => {
		const store: Store = { accountCloud: "alibaba", projectAccount: "ci-1", inserts: [] };
		const refusal = await projectCloudRefusal(fakeTx(store), "p1");
		expect(refusal).toBeInstanceOf(CloudNotOfferedError);
		expect(refusal?.slug).toBe("alibaba");
	});

	it("returns null for a project on an offered cloud", async () => {
		const store: Store = { accountCloud: "aws", projectAccount: "ci-1", inserts: [] };
		await expect(projectCloudRefusal(fakeTx(store), "p1")).resolves.toBeNull();
	});

	it("rethrows a failure that is not the refusal", async () => {
		const broken = {
			select: () => ({ from: () => ({ where: () => Promise.reject(new Error("connection reset")) }) }),
		};
		await expect(projectCloudRefusal(broken as unknown as Tx, "p1")).rejects.toThrow("connection reset");
	});
});
