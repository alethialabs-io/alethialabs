// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An in-memory stand-in for lib/rate-limit.ts, for UNIT tests of the routes that call it.
//
// The real limiter counts in Postgres (#5309), which a unit test does not have — and these route
// tests mock `@/lib/db` with a queue of canned rows, so letting the real limiter run would consume
// rows meant for the route. Each file opts in explicitly:
//
//   vi.mock("@/lib/rate-limit", async () =>
//     (await import("@/tests/fixtures/memory-rate-limit")).memoryRateLimitModule());
//
// It keeps the real limiter's CONTRACT — fixed windows aligned to `windowMs`, a refused hit is not
// counted, `remaining` after an allowed hit — so a route's "the 21st request is 429" is still a test
// of the route's budget. What it cannot test is the sharing, the atomicity or the fail mode; those
// are tests/integration/rate-limit.test.ts's, against real Postgres.

import type { RateLimitOptions, RateLimitResult } from "@/lib/rate-limit";

/** The limiter half of lib/rate-limit.ts (the routes never call the sweep), over one fresh map. */
export function memoryRateLimitModule() {
	const buckets = new Map<string, number>();

	/** Fixed-window check-and-increment over the in-memory map, mirroring the real limiter. */
	async function checkRateLimit(
		key: string,
		limit: number,
		windowMs: number,
		options: RateLimitOptions = {},
	): Promise<RateLimitResult> {
		if (limit <= 0) return { ok: false, remaining: 0 };
		const now = (options.now ?? new Date()).getTime();
		const windowStart = Math.floor(now / windowMs) * windowMs;
		const bucketKey = `${key}\u0000${windowStart}`;
		const hits = buckets.get(bucketKey) ?? 0;
		if (hits >= limit) return { ok: false, remaining: 0 };
		buckets.set(bucketKey, hits + 1);
		return { ok: true, remaining: limit - hits - 1 };
	}

	return { checkRateLimit };
}
