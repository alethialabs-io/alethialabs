// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the cloud-resources actions: stub the PDP guard, a thenable
// drizzle-chain tx (passed through withOwnerScope), and the scaler notifier. Assert the
// authorize args, returned shapes, the insert/returning path, the cached-resources persist
// branch (and its no-op branch), and that notifyScaler fires on refresh.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import {
	completeResourceRefresh,
	getCloudIdentityResources,
	refreshCloudResources,
} from "@/app/server/actions/cloud-resources";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import { notifyScaler } from "@/lib/scaler";

/**
 * Builds a thenable drizzle-ish tx whose builders return the chain, terminal
 * `.limit`/`.returning` resolve to `rows`, and wires it through `withOwnerScope`.
 * Records `.values()` payloads and `.execute()` calls.
 */
function mockTx(rows: unknown[]) {
	const valuesSpy = vi.fn<(...a: unknown[]) => void>();
	const executeSpy = vi.fn<(...a: unknown[]) => Promise<unknown>>(() => Promise.resolve());
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		where: () => tx,
		limit: () => tx,
		insert: () => tx,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return tx;
		},
		returning: () => tx,
		execute: (...a: unknown[]) => executeSpy(...a),
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(withOwnerScope).mockImplementation(
		((_userId: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { tx, valuesSpy, executeSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1" } as never);
});

describe("getCloudIdentityResources", () => {
	it("PDP-gates on the cloud_identity and returns the cached resources", async () => {
		mockTx([
			{
				provider: "aws",
				cached_resources: { vpcs: [{ id: "vpc-1" }] },
				cached_at: "2026-01-01T00:00:00.000Z",
			},
		]);
		const r = await getCloudIdentityResources("ci-1");
		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
		expect(r).toEqual({
			provider: "aws",
			resources: { vpcs: [{ id: "vpc-1" }] },
			cachedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("coalesces null cached_resources to null", async () => {
		mockTx([{ provider: "gcp", cached_resources: null, cached_at: null }]);
		const r = await getCloudIdentityResources("ci-2");
		expect(r).toEqual({ provider: "gcp", resources: null, cachedAt: null });
	});

	it("returns an all-null shape when the identity row is missing", async () => {
		mockTx([]);
		const r = await getCloudIdentityResources("ci-missing");
		expect(r).toEqual({ provider: null, resources: null, cachedAt: null });
	});

	it("propagates the guard rejection (unauthorized)", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("forbidden"));
		mockTx([]);
		await expect(getCloudIdentityResources("ci-1")).rejects.toThrow(/forbidden/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("refreshCloudResources", () => {
	it("queues a FETCH_RESOURCES job, notifies the scaler, and returns the job id", async () => {
		const { valuesSpy } = mockTx([{ id: "job-9" }]);
		const r = await refreshCloudResources("ci-1");

		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
		expect(valuesSpy).toHaveBeenCalledWith({
			user_id: "user-1",
			job_type: "FETCH_RESOURCES",
			cloud_identity_id: "ci-1",
			config_snapshot: {},
			status: "QUEUED",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-9" });
	});

	it("does not queue or notify when the guard rejects", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("nope"));
		mockTx([{ id: "job-9" }]);
		await expect(refreshCloudResources("ci-1")).rejects.toThrow(/nope/);
		expect(notifyScaler).not.toHaveBeenCalled();
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("completeResourceRefresh", () => {
	it("persists job-produced cached resources to the identity and returns them", async () => {
		const cached = { vpcs: [{ id: "vpc-7" }], zones: ["a", "b"] };
		const { executeSpy } = mockTx([
			{ execution_metadata: { cached_resources: cached } },
		]);

		const r = await completeResourceRefresh("ci-1", "job-1");

		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(r.success).toBe(true);
		expect(r.resources).toEqual(cached);
		expect(typeof r.cachedAt).toBe("string");
		expect(new Date(r.cachedAt as string).toISOString()).toBe(r.cachedAt);
	});

	it("is a no-op when the job has no cached_resources", async () => {
		const { executeSpy } = mockTx([{ execution_metadata: {} }]);
		const r = await completeResourceRefresh("ci-1", "job-1");
		expect(r).toEqual({ success: false, resources: null, cachedAt: null });
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("is a no-op when the job row is missing", async () => {
		const { executeSpy } = mockTx([]);
		const r = await completeResourceRefresh("ci-1", "job-missing");
		expect(r).toEqual({ success: false, resources: null, cachedAt: null });
		expect(executeSpy).not.toHaveBeenCalled();
	});
});
