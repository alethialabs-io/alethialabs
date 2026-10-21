// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the managed-fleet READS, which moved from the fleet server actions to the
// `runners.fleet` procedure (lib/rpc/procedures/runners.ts, #6123). We stub the auth guard + PDP, a
// thenable drizzle chain (so `await db.select()…orderBy()` / `.returning()` resolve to seeded
// rows), the fleet queue/usage reads, and the scaler/revalidate side effects — but keep the
// deployment-mode flag (env), the cost model, and the zod validators REAL so the derived
// pool-view / economics math and the self-managed gating are genuinely exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), authorizeQuiet: vi.fn() }));
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
	readFleetData,
	readFleetEconomicsForManager,
	readFleetEconomics as getFleetEconomics,
	readFleetPoolConfigs as listFleetPoolConfigs,
	readFleetPoolViews as getFleetPoolViews,
} from "@/lib/rpc/procedures/runners";
import { getPdp } from "@/lib/authz";
import { authorize, authorizeQuiet } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
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

describe("getFleetPoolViews", () => {
	it("returns an empty, locked-down overview on hosted deployments (no auth probe)", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		const r = await getFleetPoolViews();
		expect(r).toEqual({ pools: [], fleetProviderActive: false, canManageFleet: false });
		expect(authorize).not.toHaveBeenCalled();
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("reports the provider flag + manage capability when no pools are configured", async () => {
		process.env.FLEET_PROVIDER = "hcloud";
		mockPdp(false);
		mockDb([]); // no pool rows
		const r = await getFleetPoolViews();
		expect(authorize).toHaveBeenCalledWith("view", { type: "runner" });
		expect(r.pools).toEqual([]);
		expect(r.fleetProviderActive).toBe(true);
		expect(r.canManageFleet).toBe(false);
		// No pools → never resolves the release version.
		expect(latestReleaseVersion).not.toHaveBeenCalled();
	});

	it("derives capacity, rollout, version + location health from observed runners", async () => {
		mockPdp(true);
		mockDb([
			{
				id: "p1",
				provider: "aws",
				name: "AWS",
				enabled: true,
				warm_min: 2,
				max: 10,
				slots_per_runner: 1,
				locations: ["fsn1"],
				version: "1.2.0", // pinned → target
				channel: null,
			},
		]);
		vi.mocked(latestReleaseVersion).mockResolvedValue("9.9.9"); // ignored: pin wins
		vi.mocked(managedRunnerRowsForProvider).mockResolvedValue([
			{ status: "online", version: "1.2.0", location: "fsn1", busy: true },
			{ status: "online", version: "1.2.0", location: "fsn1", busy: false },
			{ status: "offline", version: "1.1.0", location: "nbg1", busy: false },
		] as never);

		const r = await getFleetPoolViews();
		expect(managedRunnerRowsForProvider).toHaveBeenCalledWith("aws");
		expect(r.pools).toHaveLength(1);
		const v = r.pools[0];
		expect(v).toMatchObject({
			id: "p1",
			provider: "aws",
			target: 2,
			max: 10,
			targetVersion: "1.2.0",
			online: 2,
			draining: 0,
			offline: 1,
			busy: 1,
			busyOnline: 1,
			locations: ["FSN1"], // uppercased
			rolloutPct: 100,
			fullyRolled: true,
			belowFloor: false, // online(2) ≥ warm_min(2)
			degraded: true, // an offline runner
		});
		// Version tally skips the offline runner; one live version, on target.
		expect(v.versions).toEqual([{ key: "1.2.0", count: 2, flagged: false }]);
		// Location tally includes the offline runner and flags its location.
		expect(v.locDist).toEqual([
			{ key: "fsn1", count: 2, flagged: false },
			{ key: "nbg1", count: 1, flagged: true },
		]);
		expect(r.canManageFleet).toBe(true);
	});

	it("resolves the channel to the latest release and flags below-floor pools", async () => {
		mockPdp(true);
		mockDb([
			{
				id: "p2",
				provider: "gcp",
				name: null,
				enabled: true,
				warm_min: 3,
				max: 5,
				slots_per_runner: 1,
				locations: ["us"],
				version: null,
				channel: "stable", // unpinned → resolves to latest
			},
		]);
		vi.mocked(latestReleaseVersion).mockResolvedValue("2.0.0");
		vi.mocked(managedRunnerRowsForProvider).mockResolvedValue([
			{ status: "online", version: "1.0.0", location: "us", busy: false },
		] as never);

		const v = (await getFleetPoolViews()).pools[0];
		expect(v.targetVersion).toBe("2.0.0");
		expect(v.belowFloor).toBe(true); // online(1) < warm_min(3)
		expect(v.rolloutPct).toBe(0); // the lone live runner is off-target
		expect(v.fullyRolled).toBe(false);
		expect(v.versions).toEqual([{ key: "1.0.0", count: 1, flagged: true }]);
	});
});

describe("listFleetPoolConfigs", () => {
	it("throws on a hosted deployment", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		await expect(listFleetPoolConfigs()).rejects.toThrow(/not available/);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("returns the raw stored rows after a view check", async () => {
		const rows = [{ id: "p1", provider: "aws" }];
		mockDb(rows);
		const r = await listFleetPoolConfigs();
		expect(authorize).toHaveBeenCalledWith("view", { type: "fleet" });
		expect(r).toBe(rows);
	});
});

describe("getFleetEconomics", () => {
	it("joins per-provider hours/minutes into COGS + utilization with totals", async () => {
		process.env.HCLOUD_SERVER_TYPE = "cax21"; // ~€0.0089/h
		mockPdp(true);
		mockDb([
			{ provider: "aws", slots: 1 },
			{ provider: "gcp", slots: 2 },
		]);
		vi.mocked(provisionedHoursByProvider).mockResolvedValue([
			{ provider: "aws", provisioned_hours: 100 },
			{ provider: "gcp", provisioned_hours: 50 },
			{ provider: "any", provisioned_hours: 10 }, // not tied to a pool → totals only
		] as never);
		vi.mocked(jobMinutesByProvider).mockResolvedValue([
			{ provider: "aws", job_minutes: 3000 }, // 100h × 60 × 1 slot = 6000 cap → 50%
			{ provider: "gcp", job_minutes: 600 },
		] as never);

		const r = await getFleetEconomics();
		expect(authorize).toHaveBeenCalledWith("create", { type: "fleet" });
		expect(r.serverType).toBe("cax21");
		// Read from the module, never re-typed. This line WAS `6.49 / 730` — a second copy of the
		// price that went stale independently of the first (#4412), so the two could disagree and
		// only this test would notice, by failing for a reason that looks like a rounding bug.
		const rate = hourlyRateEur("cax21");
		expect(r.hourlyRateEur).toBeCloseTo(rate, 10);

		const aws = r.pools.find((p) => p.provider === "aws")!;
		expect(aws.provisionedHours).toBe(100);
		expect(aws.jobMinutes).toBe(3000);
		expect(aws.estCostEur).toBeCloseTo(100 * rate, 10);
		expect(aws.utilizationPct).toBe(50); // 3000 / (100×60×1)

		const gcp = r.pools.find((p) => p.provider === "gcp")!;
		// 600 / (50×60×2) = 600 / 6000 = 10%
		expect(gcp.utilizationPct).toBe(10);

		// Totals span every provider with usage, incl. the unattributed "any" row.
		expect(r.totals.provisionedHours).toBe(160);
		expect(r.totals.jobMinutes).toBe(3600);
		expect(r.totals.estCostEur).toBeCloseTo(160 * rate, 10);
		// Window starts at the first of the current UTC month.
		expect(new Date(r.window.from).getUTCDate()).toBe(1);
	});

	it("throws on a hosted deployment without authorizing", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		await expect(getFleetEconomics()).rejects.toThrow(/not available/);
		expect(authorize).not.toHaveBeenCalled();
	});
});


describe("readFleetData — the pool cards and the editor's rows", () => {
	it("reads the manager-only configs only for a fleet manager, and never the economics", async () => {
		mockDb([]);
		mockPdp(false);
		const viewer = await readFleetData();
		expect(viewer).toEqual({ pools: [], configs: [], fleetProviderActive: false, canManageFleet: false });
		expect(authorize).not.toHaveBeenCalledWith("create", { type: "fleet" });
	});

	it("is empty and locked down on a hosted deployment, without an auth probe", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		const data = await readFleetData();
		expect(data).toEqual({ pools: [], fleetProviderActive: false, canManageFleet: false, configs: [] });
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe("readFleetEconomicsForManager — its own read, so job hints do not re-run it", () => {
	it("answers null to a non-manager after a QUIET check (no refusal recorded on every page view)", async () => {
		vi.mocked(authorizeQuiet).mockRejectedValueOnce(new ForbiddenError("create", { type: "fleet" }));
		expect(await readFleetEconomicsForManager()).toBeNull();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("answers null on hosted without asking anything", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		expect(await readFleetEconomicsForManager()).toBeNull();
		expect(authorizeQuiet).not.toHaveBeenCalled();
	});

	it("reads the economics for a manager", async () => {
		mockDb([]);
		vi.mocked(authorizeQuiet).mockResolvedValueOnce({ userId: "user-1", orgId: "org-1" } as never);
		vi.mocked(provisionedHoursByProvider).mockResolvedValue([] as never);
		vi.mocked(jobMinutesByProvider).mockResolvedValue([] as never);
		const econ = await readFleetEconomicsForManager();
		expect(econ?.pools).toEqual([]);
		expect(authorize).toHaveBeenCalledWith("create", { type: "fleet" });
	});
});
