// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle adapter behind the billing-provider seam (lib/billing/provider/types.ts). L3 implements
// what the webhook needs — `parseWebhook`, `isConfigured`, `mode`. The purchase, portal and plan
// methods arrive with L4 and the usage/document methods with L5; until then they throw
// `PaddleNotImplementedError` rather than pretend, and nothing calls them.

import { getPaddleConfig, isPaddleConfigured } from "@/lib/billing/paddle/config";
import { normalizePaddleEvent, parsePaddleEnvelope } from "@/lib/billing/paddle/events";
import { type PaddleSignatureFailure, verifyPaddleSignature } from "@/lib/billing/paddle/signature";
import { paddleApiKey, paddleKeyEnvironment } from "@/lib/billing/paddle-key";
import type { BillingProvider, NormalizedBillingEvent, WebhookDelivery } from "@/lib/billing/provider/types";

/** The header Paddle signs every notification in. */
export const PADDLE_SIGNATURE_HEADER = "paddle-signature";

/** A delivery whose signature did not verify. The route answers 400; the reason is safe to return. */
export class PaddleSignatureError extends Error {
	readonly reason: PaddleSignatureFailure;

	/** Builds the error for one refusal reason. */
	constructor(reason: PaddleSignatureFailure) {
		super(`Paddle signature verification failed: ${reason}`);
		this.name = "PaddleSignatureError";
		this.reason = reason;
	}
}

/** A seam method this lane does not implement yet. */
export class PaddleNotImplementedError extends Error {
	/** Names the method and the lane it lands in. */
	constructor(method: string, lane: string) {
		super(`Paddle ${method} is not implemented yet (lands in ${lane})`);
		this.name = "PaddleNotImplementedError";
	}
}

/** What the adapter reads from its surroundings — injectable for tests. */
export interface PaddleProviderDeps {
	config: typeof getPaddleConfig;
	nowMs: () => number;
}

const defaultDeps: PaddleProviderDeps = { config: getPaddleConfig, nowMs: () => Date.now() };

/**
 * Verifies a delivery's `Paddle-Signature` against the configured webhook secret and normalizes it.
 * Throws {@link PaddleSignatureError} on a bad signature (before the body is parsed at all), the
 * config error when Paddle is misconfigured (fail closed), and `PaddlePayloadError` for a verified
 * body that does not parse.
 */
export async function parsePaddleWebhook(
	delivery: WebhookDelivery,
	deps: PaddleProviderDeps = defaultDeps,
): Promise<NormalizedBillingEvent[]> {
	const config = deps.config();
	const verdict = verifyPaddleSignature({
		rawBody: delivery.rawBody,
		header: delivery.headers.get(PADDLE_SIGNATURE_HEADER),
		secrets: [config.webhookSecret],
		nowMs: deps.nowMs(),
	});
	if (!verdict.ok) throw new PaddleSignatureError(verdict.reason);
	return [normalizePaddleEvent(parsePaddleEnvelope(delivery.rawBody), config)];
}

/** The Paddle adapter. */
export function createPaddleProvider(deps: PaddleProviderDeps = defaultDeps): BillingProvider {
	return {
		id: "paddle",
		sellerOfRecord: "paddle",
		isConfigured: () => isPaddleConfigured(),
		mode: () => {
			const env = paddleKeyEnvironment(paddleApiKey());
			if (env === null) return null;
			return env === "live" ? "live" : "test";
		},
		parseWebhook: (delivery) => parsePaddleWebhook(delivery, deps),
		startPurchase: () => Promise.reject(new PaddleNotImplementedError("startPurchase", "L4")),
		managementUrl: () => Promise.reject(new PaddleNotImplementedError("managementUrl", "L4")),
		cancelAtPeriodEnd: () => Promise.reject(new PaddleNotImplementedError("cancelAtPeriodEnd", "L4")),
		resume: () => Promise.reject(new PaddleNotImplementedError("resume", "L4")),
		changePlan: () => Promise.reject(new PaddleNotImplementedError("changePlan", "L4")),
		postUsageCharge: () => Promise.reject(new PaddleNotImplementedError("postUsageCharge", "L5")),
		reportJobUsage: () => Promise.resolve(false),
		listDocuments: () => Promise.reject(new PaddleNotImplementedError("listDocuments", "L5")),
		livePrices: () => Promise.reject(new PaddleNotImplementedError("livePrices", "L4")),
	};
}
