// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fleet controller loop host (lib/fleet/scaler.ts) — a setInterval host like jobs/recovery. Capture
// the registered tick to drive it directly; assert the idempotency/DB-URL guards, that the tick
// reconciles loaded pools, and that wakeFleetScaler only fires once the loop is started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fleet/controller", () => ({ reconcileAll: vi.fn(async () => {}) }));
vi.mock("@/lib/fleet/db-deps", () => ({ makeDbDeps: vi.fn(() => ({ deps: true })) }));
vi.mock("@/lib/fleet/pools-db", () => ({ loadFleetPools: vi.fn(async () => []) }));
vi.mock("@/lib/fleet/provider", () => ({ getFleetProvider: vi.fn(() => ({ provider: true })) }));

import { startFleetScaler, wakeFleetScaler } from "@/lib/fleet/scaler";
import { reconcileAll } from "@/lib/fleet/controller";
import { loadFleetPools } from "@/lib/fleet/pools-db";

const G = globalThis as unknown as { __alethiaFleetScaler?: unknown };
const ORIGINAL_URL = process.env.ALETHIA_DATABASE_URL;

let tick: (() => void) | null;
let intervalCalls: number;
beforeEach(() => {
	vi.clearAllMocks();
	delete G.__alethiaFleetScaler;
	process.env.ALETHIA_DATABASE_URL = "postgres://x";
	tick = null;
	intervalCalls = 0;
	vi.stubGlobal("setInterval", (fn: () => void) => {
		intervalCalls++;
		tick = fn;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (ORIGINAL_URL === undefined) delete process.env.ALETHIA_DATABASE_URL;
	else process.env.ALETHIA_DATABASE_URL = ORIGINAL_URL;
});

describe("startFleetScaler — guards", () => {
	it("registers one interval and is idempotent", () => {
		startFleetScaler();
		startFleetScaler();
		expect(intervalCalls).toBe(1);
	});

	it("does nothing without a database URL", () => {
		delete process.env.ALETHIA_DATABASE_URL;
		startFleetScaler();
		expect(intervalCalls).toBe(0);
	});
});

describe("tick / wakeFleetScaler", () => {
	it("reconciles the loaded pools on each tick", async () => {
		startFleetScaler();
		tick!();
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).toHaveBeenCalledTimes(1);
		expect(reconcileAll).toHaveBeenCalledWith([], { provider: true }, { deps: true }, expect.any(Map));
	});

	it("wakeFleetScaler is a no-op until the loop is started", async () => {
		wakeFleetScaler(); // not started yet
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).not.toHaveBeenCalled();

		startFleetScaler();
		wakeFleetScaler(); // now started → immediate reconcile
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).toHaveBeenCalledTimes(1);
	});
});
