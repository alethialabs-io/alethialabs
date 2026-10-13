"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client-side Stripe.js loader for the embedded Payment Element. Memoized so Stripe.js
// is fetched once per page. The publishable key only identifies the account, so it's
// safe in the browser (read at runtime via next-runtime-env).
//
// `/pure`, NOT the package root (#5849). The root entry injects the Stripe.js <script> as a side
// effect of being IMPORTED, and this module sits in the app shell's graph (the upgrade sheet), so
// every private page fetched Stripe.js, evaluated it (~80 ms on a CI runner) and mounted Stripe's
// iframes — inside the window in which the page is still hydrating. `/pure` loads it when
// `loadStripe` is first called, i.e. when a payment surface actually renders.

import type { Stripe } from "@stripe/stripe-js";
import { loadStripe } from "@stripe/stripe-js/pure";
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
