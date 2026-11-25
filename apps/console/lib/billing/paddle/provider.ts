// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle adapter behind the billing-provider seam (lib/billing/provider/types.ts). L3 implements
// what the webhook needs — `parseWebhook`, `isConfigured`, `mode`; L4 the purchase, portal, plan and
// price methods (./checkout.ts, ./subscriptions.ts); L5 the usage and document methods (./overage.ts,
// ./documents.ts).

import { AI_CREDIT_PACKS } from "@/lib/billing/ai-credits";
import { createPaddleClient, type PaddleClient, paddleClient } from "@/lib/billing/paddle/api";
import { createCheckoutTransaction, checkoutCustomData, preparePaddleCustomer, transactionItems } from "@/lib/billing/paddle/checkout";
import { getPaddleConfig, isPaddleConfigured } from "@/lib/billing/paddle/config";
import type { PaddleOrgRow } from "@/lib/billing/paddle/org-row";
import {
	cancelPaddleSubscriptionAtPeriodEnd,
	changePaddleSubscriptionPlan,
	paddleLivePrices,
	paddlePortalUrl,
	resumePaddleSubscription,
} from "@/lib/billing/paddle/subscriptions";
import { normalizePaddleEvent, parsePaddleEnvelope } from "@/lib/billing/paddle/events";
import { postPaddleUsageCharge, recordPaddleJobUsage } from "@/lib/billing/paddle/overage";
import { type PaddleSignatureFailure, verifyPaddleSignature } from "@/lib/billing/paddle/signature";
import { paddleApiKey, paddleKeyEnvironment } from "@/lib/billing/paddle-key";
import type {
	BillingProvider,
	NormalizedBillingEvent,
	PurchaseRequest,
	PurchaseStart,
	WebhookDelivery,
} from "@/lib/billing/provider/types";
import { log } from "@/lib/observability/log";

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

/** What the adapter reads from its surroundings — injectable for tests. */
export interface PaddleProviderDeps {
	config: typeof getPaddleConfig;
	nowMs: () => number;
	/** The API client (L4's methods). Defaults to the configured one. */
	client?: () => PaddleClient;
	/** The org's Paddle linkage, for the portal. Defaults to the service-role read. */
	orgRow?: (organizationId: string) => Promise<PaddleOrgRow | null>;
}

const defaultDeps: PaddleProviderDeps = { config: getPaddleConfig, nowMs: () => Date.now() };

/**
 * Creates the checkout transaction for a purchase (see ./checkout.ts). Prices come from the config,
 * custom_data from the request — both server-side. The customer records are prepared best effort and
 * handed back so the caller can keep them on the org's row for the next checkout and the portal.
 */
export async function startPaddlePurchase(
	req: PurchaseRequest,
	deps: PaddleProviderDeps = defaultDeps,
): Promise<PurchaseStart> {
	const config = deps.config();
	const client = (deps.client ?? paddleClient)();
	const { item } = req;
	const pack = item.kind === "credit_pack" ? AI_CREDIT_PACKS.find((p) => p.credits === item.credits) : undefined;
	// Priced first: a catalog gap refuses before any customer record is written.
	const items = transactionItems(req.item, config, pack);
	const customer = await preparePaddleCustomer(client, req.buyer, (step, err) => {
		log.warn(`[billing] paddle checkout continues without a pre-filled ${step}`, {
			err,
			organization_id: req.organizationId,
		});
	});
	const transactionId = await createCheckoutTransaction(client, {
		items,
		customData: checkoutCustomData({
			organizationId: req.organizationId,
			userId: req.userId,
			item: req.item,
			commerceOrderId: req.commerceOrderId,
		}),
		customer,
	});
	return {
		kind: "paddle_checkout",
		transactionId,
		clientToken: config.clientToken,
		environment: config.environment,
		...(customer ? { customer } : {}),
	};
}

/**
 * A customer-portal link for the org: authenticated for its Paddle customer and deep-linked to its
 * subscriptions. Null when the org has never had a Paddle customer (nothing to manage).
 */
export async function paddleManagementUrl(
	organizationId: string,
	deps: PaddleProviderDeps = defaultDeps,
): Promise<string | null> {
	// The DB read is loaded lazily, as ./documents.ts is, so this adapter's static imports stay inside
	// lib/billing/paddle/* (select.ts).
	const readRow = deps.orgRow ?? (await import("@/lib/billing/paddle/org-row")).readPaddleOrgRow;
	const row = await readRow(organizationId);
	if (!row?.paddleCustomerId) return null;
	const subs = [row.paddleSubscriptionId, row.aiPaddleSubscriptionId].filter((id): id is string => Boolean(id));
	return paddlePortalUrl((deps.client ?? paddleClient)(), row.paddleCustomerId, subs);
}

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
		startPurchase: (req) => startPaddlePurchase(req, deps),
		managementUrl: (organizationId) => paddleManagementUrl(organizationId, deps),
		cancelAtPeriodEnd: async (ref) => {
			await cancelPaddleSubscriptionAtPeriodEnd((deps.client ?? paddleClient)(), ref.subscriptionId);
		},
		resume: async (ref) => {
			await resumePaddleSubscription((deps.client ?? paddleClient)(), ref.subscriptionId);
		},
		changePlan: async (ref, item) => {
			await changePaddleSubscriptionPlan((deps.client ?? paddleClient)(), ref.subscriptionId, item, deps.config());
		},
		// L5: overage (./overage.ts, swept by ./overage-sweeper.ts) and documents (./documents.ts, loaded
		// lazily so this adapter's static imports stay inside lib/billing/paddle/* — see select.ts).
		postUsageCharge: (charge) => {
			const config = deps.config();
			const client = createPaddleClient({ apiKey: config.apiKey, environment: config.environment });
			return postPaddleUsageCharge(client, config.products.runnerMinutes, charge);
		},
		reportJobUsage: recordPaddleJobUsage,
		listDocuments: async (organizationId, opts) =>
			(await import("@/lib/billing/paddle/documents")).listPaddleDocuments(organizationId, opts),
		livePrices: () => paddleLivePrices((deps.client ?? paddleClient)(), deps.config()),
	};
}
