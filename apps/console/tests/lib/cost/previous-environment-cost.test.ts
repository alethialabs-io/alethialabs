// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// getPreviousEnvironmentCost — the cost gate's baseline. Mocked-boundary: the service DB is a
// scripted builder whose awaited SELECTs resolve rows in call order (this plan's row, then the
// strictly-earlier one).

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Rows each awaited SELECT resolves to, consumed in call order. */
	const selects: unknown[][] = [];

	/** A drizzle-shaped SELECT builder: every step returns itself; awaiting it resolves the next rows. */
	class Chain implements PromiseLike<unknown[]> {
		/** Builder step (no-op). */
		select(): this {
			return this;
		}
		/** Builder step (no-op). */
		from(): this {
			return this;
		}
		/** Builder step (no-op). */
		where(): this {
			return this;
		}
		/** Builder step (no-op). */
		orderBy(): this {
			return this;
		}
		/** Builder step (no-op). */
		limit(): this {
			return this;
		}
		/** Resolves the next scripted rows. */
		then<A = unknown[], B = never>(
			onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): PromiseLike<A | B> {
			return Promise.resolve(selects.shift() ?? []).then(onFulfilled, onRejected);
		}
	}

	return { db: { select: () => new Chain() }, selects };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { getPreviousEnvironmentCost } from "@/lib/cost/previous-environment-cost";

beforeEach(() => {
	fake.selects.length = 0;
});

describe("getPreviousEnvironmentCost", () => {
	it("is null when this plan was never priced", async () => {
		fake.selects.push([]);
		await expect(getPreviousEnvironmentCost("env-1", "plan-1")).resolves.toBeNull();
	});

	it("is null on the first-ever pricing (no earlier row)", async () => {
		fake.selects.push([{ captured_at: new Date("2026-01-02T00:00:00Z") }], []);
		await expect(getPreviousEnvironmentCost("env-1", "plan-1")).resolves.toBeNull();
	});

	it("is the strictly-earlier row's monthly total", async () => {
		fake.selects.push([{ captured_at: new Date("2026-01-02T00:00:00Z") }], [{ total_monthly: 412 }]);
		await expect(getPreviousEnvironmentCost("env-1", "plan-1")).resolves.toBe(412);
	});
});
