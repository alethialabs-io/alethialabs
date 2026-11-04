// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the managed-fleet server actions. We stub the auth guard + PDP, a
// thenable drizzle chain (so `await db.select()…orderBy()` / `.returning()` resolve to seeded
// rows), the fleet queue/usage reads, and the scaler/revalidate side effects — but keep the
// deployment-mode flag (env), the cost model, and the zod validators REAL so the derived
// pool-view / economics math and the self-managed gating are genuinely exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/fleet/queue", () => ({
	latestReleaseVersion: vi.fn(),
	managedRunnerRowsForProvider: vi.fn(),
}));
vi.mock("@/lib/queries/runner-usage", () => ({
	provisionedHoursByProvider: vi.fn(),
	jobMinutesByProvider: vi.fn(),
}));
vi.mock("@/lib/fleet/scaler", () => ({ wakeFleetScaler: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	createFleetPool,
	createFleetPoolAction,
	deleteFleetPool,
	deleteFleetPoolAction,
	setFleetPoolEnabled,
	setFleetPoolEnabledAction,
	updateFleetPool,
} from "@/app/server/actions/fleet";
import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	latestReleaseVersion,
	managedRunnerRowsForProvider,
} from "@/lib/fleet/queue";
import {
	jobMinutesByProvider,
	provisionedHoursByProvider,
} from "@/lib/queries/runner-usage";
import { hourlyRateEur } from "@/lib/fleet/costs";
import { wakeFleetScaler } from "@/lib/fleet/scaler";
import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/authz/types";

const POOL = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

/** A drizzle-ish chain: every builder returns the chain, it awaits to `rows`, `.returning()`
 *  resolves to `rows`, and `.set()` / `.values()` are captured. */
function mockDb(rows: unknown[]) {
	const setSpy = vi.fn();
	const valuesSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		insert: () => db,
		update: () => db,
		delete: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		returning: () => Promise.resolve(rows),
		then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
			Promise.resolve(rows).then(resolve, reject),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy, valuesSpy };
}

/** Stub the non-throwing capability probe used to gate the manage-UI. */
function mockPdp(allowed: boolean) {
	const can = vi.fn().mockResolvedValue({ allowed });
	vi.mocked(getPdp).mockReturnValue({ can } as never);
	return can;
}

const ENV_KEYS = [
	"ALETHIA_DEPLOYMENT_MODE",
	"FLEET_PROVIDER",
	"HCLOUD_SERVER_TYPE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	// Default to the only deployment where the managed fleet is operable.
	process.env.ALETHIA_DEPLOYMENT_MODE = "self-managed";
	delete process.env.FLEET_PROVIDER;
	delete process.env.HCLOUD_SERVER_TYPE;
	vi.mocked(authorize).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("createFleetPool", () => {
	it("validates input, inserts the mapped row, wakes the scaler, and revalidates", async () => {
		const created = { id: "new", provider: "aws" };
		const { valuesSpy } = mockDb([created]);
		const r = await createFleetPool({
			provider: "aws",
			name: "Prod AWS",
			warmMin: 2,
			max: 8,
			slotsPerRunner: 2,
			locations: ["fsn1", "nbg1"],
			minPerLocation: 1,
			surge: 2,
			buffer: 1,
			scaleDownGraceTicks: 5,
			version: "1.2.0",
		} as never);

		expect(authorize).toHaveBeenCalledWith("create", { type: "fleet" });
		expect(r).toEqual(created);
		// camelCase input → snake_case insert columns; a pinned version clears the channel.
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "aws",
				name: "Prod AWS",
				warm_min: 2,
				max: 8,
				slots_per_runner: 2,
				locations: ["fsn1", "nbg1"],
				version: "1.2.0",
				channel: null,
			}),
		);
		expect(wakeFleetScaler).toHaveBeenCalledTimes(1);
		expect(revalidatePath).toHaveBeenCalledWith("/[org]/~/runners", "page");
	});

	it("rejects invalid input before touching the DB", async () => {
		mockDb([]);
		await expect(
			createFleetPool({ provider: "not-a-cloud" } as never),
		).rejects.toThrow();
		expect(getServiceDb).not.toHaveBeenCalled();
		expect(wakeFleetScaler).not.toHaveBeenCalled();
	});

	it("throws on a hosted deployment without authorizing", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		await expect(createFleetPool({ provider: "aws" } as never)).rejects.toThrow(/not available/);
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe("updateFleetPool", () => {
	it("builds a partial patch (mapping fields, clearing channel on a version pin)", async () => {
		const updated = { id: "p1", provider: "aws" };
		const { setSpy } = mockDb([updated]);
		const r = await updateFleetPool("p1", { warmMin: 5, version: "1.3.0" } as never);

		expect(authorize).toHaveBeenCalledWith("edit", { type: "fleet", id: "p1" });
		expect(r).toEqual(updated);
		const patch = setSpy.mock.calls[0][0];
		expect(patch.warm_min).toBe(5);
		expect(patch.version).toBe("1.3.0");
		expect(patch.channel).toBeNull(); // version pin clears the channel
		expect(patch.updated_at).toBeInstanceOf(Date);
		// The schema's defaults still fill unspecified fields on a partial update, so `max`
		// lands at its default rather than staying undefined.
		expect(patch.max).toBe(10);
		expect(wakeFleetScaler).toHaveBeenCalledTimes(1);
	});
});

describe("setFleetPoolEnabled", () => {
	it("pauses a pool and converges the controller", async () => {
		const row = { id: "p1", enabled: false };
		const { setSpy } = mockDb([row]);
		const r = await setFleetPoolEnabled("p1", false);

		expect(authorize).toHaveBeenCalledWith("edit", { type: "fleet", id: "p1" });
		expect(r).toEqual(row);
		const patch = setSpy.mock.calls[0][0];
		expect(patch.enabled).toBe(false);
		expect(patch.updated_at).toBeInstanceOf(Date);
		expect(wakeFleetScaler).toHaveBeenCalledTimes(1);
		expect(revalidatePath).toHaveBeenCalledWith("/[org]/~/runners", "page");
	});
});

describe("deleteFleetPool", () => {
	it("SOFT-deletes (deleting=true, paused) so the controller drains first, wakes the scaler", async () => {
		const { setSpy } = mockDb([]);
		const r = await deleteFleetPool("p1");
		expect(authorize).toHaveBeenCalledWith("destroy", { type: "fleet", id: "p1" });
		expect(r).toEqual({ success: true });
		// It must be a soft-delete UPDATE (deleting=true + enabled=false), NOT a hard row delete —
		// a hard delete would orphan the pool's VMs + leave their usage sessions billing forever.
		const patch = setSpy.mock.calls[0][0];
		expect(patch.deleting).toBe(true);
		expect(patch.enabled).toBe(false);
		expect(patch.updated_at).toBeInstanceOf(Date);
		expect(wakeFleetScaler).toHaveBeenCalledTimes(1);
		expect(revalidatePath).toHaveBeenCalledWith("/[org]/~/runners", "page");
	});

	it("throws on a hosted deployment", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		await expect(deleteFleetPool("p1")).rejects.toThrow(/not available/);
		expect(wakeFleetScaler).not.toHaveBeenCalled();
	});
});

describe("the mutation contract (defineAction wrappers, #6123)", () => {
	it("a valid create runs createFleetPool and answers ok", async () => {
		mockDb([{ id: "p1" }]);
		const res = await createFleetPoolAction({ provider: "aws", warmMin: 1, max: 3, locations: ["fsn1"] });
		expect(res).toMatchObject({ ok: true, data: { id: "p1" } });
		expect(authorize).toHaveBeenCalledWith("create", { type: "fleet" });
	});

	it("an invalid create is a validation result keyed by field, before any write", async () => {
		const { valuesSpy } = mockDb([]);
		const res = await createFleetPoolAction({ provider: "aws", warmMin: -1, max: 3, locations: ["fsn1"] });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.kind).toBe("validation");
			if (res.error.kind === "validation") expect(Object.keys(res.error.fields)).toContain("warmMin");
		}
		expect(valuesSpy).not.toHaveBeenCalled();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("a PDP denial is a forbidden result, not a thrown error", async () => {
		mockDb([]);
		vi.mocked(authorize).mockRejectedValueOnce(new ForbiddenError("edit", { type: "fleet", id: POOL }));
		const res = await setFleetPoolEnabledAction({ id: POOL, enabled: false });
		expect(res).toEqual({ ok: false, error: { kind: "forbidden", message: expect.any(String) } });
	});

	it("refuses a pool id that is not a uuid before authorizing", async () => {
		const res = await deleteFleetPoolAction({ id: "not-a-uuid" });
		expect(res.ok).toBe(false);
		expect(authorize).not.toHaveBeenCalled();
	});
});
