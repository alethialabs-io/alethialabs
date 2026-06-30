// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A minimal in-memory sliding-window rate limiter (per-instance only — no Redis
// coordination). Good enough to blunt accidental double-submits and trivial abuse of
// low-stakes server actions that have an outbound side effect (e.g. channel verification
// sends a real Slack/email/webhook delivery). Mirrors apps/marketing/lib/rate-limit.ts.

interface Window {
	hits: number[];
}

const store = new Map<string, Window>();

export interface RateLimitResult {
	ok: boolean;
	remaining: number;
}

/**
 * Records a hit for `key` and reports whether it is within `limit` over `windowMs`.
 * Sliding window: only hits newer than the cutoff count.
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
