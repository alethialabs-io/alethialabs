"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Provider-neutral purchase and subscription actions (Paddle Billing, L4). Each routes through the
// billing-provider seam (lib/billing/provider/select.ts): a NEW sale follows the instance's sales
// provider, an EXISTING subscription follows the org's own row (`providerForOrg`).
//
//   startCheckout          Paddle: creates the checkout TRANSACTION server-side (prices from config,
//                          custom_data naming the org) and returns only its id, which the browser opens
//                          in Paddle.js. Stripe: answers `{ provider: "stripe" }` and does nothing — the
//                          caller continues with its existing embedded card flow (billing.ts), unchanged.
//   openBillingPortal      Paddle's customer portal, or Stripe's billing portal.
//   cancelSubscriptionPlan / resumeSubscriptionPlan / changeSubscriptionPlanTo
//                          the plan card's lifecycle writes, on whichever provider holds the subscription.
//   checkoutRail           which provider a new sale goes to, for a sheet that has no org yet.
//
// THE PRE-CHECKOUT CONSENTS ARE OURS AND COME FIRST, as on the Stripe path (O5): the purchase gate
// (`assertOrgPaidConversionAllowed`: current Terms accepted, payer capacity and country declared, the
// market open) runs before Paddle is asked for anything, and the `commerce_order` row — capacity,
// attestation, address snapshot, documents in force — is written before the transaction exists, so
// its id rides in custom_data. A transaction that cannot be created marks that order `cancelled`.

import { and, eq } from "drizzle-orm";
import { aiPlanUnitAmountCents, planUnitAmountCents } from "@repo/plan-catalog";
import { z } from "zod";
import {
	cancelSubscription,
	changeSubscriptionPlan,
	createBillingPortalSession,
	resumeSubscription,
} from "@/app/server/actions/billing";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { creditPack } from "@/lib/billing/ai-credits";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import type { PaidAiTier } from "@/lib/billing/config";
import { assertOrgPaidConversionAllowed, PaidConversionNotAllowedError } from "@/lib/billing/eligibility";
import { getPaddleConfig } from "@/lib/billing/paddle/config";
import {
	attachPaddleTransaction,
	cancelUnopenedOrder,
	orderBillingAddressSchema,
	PaidOrderRefusedError,
	type PreparedOrder,
	prepareMorOrder,
	recordPaidOrder,
} from "@/lib/billing/paid-order";
import { providerById, providerForOrg, salesProvider } from "@/lib/billing/provider/select";
import type {
	BillingProvider,
	BillingProviderId,
	PurchaseBuyer,
	PurchaseCustomerRefs,
	PurchaseItem,
} from "@/lib/billing/provider/types";
import { withPurchaseLock } from "@/lib/billing/purchase-lock";
import { getOrgBilling } from "@/lib/billing/queries";
import { countBillableSeats } from "@/lib/billing/seats";
import { isLiveSubscriptionStatus } from "@/lib/billing/subscription-status";
import { isLocalTrialRow } from "@/lib/billing/trial/local";
import { getServiceDb } from "@/lib/db";
import { type OrganizationBilling, organizationBilling, user } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** What a sheet may ask to buy. Only self-serve products; the price is never the client's. */
const checkoutItemInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("plan"), plan: z.literal("team") }),
	z.object({ kind: z.literal("ai_tier"), tier: z.enum(["ai_plus", "ai_max"]) }),
	z.object({ kind: z.literal("credit_pack"), packId: z.string().min(1).max(16) }),
]);

const startCheckoutInput = z.object({
	item: checkoutItemInput,
	/**
	 * The org to buy FOR, when it is not the ambient one — the create-a-team sheet creates the org
	 * first (O2) from a page inside another org, as `startProTrial` and `declarePayer` take it.
	 */
	orgId: z.uuid().optional(),
	/** The billing address the sheet collected with the declaration (#7324). */
	billingAddress: orderBillingAddressSchema.optional(),
});

const noInput = z.object({});

const changePlanInput = z.object({
	item: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("plan"), plan: z.enum(["team", "enterprise"]) }),
		z.object({ kind: z.literal("ai_tier"), tier: z.enum(["ai_plus", "ai_max"]) }),
	]),
});

// ── Results ─────────────────────────────────────────────────────────────────────────────────────

/** How the client continues: open the Paddle transaction, or carry on with the Stripe card flow. */
export type CheckoutStart =
	| { provider: "paddle"; transactionId: string; clientToken: string; environment: "sandbox" | "live" }
	| { provider: "stripe" };

/** The lifecycle writes' success answer. */
const OK: { ok: true } = { ok: true };

/** The refusal when billing is not wired for the provider this org routes to. */
const NOT_CONFIGURED = "Billing is not enabled on this deployment.";

/** The refusal when a purchase for this org is already being started. */
const IN_PROGRESS = "A purchase for this organization is already being started. Try again in a moment.";

/** The refusal when the org already holds what is being bought. */
const ALREADY_HAS_PLAN = "This organization already has a plan — change it instead.";
const ALREADY_HAS_AI = "This organization already has an AI subscription — change it instead.";
const CONTRACT_PLAN = "This organization's plan is managed under a contract. Contact us to change it.";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The adapter for `id`, refusing when this build or deploy cannot drive it. */
function requireAdapter(id: BillingProviderId): BillingProvider {
	const provider = providerById(id);
	if (!provider?.isConfigured()) throw new ActionRefusal("conflict", NOT_CONFIGURED);
	return provider;
}

/** A purchase item and the catalog sale the gate judges (USD list price; tax is Paddle's to add). */
interface ResolvedPurchase {
	item: PurchaseItem;
	productId: string;
	amountMinor: number;
	periodDays: number;
	renewsAutomatically: boolean;
}

/**
 * Turns the requested item into what is sold, refusing what this org may not buy now: a plan beside
 * a live one (a local card-less trial is the exception — the checkout converts it), an AI tier beside
 * a live AI subscription, a credit pack without a paid AI tier.
 */
async function resolvePurchase(
	orgId: string,
	requested: z.output<typeof checkoutItemInput>,
	row: OrganizationBilling | null,
): Promise<ResolvedPurchase> {
	switch (requested.kind) {
		case "plan": {
			if (row && !isLocalTrialRow(row)) {
				const hasSub = row.stripeSubscriptionId != null || row.paddleSubscriptionId != null;
				if (hasSub && isLiveSubscriptionStatus(row.status)) throw new ActionRefusal("conflict", ALREADY_HAS_PLAN);
				if (!hasSub && row.plan !== "community" && (row.status === "active" || row.status === "trialing")) {
					throw new ActionRefusal("conflict", CONTRACT_PLAN);
				}
			}
			const seats = Math.max(1, await countBillableSeats(orgId));
			return {
				item: { kind: "plan", plan: "team", seats },
				productId: "team",
				amountMinor: planUnitAmountCents("team", "usd") * seats,
				periodDays: 30,
				renewsAutomatically: true,
			};
		}
		case "ai_tier": {
			const hasAiSub = row?.aiStripeSubscriptionId != null || row?.aiPaddleSubscriptionId != null;
			if (row && hasAiSub && isLiveSubscriptionStatus(row.aiSubscriptionStatus)) {
				throw new ActionRefusal("conflict", ALREADY_HAS_AI);
			}
			const tier: PaidAiTier = requested.tier;
			return {
				item: { kind: "ai_tier", tier },
				productId: tier,
				amountMinor: aiPlanUnitAmountCents(tier, "usd"),
				periodDays: 30,
				renewsAutomatically: true,
			};
		}
		case "credit_pack": {
			const pack = creditPack(requested.packId);
			if (!pack) throw new ActionRefusal("not-found", "Unknown credit pack.");
			if ((await resolveAiTier(orgId)) === "ai_free") {
				throw new ActionRefusal(
					"conflict",
					"Credit packs are available on paid AI plans — upgrade to AI Plus or AI Max first.",
				);
			}
			return {
				item: { kind: "credit_pack", credits: pack.credits },
				productId: `ai_credits:${pack.id}`,
				amountMinor: pack.amountCents,
				periodDays: 0,
				renewsAutomatically: false,
			};
		}
	}
}

/** The buyer facts Paddle's checkout is pre-filled with, from our order and the org's row. */
function buyerOf(email: string, order: PreparedOrder, row: OrganizationBilling | null): PurchaseBuyer {
	return {
		email,
		name: order.billingName || null,
		address: {
			countryCode: order.billingAddress.country,
			postalCode: order.billingAddress.postalCode || null,
			city: order.billingAddress.city || null,
			line1: order.billingAddress.line1 || null,
			line2: order.billingAddress.line2,
			region: order.billingAddress.region,
		},
		business:
			order.capacity === "organization" && order.billingName
				? { name: order.billingName, taxIdentifier: order.vatId }
				: null,
		existing: {
			customerId: row?.paddleCustomerId ?? null,
			addressId: row?.paddleAddressId ?? null,
			businessId: row?.paddleBusinessId ?? null,
		},
	};
}

/**
 * Keeps the Paddle customer records on the org's row for the next checkout and the portal. Best
 * effort: the webhook writes the same ids once the subscription exists, so a failure here costs a
 * pre-fill, never a sale.
 */
async function rememberPaddleCustomer(orgId: string, refs: PurchaseCustomerRefs): Promise<void> {
	try {
		await getServiceDb()
			.update(organizationBilling)
			.set({
				paddleCustomerId: refs.customerId,
				...(refs.addressId ? { paddleAddressId: refs.addressId } : {}),
				...(refs.businessId ? { paddleBusinessId: refs.businessId } : {}),
				updatedAt: new Date(),
			})
			.where(eq(organizationBilling.organizationId, orgId));
	} catch (err) {
		log.warn("[billing] could not keep the Paddle customer records on the org", { err, organization_id: orgId });
	}
}

/** The gate and the order's refusals carry sentences the customer can act on; anything else does not. */
function asRefusal(err: unknown): never {
	if (err instanceof PaidConversionNotAllowedError || err instanceof PaidOrderRefusedError) {
		throw new ActionRefusal("conflict", err.message);
	}
	throw err;
}

// ── startCheckout ───────────────────────────────────────────────────────────────────────────────

/**
 * Starts a self-serve purchase (a plan, an AI tier or a credit pack) for the org — see the header.
 * Owner-gated (`manage_billing`), never on the personal scope.
 */
export async function startCheckout(
	raw: z.input<typeof startCheckoutInput>,
): Promise<ActionResult<CheckoutStart>> {
	return defineAction({
		input: startCheckoutInput,
		run: async ({ input }): Promise<CheckoutStart> => {
			const actor = input.orgId
				? await authorizeInOrg("manage_billing", { type: "billing" }, input.orgId)
				: await authorize("manage_billing", { type: "billing" });
			if (actor.orgId === actor.userId) {
				throw new ActionRefusal("conflict", "Create an organization before buying a plan.");
			}
			const row = await getOrgBilling(actor.orgId);
			const routed = providerForOrg(row);
			if (routed === null) throw new ActionRefusal("conflict", NOT_CONFIGURED);
			// Stripe keeps its own embedded card flow (billing.ts), unchanged.
			if (routed === "stripe") return { provider: "stripe" };
			const provider = requireAdapter(routed);

			const locked = await withPurchaseLock(`paddle-checkout:${actor.orgId}`, () =>
				startPaddleCheckout(provider, actor, input, row),
			);
			if (!locked.acquired) throw new ActionRefusal("conflict", IN_PROGRESS);
			return locked.value;
		},
	})(raw);
}

/** The Paddle half of `startCheckout`, under the org's checkout lock. */
async function startPaddleCheckout(
	provider: BillingProvider,
	actor: { userId: string; orgId: string },
	input: z.output<typeof startCheckoutInput>,
	row: OrganizationBilling | null,
): Promise<CheckoutStart> {
	const purchase = await resolvePurchase(actor.orgId, input.item, row);
	// Our consents first (O5): Terms, capacity, country and the market — before Paddle is asked anything.
	await assertOrgPaidConversionAllowed(actor.userId, actor.orgId, {
		amountMinor: purchase.amountMinor,
		currency: "usd",
	}).catch(asRefusal);
	const order = await prepareMorOrder({
		orgId: actor.orgId,
		userId: actor.userId,
		billingAddress: input.billingAddress ?? null,
	}).catch(asRefusal);
	const [buyer] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, actor.userId))
		.limit(1);
	if (!buyer) throw new ActionRefusal("not-found", "Your account was not found.");

	// The order record BEFORE the transaction, so its id rides in custom_data. The amount is the list
	// price, before the tax Paddle adds at checkout; Paddle's own total lands in the transaction mirror.
	const orderId = await recordPaidOrder(order, {
		productId: purchase.productId,
		totalMinorUnits: purchase.amountMinor,
		currency: "usd",
		periodDays: purchase.periodDays,
		renewsAutomatically: purchase.renewsAutomatically,
		provider: "paddle",
	});

	let start: Awaited<ReturnType<BillingProvider["startPurchase"]>>;
	try {
		start = await provider.startPurchase({
			organizationId: actor.orgId,
			userId: actor.userId,
			item: purchase.item,
			commerceOrderId: orderId,
			returnUrl: `${getPaddleConfig().appUrl}/dashboard/settings/billing`,
			buyer: buyerOf(buyer.email, order, row),
		});
	} catch (err) {
		await cancelUnopenedOrder(orderId);
		throw err;
	}
	if (start.kind !== "paddle_checkout") {
		await cancelUnopenedOrder(orderId);
		throw new Error(`The Paddle adapter answered a ${start.kind} start.`);
	}
	await attachPaddleTransaction(orderId, start.transactionId);
	if (start.customer) await rememberPaddleCustomer(actor.orgId, start.customer);
	return {
		provider: "paddle",
		transactionId: start.transactionId,
		clientToken: start.clientToken,
		environment: start.environment,
	};
}

// ── checkoutRail ────────────────────────────────────────────────────────────────────────────────

/**
 * Which provider a NEW sale goes to on this instance — for the create-a-team sheet, which has no org
 * (and so no row) to route by until it creates one. Signed-in only. Null when billing is not wired.
 */
export async function checkoutRail(): Promise<{ provider: BillingProviderId | null }> {
	await currentActor();
	return { provider: salesProvider() };
}

// ── Portal ──────────────────────────────────────────────────────────────────────────────────────

/** A link to manage the org's payment method and subscriptions on the provider that holds them. */
export async function openBillingPortal(raw: z.input<typeof noInput>): Promise<ActionResult<{ url: string }>> {
	return defineAction({
		input: noInput,
		run: async () => {
			const actor = await authorize("manage_billing", { type: "billing" });
			const row = await getOrgBilling(actor.orgId);
			const routed = providerForOrg(row);
			if (routed === "stripe") return createBillingPortalSession();
			if (routed === null) throw new ActionRefusal("conflict", NOT_CONFIGURED);
			const url = await requireAdapter(routed).managementUrl(
				actor.orgId,
				`${getPaddleConfig().appUrl}/dashboard/settings/billing`,
			);
			if (!url) throw new ActionRefusal("conflict", "No billing account yet — subscribe to a plan first.");
			return { url };
		},
	})(raw);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────

/** The org's Paddle plan subscription id, or a refusal when it has none. */
function paddlePlanSubscription(row: OrganizationBilling | null): string {
	if (!row?.paddleSubscriptionId) throw new ActionRefusal("conflict", "No active subscription.");
	return row.paddleSubscriptionId;
}

/**
 * Records a scheduled cancellation (or its withdrawal, with null) on the row the plan card reads, so
 * the card shows its own write at once. Only on the row still naming this subscription; the webhook
 * then writes the same value under its watermark.
 */
async function writeCancelEffectiveAt(orgId: string, subscriptionId: string, at: Date | null): Promise<void> {
	await getServiceDb()
		.update(organizationBilling)
		.set({ cancelEffectiveAt: at, updatedAt: new Date() })
		.where(
			and(
				eq(organizationBilling.organizationId, orgId),
				eq(organizationBilling.paddleSubscriptionId, subscriptionId),
			),
		);
}

/**
 * Schedules the org's plan to cancel at the end of the current period. Never gated: a closed market
 * must not trap a customer in a subscription they want to end (the same exemption Stripe's has).
 */
export async function cancelSubscriptionPlan(raw: z.input<typeof noInput>): Promise<ActionResult<{ ok: true }>> {
	return defineAction({
		input: noInput,
		run: async () => {
			const actor = await authorize("manage_billing", { type: "billing" });
			const row = await getOrgBilling(actor.orgId);
			const routed = providerForOrg(row);
			if (routed !== "paddle") return cancelSubscription();
			const subscriptionId = paddlePlanSubscription(row);
			await requireAdapter("paddle").cancelAtPeriodEnd({
				organizationId: actor.orgId,
				subscriptionId,
				slot: "plan",
			});
			// `next_billing_period` takes effect at the current period's end.
			await writeCancelEffectiveAt(actor.orgId, subscriptionId, row?.currentPeriodEnd ?? null);
			return OK;
		},
	})(raw);
}

/** Withdraws a scheduled cancellation of the org's plan. Never gated (restores a paid state). */
export async function resumeSubscriptionPlan(raw: z.input<typeof noInput>): Promise<ActionResult<{ ok: true }>> {
	return defineAction({
		input: noInput,
		run: async () => {
			const actor = await authorize("manage_billing", { type: "billing" });
			const row = await getOrgBilling(actor.orgId);
			const routed = providerForOrg(row);
			if (routed !== "paddle") return resumeSubscription();
			const subscriptionId = paddlePlanSubscription(row);
			await requireAdapter("paddle").resume({ organizationId: actor.orgId, subscriptionId, slot: "plan" });
			await writeCancelEffectiveAt(actor.orgId, subscriptionId, null);
			return OK;
		},
	})(raw);
}

/**
 * Moves the org's plan or AI subscription to another plan or tier. A paid conversion, so gated like
 * a purchase. Paddle prorates an upgrade immediately and a downgrade at the next renewal
 * (lib/billing/paddle/subscriptions.ts); Stripe keeps its own `create_prorations` behaviour.
 */
export async function changeSubscriptionPlanTo(
	raw: z.input<typeof changePlanInput>,
): Promise<ActionResult<{ ok: true }>> {
	return defineAction({
		input: changePlanInput,
		run: async ({ input }) => {
			const actor = await authorize("manage_billing", { type: "billing" });
			const row = await getOrgBilling(actor.orgId);
			const routed = providerForOrg(row);
			if (routed === "stripe") {
				if (input.item.kind !== "plan") {
					throw new ActionRefusal("conflict", "Change the AI plan from the AI upgrade sheet.");
				}
				return changeSubscriptionPlan(input.item.plan);
			}
			if (routed === null) throw new ActionRefusal("conflict", NOT_CONFIGURED);
			const subscriptionId = input.item.kind === "plan" ? row?.paddleSubscriptionId : row?.aiPaddleSubscriptionId;
			if (!subscriptionId) throw new ActionRefusal("conflict", "No active subscription.");
			const item: PurchaseItem =
				input.item.kind === "plan"
					? input.item.plan === "team"
						? { kind: "plan", plan: "team", seats: Math.max(1, await countBillableSeats(actor.orgId)) }
						: { kind: "plan", plan: "enterprise" }
					: { kind: "ai_tier", tier: input.item.tier };
			await assertOrgPaidConversionAllowed(actor.userId, actor.orgId).catch(asRefusal);
			await requireAdapter(routed).changePlan(
				{ organizationId: actor.orgId, subscriptionId, slot: input.item.kind === "plan" ? "plan" : "ai" },
				item,
			);
			return OK;
		},
	})(raw);
}
