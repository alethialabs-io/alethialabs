// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe client singleton. Server-only. Built lazily from the validated config so
// a community / self-managed build (no STRIPE_SECRET_KEY) never constructs it.
//
// THE TIMEOUT (ADR 0002 §4.4, #5741). The SDK's default is 80s per attempt, and nothing set it. The
// create-a-team purchase runs under a 120s lease that must be renewed before every Stripe write and
// must still have more than the mint's worst case left when `subscriptions.create` is called, so the
// worst case has to be a number: `STRIPE_REQUEST_TIMEOUT_MS` per attempt, `1 + STRIPE_MAX_NETWORK_RETRIES`
// attempts. Every caller shares this client, so the bound holds wherever a purchase reads or writes.

import Stripe from "stripe";
import { getStripeConfig } from "./config";

/** How long one Stripe request may take before the SDK abandons it. */
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000;

/** How many times the SDK retries a request that failed on the network or with a retryable status. */
export const STRIPE_MAX_NETWORK_RETRIES = 1;

let client: Stripe | null = null;

/** The shared Stripe client (test or live, per STRIPE_SECRET_KEY). Throws if unset. */
export function getStripe(): Stripe {
	if (!client) {
		client = new Stripe(getStripeConfig().secretKey, {
			// Pin via the account's default; let the SDK's bundled version drive typing.
			appInfo: { name: "Alethia", url: "https://alethialabs.io" },
			timeout: STRIPE_REQUEST_TIMEOUT_MS,
			maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
		});
	}
	return client;
}
