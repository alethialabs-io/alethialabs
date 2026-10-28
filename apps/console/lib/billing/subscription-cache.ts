// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";

// ── The subscription read behind the summary, cached ─────────────────────────────────────────────
//
// `billing.summary` is read by EVERY member on the Usage and Billing pages and refetched on every
// `billing` hint, so an uncached `subscriptions.retrieve` would be Stripe calls × visible tabs ×
// webhook burst, against the one account rate limit checkout also depends on. So the read is cached
// per subscription for {@link SUBSCRIPTION_CACHE_TTL_MS}, PROCESS-LOCAL (each console replica keeps
// its own; nothing is shared), with concurrent reads coalesced onto one request.
//
// The key carries the billing row's Stripe EVENT WATERMARK (`stripe_subscription_event_at`), which
// the webhook advances on every applied subscription event — so a change Stripe tells us about is a
// cache MISS, not a stale answer for up to 45 s. This app's own writes (cancel/resume/plan change)
// drop the entry with {@link forgetSubscription}, so the page that made the change reads it back.

/** How long one subscription read is served from memory. */
export const SUBSCRIPTION_CACHE_TTL_MS = 45_000;

/** At most this many cached subscriptions; the oldest go first. */
const SUBSCRIPTION_CACHE_MAX = 1_000;

const subscriptionReads = new Map<string, { at: number; read: Promise<Stripe.Subscription> }>();

/** The cache key: the subscription, at the last Stripe event the webhook applied to it. */
function subscriptionKey(subscriptionId: string, eventAt: Date | null): string {
	return `${subscriptionId}@${eventAt?.getTime() ?? 0}`;
}

/** The org's Stripe subscription, from the cache when a fresh read is there (see above). */
export function readSubscription(subscriptionId: string, eventAt: Date | null): Promise<Stripe.Subscription> {
	const key = subscriptionKey(subscriptionId, eventAt);
	const now = Date.now();
	const hit = subscriptionReads.get(key);
	if (hit && now - hit.at < SUBSCRIPTION_CACHE_TTL_MS) return hit.read;
	const read = getStripe().subscriptions.retrieve(subscriptionId);
	subscriptionReads.set(key, { at: now, read });
	// A failed read is never served from the cache.
	read.catch(() => {
		if (subscriptionReads.get(key)?.read === read) subscriptionReads.delete(key);
	});
	while (subscriptionReads.size > SUBSCRIPTION_CACHE_MAX) {
		const oldest = subscriptionReads.keys().next().value;
		if (oldest === undefined) break;
		subscriptionReads.delete(oldest);
	}
	return read;
}

/** Drops every cached read of a subscription — after this app changed it (read-your-own-writes). */
export function forgetSubscription(subscriptionId: string): void {
	for (const key of subscriptionReads.keys()) {
		if (key.startsWith(`${subscriptionId}@`)) subscriptionReads.delete(key);
	}
}
