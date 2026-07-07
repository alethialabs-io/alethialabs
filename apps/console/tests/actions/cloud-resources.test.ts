// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the cloud-resources action: stub the PDP guard + a thenable drizzle-chain
// tx (passed through withOwnerScope). Asserts the authorize args and the normalized inventory shape
// (networks + subnets + regions) returned by getCloudIdentityInventory. The legacy cached_resources /
// FETCH_RESOURCES helpers were removed (inventory is now server-side), so their tests went with them.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));

import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";

/** A thenable drizzle-ish tx: builders return the chain; awaiting resolves to `rows`. */
function mockTx(rows: unknown[]) {
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		where: () => tx,
		orderBy: () => tx,
		limit: () => tx,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(withOwnerScope).mockImplementation(
		((_userId: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { tx };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1" } as never);
});

describe("getCloudIdentityInventory", () => {
	it("PDP-gates on the cloud_identity and returns networks/subnets/regions", async () => {
		mockTx([{ native_id: "r-1", name: "us-east-1" }]);
		const r = await getCloudIdentityInventory("ci-1");
		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
		// All three selects resolve to the mocked rows; regions projects the name. Networks/subnets get
		// the decrypted `cidr_block` merged on (null here — no `sensitive` blob in the mock row).
		expect(r.networks).toEqual([
			{ native_id: "r-1", name: "us-east-1", cidr_block: null },
		]);
		expect(r.subnets).toEqual([
			{ native_id: "r-1", name: "us-east-1", cidr_block: null },
		]);
		expect(r.regions).toEqual(["us-east-1"]);
	});

	it("propagates the guard rejection (unauthorized)", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("forbidden"));
		mockTx([]);
		await expect(getCloudIdentityInventory("ci-1")).rejects.toThrow(/forbidden/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});
