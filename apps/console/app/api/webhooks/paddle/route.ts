// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle Billing webhook — the write path that moves an org's billing row, the `paddle_transaction`
// mirror and credit-pack grants for subscriptions sold through Paddle (merchant of record).
//
//   1. Fail closed: no Paddle config (or a misconfigured one) → 503, nothing read.
//   2. Verify `Paddle-Signature` over the RAW body (lib/billing/paddle/signature.ts: HMAC-SHA256 of
//      `ts:body`, constant-time, 5-minute replay window, any of several `h1` during rotation) BEFORE
//      the body is parsed. A bad signature → 400.
//   3. Normalize (lib/billing/paddle/events.ts) and apply each event exactly once per (provider,
//      event id) through the shared ledger (lib/billing/webhook-events.ts), the same serialization the
//      Stripe route uses: a duplicate delivery is acknowledged and skipped.
//   4. `applyBillingEvent` (lib/billing/events/apply.ts) decides what the event may change. A
//      deliberate refusal is acknowledged (200 — redelivering it would change nothing); a failure,
//      or an event that cannot apply yet, is 500 so Paddle redelivers it.

import { captureServerException } from "@/lib/analytics/server";
import { applyBillingEvent } from "@/lib/billing/events/apply";
import { postgresBillingEventStore } from "@/lib/billing/events/store";
import { alertOperator } from "@/lib/billing/operator-alert";
import { isPaddleConfigured } from "@/lib/billing/paddle/config";
import { PaddlePayloadError } from "@/lib/billing/paddle/events";
import { PaddleSignatureError, parsePaddleWebhook } from "@/lib/billing/paddle/provider";
import type { NormalizedBillingEvent } from "@/lib/billing/provider/types";
import { claimWebhookEvent, markWebhookEventError, runWebhookEventExactlyOnce } from "@/lib/billing/webhook-events";
import { log } from "@/lib/observability/log";

/** Paddle notifications are a few KB; anything far larger is refused before it is hashed. */
const MAX_BODY_BYTES = 512 * 1024;

/** Applies one event through the exactly-once ledger. Returns whether it was a duplicate. */
async function applyOnce(event: NormalizedBillingEvent): Promise<boolean> {
	const claim = await claimWebhookEvent("paddle", event.eventId, event.eventType);
	if (!claim.claimed && claim.alreadyDone) return true;
	const outcome = await runWebhookEventExactlyOnce("paddle", event.eventId, event.eventType, async () => {
		const result = await applyBillingEvent(event, {
			store: postgresBillingEventStore,
			alert: alertOperator,
			warn: (message, fields) => log.warn(message, fields),
		});
		log.info("[paddle] event applied", {
			event_id: event.eventId,
			event_type: event.eventType,
			outcome: result.outcome,
			reason: result.reason ?? null,
		});
	});
	return outcome !== "handled";
}

/** Receives a Paddle notification: verify, normalize, apply exactly once. */
export async function POST(req: Request): Promise<Response> {
	if (!isPaddleConfigured()) return new Response("billing not configured", { status: 503 });

	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
	const rawBody = await req.text();
	if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });

	let events: NormalizedBillingEvent[];
	try {
		events = await parsePaddleWebhook({ rawBody, headers: req.headers });
	} catch (err) {
		if (err instanceof PaddleSignatureError) {
			return new Response(`signature verification failed: ${err.reason}`, { status: 400 });
		}
		if (err instanceof PaddlePayloadError) {
			// Verified but unparseable: our parser is behind Paddle. 500 so it is redelivered once fixed.
			log.error("[paddle] payload did not parse", { err });
			await captureServerException(err, { props: { source: "paddle_webhook" } });
			return new Response("unrecognised payload", { status: 500 });
		}
		// The config failed to load: fail closed, never verify against a guess.
		log.error("[paddle] webhook config unavailable", { err });
		return new Response("billing not configured", { status: 503 });
	}

	let duplicate = false;
	for (const event of events) {
		try {
			duplicate = (await applyOnce(event)) || duplicate;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("[paddle] handler error", { event_type: event.eventType, event_id: event.eventId, err });
			await markWebhookEventError("paddle", event.eventId, message);
			await captureServerException(err, { props: { source: "paddle_webhook", event_type: event.eventType } });
			return new Response("handler error", { status: 500 });
		}
	}
	return Response.json(duplicate ? { received: true, duplicate: true } : { received: true });
}
