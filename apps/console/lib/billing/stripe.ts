// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe clients. Server-only. Built lazily from the validated config so a community /
// self-managed build (no STRIPE_SECRET_KEY) never constructs either.
//
// TWO CLIENTS, ON PURPOSE (ADR 0002 §4.4 and §8 step 1, #5741). `getStripe()` is the shared client and
// keeps the SDK's defaults (80s timeout, 2 network retries): every caller outside the create-a-team
// purchase — metering, webhook sync, reconcile, the backup-card `invoices.pay` loop — relies on them,
// and an app-level retry after a call that succeeded at Stripe but answered slowly can act twice (the
// meter re-reports). `getPurchaseStripe()` is the purchase path's client — the calls the create-a-team
// purchase and its link make directly — with a shorter timeout and one retry.
//
// WHAT THE TIMEOUT IS, AND IS NOT. On Node the SDK arms `req.setTimeout(timeout)`: a SOCKET-INACTIVITY
// timer that resets at each stage of the request (connect, send, each chunk of the response). It is
// not a cap on a request's total duration — a response that keeps trickling in is never cut off — and
// a connection closed by the peer can be retried outside `maxNetworkRetries`, after a backoff. So no
// number here bounds how long `subscriptions.create` takes. What makes a slow mint safe is the
// artifact gate (§4.4 rule 3, app/server/actions/billing.ts): the secret leaves the server only after a
// renewal made AFTER the create returned still finds this holder. The timeout only stops a request
// that has gone silent from holding the purchase for 80s.

import Stripe from "stripe";
import { getStripeConfig } from "./config";

/** The purchase client's per-stage socket-inactivity timeout (not a total-duration cap; see above). */
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000;

/** How many times the purchase client retries a request that failed on the network or with a retryable status. */
export const STRIPE_MAX_NETWORK_RETRIES = 1;

/** Identifies this integration to Stripe; the API version is the account's default. */
const APP_INFO = { name: "Alethia", url: "https://alethialabs.io" };

let client: Stripe | null = null;
let purchaseClient: Stripe | null = null;

/** The shared Stripe client (test or live, per STRIPE_SECRET_KEY), on the SDK's defaults. Throws if unset. */
export function getStripe(): Stripe {
	if (!client) {
		client = new Stripe(getStripeConfig().secretKey, { appInfo: APP_INFO });
	}
	return client;
}

/**
 * The create-a-team purchase path's Stripe client: `STRIPE_REQUEST_TIMEOUT_MS` of socket inactivity per
 * stage, `STRIPE_MAX_NETWORK_RETRIES` retries. Used only by the calls that purchase and its link make
 * directly (app/server/actions/billing.ts). Throws if STRIPE_SECRET_KEY is unset.
 */
export function getPurchaseStripe(): Stripe {
	if (!purchaseClient) {
		purchaseClient = new Stripe(getStripeConfig().secretKey, {
			appInfo: APP_INFO,
			timeout: STRIPE_REQUEST_TIMEOUT_MS,
			maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
		});
	}
	return purchaseClient;
}
