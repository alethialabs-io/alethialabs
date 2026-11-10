// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127 (spec-6115 §1.1): the `usage` topic's app-layer producer. At most ONE announcement per org
// per 30 s window: the first change at once, every later change in the window folded into a single
// trailing announcement at the window's end — so a burst's last call is never left unannounced.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({ execute: vi.fn() }) }));

import { createUsageHinter, USAGE_HINT_WINDOW_MS } from "@/lib/realtime/usage-hint";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

let clock = 0;
let timers: Array<{ at: number; fn: () => void }> = [];
const emit = vi.fn(async (_orgId: string) => {});

/** A hinter over a fake clock and fake timers. */
function hinter() {
	return createUsageHinter({
		emit,
		now: () => clock,
		setTimer: (fn, ms) => timers.push({ at: clock + ms, fn }),
	});
}

/** Advances the fake clock, firing every timer that comes due. */
function advance(ms: number) {
	clock += ms;
	const due = timers.filter((t) => t.at <= clock);
	timers = timers.filter((t) => t.at > clock);
	for (const t of due) t.fn();
}

beforeEach(() => {
	clock = 1_000_000;
	timers = [];
	emit.mockReset();
	emit.mockResolvedValue(undefined);
});

describe("emitUsageHint's throttle", () => {
	it("announces the first change at once", () => {
		hinter()(ORG_A);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith(ORG_A);
	});

	it("folds a burst into ONE trailing announcement at the window's end", () => {
		const hint = hinter();
		hint(ORG_A);
		for (let i = 0; i < 50; i++) {
			advance(100);
			hint(ORG_A);
		}
		expect(emit).toHaveBeenCalledTimes(1);
		advance(USAGE_HINT_WINDOW_MS);
		expect(emit).toHaveBeenCalledTimes(2);
		// …and nothing more without a further change.
		advance(USAGE_HINT_WINDOW_MS * 3);
		expect(emit).toHaveBeenCalledTimes(2);
	});

	it("never announces an org twice inside one window", () => {
		const hint = hinter();
		const at: number[] = [];
		emit.mockImplementation(async () => {
			at.push(clock);
		});
		for (let i = 0; i < 400; i++) {
			hint(ORG_A);
			advance(500);
		}
		for (let i = 1; i < at.length; i++) {
			expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(USAGE_HINT_WINDOW_MS);
		}
		expect(at.length).toBeGreaterThan(5);
	});

	it("throttles each org on its own", () => {
		const hint = hinter();
		hint(ORG_A);
		hint(ORG_B);
		expect(emit.mock.calls.map(([org]) => org)).toEqual([ORG_A, ORG_B]);
	});

	it("announces at once again after a quiet window", () => {
		const hint = hinter();
		hint(ORG_A);
		advance(USAGE_HINT_WINDOW_MS + 1);
		hint(ORG_A);
		expect(emit).toHaveBeenCalledTimes(2);
	});

	it("a failed NOTIFY is swallowed — the AI call that triggered it never sees it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		emit.mockRejectedValue(new Error("db down"));
		expect(() => hinter()(ORG_A)).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
