// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe client singleton. Server-only. Built lazily from the validated config so
// a community / self-managed build (no STRIPE_SECRET_KEY) never constructs it.

import Stripe from "stripe";
import { getStripeConfig } from "./config";

let client: Stripe | null = null;

/** The shared Stripe client (test or live, per STRIPE_SECRET_KEY). Throws if unset. */
export function getStripe(): Stripe {
	if (!client) {
		client = new Stripe(getStripeConfig().secretKey, {
			// Pin via the account's default; let the SDK's bundled version drive typing.
			appInfo: { name: "Alethia", url: "https://alethialabs.io" },
		});
	}
	return client;
}
