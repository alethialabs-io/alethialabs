// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Starting a Paddle checkout: the SERVER creates the transaction and the client only ever opens it by
// id in Paddle.js. Prices come from the configured catalog (or, for a credit pack, a non-catalog price
// on the configured credits product); custom_data is the contract `paddle/events.ts` parses. Nothing a
// browser sends can change what is charged or which org it is for.
//
// The customer, address and business records are pre-created so the overlay opens pre-filled with
// what the payer already declared to us. They are a convenience: Paddle, as merchant of record,
// re-collects and validates what its tax engine needs. A record that cannot be created never blocks
// the sale — the transaction is created without it and Paddle's checkout asks instead.

import { z } from "zod";
import { PaddleApiError, type PaddleClient } from "@/lib/billing/paddle/api";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import type { PurchaseBuyer, PurchaseCustomerRefs, PurchaseItem } from "@/lib/billing/provider/types";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";

/** A credit pack as the checkout prices it: credits and the USD amount in cents. */
export interface CreditPackPrice {
	credits: number;
	amountCents: number;
}

/** One transaction line: a catalog price, or a non-catalog price on one of our products. */
export type PaddleTransactionItem =
	| { price_id: string; quantity: number }
	| {
			quantity: number;
			price: {
				name: string;
				description: string;
				product_id: string;
				unit_price: { amount: string; currency_code: string };
				tax_mode: "account_setting";
			};
	  };

/** Thrown when the configured catalog cannot price an item (a missing price or product id). */
export class PaddleCatalogError extends Error {
	/** Names what is missing — env var names only, never values. */
	constructor(message: string) {
		super(message);
		this.name = "PaddleCatalogError";
	}
}

/**
 * The transaction lines for a purchase. Plans and AI tiers are catalog prices; Pro is per seat, so
 * its quantity is the seat count (at least 1). A credit pack is one non-catalog line priced in USD
 * on the configured credits product, since the pack sizes live in code (`AI_CREDIT_PACKS`).
 */
export function transactionItems(
	item: PurchaseItem,
	config: Pick<PaddleConfig, "prices" | "products">,
	pack?: CreditPackPrice,
): PaddleTransactionItem[] {
	switch (item.kind) {
		case "plan": {
			const priceId = item.plan === "team" ? config.prices.team : config.prices.enterprise;
			if (!priceId) throw new PaddleCatalogError(`No Paddle price is configured for the ${item.plan} plan.`);
			return [{ price_id: priceId, quantity: item.plan === "team" ? Math.max(1, item.seats ?? 1) : 1 }];
		}
		case "ai_tier": {
			const priceId = item.tier === "ai_plus" ? config.prices.aiPlus : config.prices.aiMax;
			if (!priceId) throw new PaddleCatalogError(`No Paddle price is configured for ${item.tier}.`);
			return [{ price_id: priceId, quantity: 1 }];
		}
		case "credit_pack": {
			const productId = config.products.aiCredits;
			if (!productId) throw new PaddleCatalogError("PADDLE_PRODUCT_AI_CREDITS is not configured.");
			if (!pack || pack.credits !== item.credits) {
				throw new PaddleCatalogError("A credit pack needs its catalog price.");
			}
			const label = `${pack.credits.toLocaleString("en-US")} AI credits`;
			return [
				{
					quantity: 1,
					price: {
						name: label,
						description: `${label} — one-time top-up`,
						product_id: productId,
						unit_price: { amount: String(pack.amountCents), currency_code: "USD" },
						tax_mode: "account_setting",
					},
				},
			];
		}
	}
}

/**
 * The custom_data written on a checkout transaction (camelCase, the contract `paddle/events.ts`
 * parses). `plan` names the plan or tier; a credit pack carries `credits` and the buying `userId`,
 * which the webhook needs to grant the pack.
 */
export function checkoutCustomData(input: {
	organizationId: string;
	userId: string;
	item: PurchaseItem;
	commerceOrderId?: string;
}): PaddleTransactionCustomData {
	const base = {
		organizationId: input.organizationId,
		userId: input.userId,
		...(input.commerceOrderId ? { commerceOrderId: input.commerceOrderId } : {}),
	};
	switch (input.item.kind) {
		case "plan":
			return { ...base, kind: "plan", plan: input.item.plan };
		case "ai_tier":
			return { ...base, kind: "ai_tier", plan: input.item.tier };
		case "credit_pack":
			return { ...base, kind: "credit_pack", credits: input.item.credits };
	}
}

const idOnly = z.looseObject({ id: z.string().min(1) });

/** Paddle's 409 detail for an existing customer names its id; the id, or null. */
function existingCustomerIdFrom(err: PaddleApiError): string | null {
	if (err.code !== "customer_already_exists") return null;
	const match = /\bctm_[a-z0-9]+\b/.exec(err.message);
	return match ? match[0] : null;
}

/**
 * The Paddle customer for `email`: the one already on file for the org, else a new one, else (Paddle
 * customers are per e-mail address, so another org's checkout may have made it) the existing one
 * Paddle names in its conflict answer.
 */
export async function ensurePaddleCustomer(
	client: PaddleClient,
	buyer: Pick<PurchaseBuyer, "email" | "name" | "existing">,
): Promise<string> {
	const known = buyer.existing?.customerId;
	if (known) return known;
	try {
		const created = await client.request(
			{
				method: "POST",
				path: "/customers",
				body: { email: buyer.email, ...(buyer.name ? { name: buyer.name } : {}) },
			},
			idOnly,
		);
		return created.id;
	} catch (err) {
		if (err instanceof PaddleApiError) {
			const existing = existingCustomerIdFrom(err);
			if (existing) return existing;
		}
		throw err;
	}
}

/** The address body Paddle takes, from our buyer address. */
function addressBody(address: NonNullable<PurchaseBuyer["address"]>): Record<string, string> {
	const body: Record<string, string> = { country_code: address.countryCode.toUpperCase() };
	if (address.postalCode) body.postal_code = address.postalCode;
	if (address.city) body.city = address.city;
	if (address.line1) body.first_line = address.line1;
	if (address.line2) body.second_line = address.line2;
	if (address.region) body.region = address.region;
	return body;
}

/**
 * The customer's address record: the org's existing one updated to what was just declared, or a new
 * one. Null when the buyer gave no address.
 */
async function ensurePaddleAddress(
	client: PaddleClient,
	customerId: string,
	buyer: Pick<PurchaseBuyer, "address" | "existing">,
): Promise<string | null> {
	if (!buyer.address) return null;
	const body = addressBody(buyer.address);
	const known = buyer.existing?.addressId;
	if (known) {
		const updated = await client.request(
			{ method: "PATCH", path: `/customers/${encodeURIComponent(customerId)}/addresses/${encodeURIComponent(known)}`, body },
			idOnly,
		);
		return updated.id;
	}
	const created = await client.request(
		{ method: "POST", path: `/customers/${encodeURIComponent(customerId)}/addresses`, body },
		idOnly,
	);
	return created.id;
}

/** The customer's business record for an organization buyer; null for a consumer. */
async function ensurePaddleBusiness(
	client: PaddleClient,
	customerId: string,
	buyer: Pick<PurchaseBuyer, "business" | "existing">,
): Promise<string | null> {
	if (!buyer.business) return null;
	const body: Record<string, string> = { name: buyer.business.name };
	if (buyer.business.taxIdentifier) body.tax_identifier = buyer.business.taxIdentifier;
	const known = buyer.existing?.businessId;
	if (known) {
		const updated = await client.request(
			{ method: "PATCH", path: `/customers/${encodeURIComponent(customerId)}/businesses/${encodeURIComponent(known)}`, body },
			idOnly,
		);
		return updated.id;
	}
	const created = await client.request(
		{ method: "POST", path: `/customers/${encodeURIComponent(customerId)}/businesses`, body },
		idOnly,
	);
	return created.id;
}

/**
 * The customer records for a checkout, best effort: each step that fails is logged by the caller's
 * `onSkip` and the checkout continues without it (Paddle's overlay then asks for it). A customer
 * that cannot be created means no address or business either, since both hang off it.
 */
export async function preparePaddleCustomer(
	client: PaddleClient,
	buyer: PurchaseBuyer | undefined,
	onSkip: (step: "customer" | "address" | "business", err: unknown) => void,
): Promise<PurchaseCustomerRefs | null> {
	if (!buyer?.email) return null;
	let customerId: string;
	try {
		customerId = await ensurePaddleCustomer(client, buyer);
	} catch (err) {
		onSkip("customer", err);
		return null;
	}
	let addressId: string | null = null;
	try {
		addressId = await ensurePaddleAddress(client, customerId, buyer);
	} catch (err) {
		onSkip("address", err);
	}
	let businessId: string | null = null;
	// A business without an address cannot be put on a transaction, so it is only made with one.
	if (addressId) {
		try {
			businessId = await ensurePaddleBusiness(client, customerId, buyer);
		} catch (err) {
			onSkip("business", err);
		}
	}
	return { customerId, addressId, businessId };
}

/** The part of Paddle's transaction entity a checkout needs. */
const transactionSchema = z.looseObject({ id: z.string().regex(/^txn_[a-z0-9]+$/), status: z.string() });

/**
 * `POST /transactions` for a checkout. Collected automatically (a card in the overlay); the customer
 * records are attached when we have them. Returns the transaction id — the only thing the browser gets.
 */
export async function createCheckoutTransaction(
	client: PaddleClient,
	input: {
		items: PaddleTransactionItem[];
		customData: PaddleTransactionCustomData;
		customer: PurchaseCustomerRefs | null;
	},
): Promise<string> {
	const body: Record<string, unknown> = {
		items: input.items,
		custom_data: input.customData,
		collection_mode: "automatic",
	};
	if (input.customer) {
		body.customer_id = input.customer.customerId;
		if (input.customer.addressId) body.address_id = input.customer.addressId;
		if (input.customer.addressId && input.customer.businessId) body.business_id = input.customer.businessId;
	}
	const txn = await client.request({ method: "POST", path: "/transactions", body }, transactionSchema);
	return txn.id;
}
