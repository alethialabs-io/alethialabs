// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * Best-effort and **per-instance**: the window lives in process memory, so it
 * resets on redeploy and does not coordinate across replicas (this repo has no
 * Redis/Upstash). That is acceptable for low-stakes public endpoints like the
 * contact form, where it only needs to blunt accidental double-submits and
 * trivial scripted spam — not enforce a hard global quota.
 */

interface Window {
	/** Hit timestamps (ms) still inside the current window. */
	hits: number[];
}

/** Module-level store keyed by caller-supplied identifier (e.g. client IP). */
const store = new Map<string, Window>();

export interface RateLimitResult {
	/** Whether this hit is allowed. */
	ok: boolean;
	/** Hits remaining in the window after this one (0 when blocked). */
	remaining: number;
}

/**
 * Records a hit for `key` and reports whether it stays within `limit` hits per
 * `windowMs`. Expired timestamps are pruned on each call, so the store stays
 * bounded for active keys without a background sweep.
 */
export function checkRateLimit(
	key: string,
	limit: number,
	windowMs: number,
	now: number = Date.now(),
): RateLimitResult {
	const cutoff = now - windowMs;
	const entry = store.get(key) ?? { hits: [] };
	const hits = entry.hits.filter((t) => t > cutoff);

	if (hits.length >= limit) {
		store.set(key, { hits });
		return { ok: false, remaining: 0 };
	}

	hits.push(now);
	store.set(key, { hits });
	return { ok: true, remaining: Math.max(0, limit - hits.length) };
}
