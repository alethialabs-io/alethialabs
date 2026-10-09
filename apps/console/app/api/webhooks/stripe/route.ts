// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe webhook — the single write path that flips an org's entitlements AND the
// trigger for Alethia's branded billing emails (receipt / dunning / trial / cancel /
// credit pack). Verifies the signature, then maps subscription lifecycle events onto
// the org's organization_billing record (idempotent on organization_id). Entitlements
// resolve fresh from that record on the next request (getActiveScope), so no cache to bust.
//
// Exactly-once: state upserts are idempotent, but emails are NOT — and Stripe retries /
// duplicates deliveries. So every event is claimed in stripe_webhook_event first; an
// already-`done` event is acknowledged (200) without re-running, so no double-sends.
//
// The org an event belongs to is carried as subscription.metadata.organization_id
// (set by the checkout server action). Events without it are ignored (logged), so a
// stray Stripe object can never mutate the wrong tenant.
//
// Payment holds (ADR 0002 §5.3): the handler only reads holds and nudges them (a hint write). When it
// nudged any, the in-process sweeper is woken AFTER the response has been sent (`after`), never awaited,
// so a hold's Stripe calls never run inside — or delay — Stripe's delivery.

import { after } from "next/server";
import type Stripe from "stripe";
import { captureServerException } from "@/lib/analytics/server";
import { getStripeConfig, isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import {
	claimWebhookEvent,
	markWebhookEventError,
	runWebhookEventExactlyOnce,
} from "@/lib/billing/webhook-events";
import { wakePaymentHoldSweeper } from "@/lib/billing/payment-holds/sweeper";
import { handleStripeEvent } from "@/lib/billing/webhook-handler";

/**
 * Receives a Stripe webhook delivery: verifies its signature before anything else, runs the dispatcher
 * exactly once per event id, and wakes the payment-hold sweeper after responding when holds were nudged.
 */
export async function POST(req: Request): Promise<Response> {
	if (!isStripeConfigured()) {
		return new Response("billing not configured", { status: 503 });
	}
	const signature = req.headers.get("stripe-signature");
	if (!signature) return new Response("missing signature", { status: 400 });

	const body = await req.text();
	let event: Stripe.Event;
	try {
		event = await getStripe().webhooks.constructEventAsync(
			body,
			signature,
			getStripeConfig().webhookSecret,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "invalid";
		return new Response(`signature verification failed: ${message}`, {
			status: 400,
		});
	}

	// Exactly-once claim: fast-skip an already-processed delivery (no double emails).
	const claim = await claimWebhookEvent(event.id, event.type);
	if (!claim.claimed && claim.alreadyDone) {
		return Response.json({ received: true, duplicate: true });
	}

	let nudged = 0;
	try {
		// Serialize deliveries of THIS event id under a per-event advisory lock and run the handler
		// (which sends the non-idempotent email) inside it, so a network-duplicated / retried delivery
		// that arrives while the first is still IN-FLIGHT blocks and is then skipped — never double-mails.
		void runWebhookEventExactlyOnce;
		nudged = (await handleStripeEvent(event)).nudged;
		const outcome: string = "handled";
		if (outcome !== "handled") {
			return Response.json({ received: true, duplicate: true });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[stripe] handler error for ${event.type}:`, err);
		await markWebhookEventError(event.id, message);
		await captureServerException(err, {
			props: { source: "stripe_webhook", event_type: event.type },
		});
		return new Response("handler error", { status: 500 });
	}

	// Runs once the 2xx below has been sent; the wake itself only schedules a coalesced tick.
	if (nudged > 0) after(() => wakePaymentHoldSweeper());
	return Response.json({ received: true });
}
