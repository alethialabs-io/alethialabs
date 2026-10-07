// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects — the node shape (#5266). Pins the route's half: which bodies it refuses
// before touching the database, and that it hands the shape to `insertCreateTimeClusters` inside the
// create's transaction — and calls nothing at all when no shape was given, which is the "no path ever
// writes a default" rule. The rows themselves are pinned against real Postgres in
// tests/integration/cli-project-create-node-shape.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TX = { tx: true };

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	// Real: the identity lookup asks it which arms the credential gets (#5481).
	userIdIsTheCaller: (await importOriginal<typeof import("@/lib/authz/guard")>())
		.userIdIsTheCaller,
	authorizeCli: vi.fn(async () => ({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
	})),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		// The identity lookup: select().from().where().limit() → one aws identity.
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [{ id: IDENTITY, provider: "aws" }] }) }),
		}),
		transaction: async (fn: (tx: unknown) => unknown) => fn(TX),
	}),
}));
vi.mock("@/lib/queries/projects", () => ({
	insertProjectWithDefaultFabric: vi.fn(async () => ({
		project: {
			id: PROJECT_ID,
			project_name: "shop",
			slug: "shop",
			region: "eu-west-1",
			iac_version: "1.11.4",
			cloud_identity_id: IDENTITY,
			estimated_monthly_cost: null,
			created_at: new Date("2026-01-01T00:00:00.000Z"),
			updated_at: new Date("2026-01-01T00:00:00.000Z"),
		},
	})),
}));
vi.mock("@/lib/cli/create-cluster-shape", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/cli/create-cluster-shape")>();
	return { ...real, insertCreateTimeClusters: vi.fn(async () => 1) };
});

import { POST } from "@/app/api/cli/projects/route";
import { insertCreateTimeClusters, NoDedicatedEnvironmentError } from "@/lib/cli/create-cluster-shape";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";

/** Calls the route as the CLI would. */
function post(body: Record<string, unknown>) {
	return POST(
		new Request("https://console.local/api/cli/projects", {
			method: "POST",
			body: JSON.stringify({ project_name: "shop", region: "eu-west-1", ...body }),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("POST /api/cli/projects — node shape (#5266)", () => {
	it("writes no cluster row when no shape is given — the template default (= catalog default) applies", async () => {
		const res = await post({ cloud_identity_id: IDENTITY });
		expect(res.status).toBe(201);
		expect(insertCreateTimeClusters).not.toHaveBeenCalled();
	});

	it("hands an instance type to the cluster write inside the create's transaction", async () => {
		const res = await post({ cloud_identity_id: IDENTITY, instance_type: "t3.xlarge" });
		expect(res.status).toBe(201);
		expect(insertCreateTimeClusters).toHaveBeenCalledWith(TX, PROJECT_ID, { instance_type: "t3.xlarge" });
	});

	it("hands a node size over unchanged, and needs no cloud account for it", async () => {
		const res = await post({ node_size: { vcpu: 4, memory_gb: 16 } });
		expect(res.status).toBe(201);
		expect(insertCreateTimeClusters).toHaveBeenCalledWith(TX, PROJECT_ID, {
			node_size: { vcpu: 4, memory_gb: 16 },
		});
	});

	it("refuses both at once, naming the rule, before creating anything", async () => {
		const res = await post({
			cloud_identity_id: IDENTITY,
			instance_type: "t3.xlarge",
			node_size: { vcpu: 4, memory_gb: 16 },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/mutually exclusive/);
		expect(insertProjectWithDefaultFabric).not.toHaveBeenCalled();
	});

	it("refuses a machine type with no cloud account — it names one cloud's SKU", async () => {
		const res = await post({ instance_type: "t3.xlarge" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/needs cloud_identity_id/);
		expect(insertProjectWithDefaultFabric).not.toHaveBeenCalled();
	});

	it("refuses a non-positive size", async () => {
		const res = await post({ node_size: { vcpu: 0, memory_gb: 16 } });
		expect(res.status).toBe(400);
		expect(insertProjectWithDefaultFabric).not.toHaveBeenCalled();
	});

	it("maps 'no dedicated environment' to a 400 with its sentence", async () => {
		vi.mocked(insertCreateTimeClusters).mockRejectedValueOnce(new NoDedicatedEnvironmentError());
		const res = await post({ node_size: { vcpu: 4, memory_gb: 16 }, placement_mode: "vcluster" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/no environment is `dedicated`/);
	});
});
