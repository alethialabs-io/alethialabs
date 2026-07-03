"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client-side Stripe.js loader for the embedded Payment Element. Memoized so Stripe.js
// is fetched once per page. The publishable key only identifies the account, so it's
// safe in the browser (read at runtime via next-runtime-env).

import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { env } from "next-runtime-env";

let promise: Promise<Stripe | null> | null = null;

/** The shared Stripe.js instance, or a null promise when no publishable key is set. */
export function getStripePromise(): Promise<Stripe | null> {
	if (!promise) {
		const pk = env("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
		promise = pk ? loadStripe(pk) : Promise.resolve(null);
	}
	return promise;
}
