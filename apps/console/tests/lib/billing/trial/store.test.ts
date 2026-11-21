// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trial ceilings' store (lib/billing/trial/store.ts, REL-L19 #6907), over a fake connection: the
// ORDER of its statements is what this pins — every lock before any read, every read before any
// write, and no write at all when a counter is full. The statements' SQL meaning (windows, expiry,
// the conflict update) is exercised against real Postgres in tests/integration/trial-ceilings.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Op = { op: "lock" | "read" | "write" | "release"; detail?: string };

const fake = vi.hoisted(() => {
	const state = {
		ops: [] as { op: "lock" | "read" | "write" | "release"; detail?: string }[],
		used: [] as number[],
		writeKeys: [] as string[],
	};
	/** A builder for `select … from … where`, resolving to the next queued count. */
	const select = () => ({
		from: () => ({
			where: async () => {
				state.ops.push({ op: "read" });
				return [{ used: state.used.shift() ?? 0 }];
			},
		}),
	});
	const insert = () => ({
		values: (v: { key: string }) => ({
			onConflictDoUpdate: () => ({
				returning: async () => {
					state.ops.push({ op: "write", detail: v.key });
					state.writeKeys.push(v.key);
					return [{ windowStart: new Date(0) }];
				},
			}),
		}),
	});
	const tx = {
		execute: async () => {
			state.ops.push({ op: "lock" });
			return [];
		},
		select,
		insert,
	};
	const db = {
		transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
		select,
		update: () => ({
			set: () => ({
				where: async () => {
					state.ops.push({ op: "release" });
				},
			}),
		}),
	};
	return { state, db };
});
vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import type { TrialCounter } from "@/lib/billing/trial/ceilings";
import { peekFullCounter, releaseTrialSlots, reserveTrialSlots } from "@/lib/billing/trial/store";

const counters: TrialCounter[] = [
	{ key: "trial:org:o", limit: 1, windowDays: null, refusal: "trial_org_used" },
	{ key: "trial:person:p", limit: 1, windowDays: null, refusal: "trial_person_limit" },
	{ key: "trial:network:n", limit: 3, windowDays: 30, refusal: "trial_network_limit" },
];

/** The op names in order. */
function ops(): Op["op"][] {
	return fake.state.ops.map((o) => o.op);
}

beforeEach(() => {
	fake.state.ops = [];
	fake.state.used = [];
	fake.state.writeKeys = [];
});

describe("reserveTrialSlots", () => {
	it("locks every key, reads every count, then writes every counter", async () => {
		fake.state.used = [0, 0, 2];
		const result = await reserveTrialSlots(counters);
		expect(result.ok).toBe(true);
		expect(ops()).toEqual(["lock", "lock", "lock", "read", "read", "read", "write", "write", "write"]);
		expect(fake.state.writeKeys).toEqual(counters.map((c) => c.key));
		if (result.ok) expect(result.slots.map((s) => s.key)).toEqual(counters.map((c) => c.key));
	});

	it("writes nothing when one counter is full, and names it", async () => {
		fake.state.used = [0, 0, 3];
		const result = await reserveTrialSlots(counters);
		expect(result).toEqual({ ok: false, refused: counters[2] });
		expect(ops()).not.toContain("write");
	});
});

describe("releaseTrialSlots", () => {
	it("gives back each slot", async () => {
		await releaseTrialSlots([
			{ key: "trial:org:o", windowStart: new Date(0) },
			{ key: "trial:network:n", windowStart: new Date(0) },
		]);
		expect(ops()).toEqual(["release", "release"]);
	});
});

describe("peekFullCounter", () => {
	it("reads without locking or writing", async () => {
		fake.state.used = [1];
		expect(await peekFullCounter([counters[1] as TrialCounter])).toBe(counters[1]);
		expect(ops()).toEqual(["read"]);
	});

	it("is null while the counter has room", async () => {
		fake.state.used = [0];
		expect(await peekFullCounter([counters[1] as TrialCounter])).toBeNull();
	});
});
