// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stale-job recovery + offline-runner sweep loop (lib/jobs/recovery.ts). It's a setInterval host,
// so we capture the registered tick via a stubbed setInterval and invoke it directly — asserting
// the idempotency/DB-URL guards and the sweep→alert fan-out (one alert per swept runner, skipping
// runners with no org). The SQL bodies themselves are Postgres functions (integration territory).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));

import { startStaleJobRecovery } from "@/lib/jobs/recovery";
import { getServiceDb } from "@/lib/db";
import { emitAlertEventSafe } from "@/lib/alerts/emit";

const G = globalThis as unknown as { __alethiaJobRecovery?: unknown };
const ORIGINAL_URL = process.env.ALETHIA_DATABASE_URL;

/** Replace setInterval so we can capture the tick callback without real timers. */
let tick: (() => void) | null;
let intervalCalls: number;
beforeEach(() => {
	vi.clearAllMocks();
	delete G.__alethiaJobRecovery; // reset the module's idempotency latch
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

describe("startStaleJobRecovery — guards", () => {
	it("registers exactly one interval and is idempotent across calls", () => {
		startStaleJobRecovery();
		startStaleJobRecovery();
		expect(intervalCalls).toBe(1);
	});

	it("does nothing without a database URL configured", () => {
		delete process.env.ALETHIA_DATABASE_URL;
		startStaleJobRecovery();
		expect(intervalCalls).toBe(0);
	});
});

describe("startStaleJobRecovery — tick body", () => {
	it("runs the recovery SQL and emits an alert per swept runner (skipping org-less rows)", async () => {
		const execute = vi
			.fn()
			// recover / gc-pending resolve to nothing; sweep resolves rows.
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ runner_id: "r1", org_id: "o1", runner_name: "alpha" },
				{ runner_id: "r2", org_id: null, runner_name: "orphan" }, // skipped (no org)
			]);
		vi.mocked(getServiceDb).mockReturnValue({ execute } as never);

		startStaleJobRecovery();
		expect(tick).toBeTypeOf("function");
		tick!();
		await new Promise((r) => setTimeout(r, 0)); // flush the void promises

		expect(execute).toHaveBeenCalledTimes(3); // recover + gc + sweep (connection tests are server-side now)
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1); // only the org-bearing runner
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"o1",
			"system.runner.offline",
			expect.objectContaining({ resource_type: "runner", resource_id: "r1", severity: "warning" }),
		);
	});
});
