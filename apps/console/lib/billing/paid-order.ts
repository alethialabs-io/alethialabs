// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The order record of a paid conversion, and the payer facts that must reach Stripe BEFORE the charge
// (#7324, EA-2). Two halves, called around every mint in `app/server/actions/billing.ts`:
//
//   1. `preparePaidOrder` — BEFORE the subscription or invoice is created. Reads the declared payer
//      facts, puts the full billing address (and, where one may be recorded, the VAT number) on the
//      Stripe customer, and refuses when there is no address to put. Stripe snapshots the customer's
//      address and tax ids onto an invoice when it FINALISES it, and the first invoice of a
//      `default_incomplete` subscription is finalised at creation — so an address written after the
//      card is charged (the old upgrade sheets' `handlePaid`) was never on the first invoice, nor on
//      the фактура built from it (Art. 114(1) needs the recipient's name and address).
//   2. `recordPaidOrder` — AFTER the mint succeeded and before anything payable leaves the server.
//      Writes the `commerce_order` row: capacity, attestation, country, the address SNAPSHOT, whether a
//      VAT number was communicated, the price and the documents in force. That last fact is what
//      decides an EU order's place of supply (TAX §3.4) and it had nowhere to go: nothing inserted
//      into `commerce_order` before this.
//
// FAIL-CLOSED. No declared capacity, no address, an address in a different country from the declared
// one: refused before Stripe is written to. A failed order write is thrown, and the caller closes out
// what it minted.
//
// And the tax-ID rule (`taxIdRefusal`), shared by every action that writes a tax id onto a Stripe
// customer: no EU VAT number for a non-BG EU customer while the seller is unregistered, none at all for
// an organization that declared "no VAT number", and an `eu_vat` value only in its country's format.

import { and, desc, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import {
	EU_MEMBER_STATES,
	type PayerCapacity,
	SELLER_COUNTRY,
	type VatIdStatus,
} from "@repo/legal/commerce";
import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { BILLING_FIELD_CAPS, tooLongMessage } from "@/lib/billing/billing-field-caps";
import { isVatTaxIdType, normaliseEuVatNumber, type TaxIdType } from "@/lib/billing/tax-ids";
import { getServiceDb } from "@/lib/db";
import { commerceOrder, organization, organizationBilling } from "@/lib/db/schema";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import type { CommerceBillingAddress, CommerceDocumentVersions } from "@/types/jsonb.types";

/** A trimmed string no longer than `max`. */
function capped(max: number) {
	return z.string().trim().max(max, tooLongMessage(max));
}

/**
 * The billing address a purchase sheet collects with the declaration, before the intent. The same
 * fields and caps as the checkout form (`lib/billing/billing-field-caps.ts`).
 */
export const orderBillingAddressSchema = z.object({
	name: capped(BILLING_FIELD_CAPS.name).min(1, "Enter the name to bill."),
	line1: capped(BILLING_FIELD_CAPS.line1).min(1, "Enter the address."),
	line2: capped(BILLING_FIELD_CAPS.line2).optional(),
	city: capped(BILLING_FIELD_CAPS.city).min(1, "Enter the city."),
	state: capped(BILLING_FIELD_CAPS.state).optional(),
	postalCode: capped(BILLING_FIELD_CAPS.postalCode).min(1, "Enter the postal code."),
	country: z
		.string()
		.trim()
		.length(2, "Select a country.")
		.transform((v) => v.toUpperCase()),
});

/** A billing address as a caller passes it. */
export type OrderBillingAddressInput = z.input<typeof orderBillingAddressSchema>;

/** The declared payer facts and the address snapshot, ready to be recorded once the mint succeeds. */
export interface PreparedOrder {
	readonly organizationId: string;
	readonly placedByUserId: string;
	readonly capacity: PayerCapacity;
	readonly authorityAttestation: string | null;
	readonly billingCountry: string;
	readonly billingState: string | null;
	readonly vatIdStatus: VatIdStatus | null;
	readonly vatId: string | null;
	/** The billing name the customer carries — the invoice's recipient. */
	readonly billingName: string;
	readonly billingAddress: CommerceBillingAddress;
}

/** Thrown when the order cannot be prepared; its message is safe to show the customer. */
export class PaidOrderRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaidOrderRefusedError";
	}
}

/** Narrows a stored capacity to a known one, or null. */
function narrowCapacity(value: string | null | undefined): PayerCapacity | null {
	return value === "consumer" || value === "organization" ? value : null;
}

/** Narrows a stored VAT-number status to a known one, or null. */
function narrowVatIdStatus(value: string | null | undefined): VatIdStatus | null {
	return value === "given" || value === "not_given" ? value : null;
}

/** The trimmed value, or null when it is empty or absent. */
function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

/**
 * Whether an EU VAT number may be put on a Stripe customer billed in `country` today: in Bulgaria
 * always (a domestic B2B invoice carries it), elsewhere in the EU only once the seller is
 * VAT-registered — before that, a sale to such a business is the supply TAX §3.3 forbids.
 */
export function euVatNumberMayBeRecorded(country: string, vatRegistered: boolean): boolean {
	const iso = country.trim().toUpperCase();
	if (!EU_MEMBER_STATES.includes(iso)) return false;
	return iso === SELLER_COUNTRY || vatRegistered;
}

/** What a tax-ID action may write, or why it may not. */
export type TaxIdVerdict =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly message: string };

/**
 * THE tax-ID rule, for every action that writes a tax id onto a Stripe customer (`saveTaxId`,
 * `attachTaxIdToCustomer`, and the declared VAT number in `preparePaidOrder`). Clearing (an empty
 * value) is always allowed. Otherwise:
 *
 *  - an organization that declared `not_given` records no VAT-kind number at all (`VAT_TAX_ID_TYPES`)
 *    — the record that "no VAT number was communicated" must stay true;
 *  - an `eu_vat` needs an EU billing country (unknown refuses: fail-closed), may not be recorded for
 *    a non-BG EU customer while the seller is not VAT-registered, and must be in that country's
 *    format. The value returned is the normalised `PREFIX+number`.
 */
export function taxIdRefusal(input: {
	readonly type: TaxIdType;
	readonly value: string;
	readonly country: string | null;
	readonly vatIdStatus: VatIdStatus | null;
	readonly vatRegistered: boolean;
}): TaxIdVerdict {
	const value = input.value.trim();
	if (value === "") return { ok: true, value };
	if (input.vatIdStatus === "not_given" && isVatTaxIdType(input.type)) {
		return {
			ok: false,
			message:
				"This organization declared that it has no VAT number, so none can be recorded. " +
				"Change the declaration in billing first.",
		};
	}
	if (input.type !== "eu_vat") return { ok: true, value };
	const country = input.country?.trim().toUpperCase() ?? "";
	if (!EU_MEMBER_STATES.includes(country)) {
		return { ok: false, message: "An EU VAT number needs an EU billing country on file first." };
	}
	if (!euVatNumberMayBeRecorded(country, input.vatRegistered)) {
		return {
			ok: false,
			message:
				"Alethia cannot yet invoice a business in this country that has a VAT number. " +
				"Request complimentary Early Access from billing instead.",
		};
	}
	const vat = normaliseEuVatNumber(country, value);
	if (!vat) {
		return { ok: false, message: "That is not a VAT number for the billing country." };
	}
	return { ok: true, value: vat.full };
}

/** The org's declared payer facts, or null when it has no billing row. */
async function readPayerFacts(orgId: string) {
	const [row] = await getServiceDb()
		.select({
			capacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
			authorityAttestation: organizationBilling.authorityAttestation,
			vatIdStatus: organizationBilling.vatIdStatus,
			vatId: organizationBilling.vatId,
			billingState: organizationBilling.billingState,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row ?? null;
}

/**
 * Prepares a paid order on `customerId` for `orgId`, BEFORE the mint (see the file header).
 *
 * @param billingAddress the address the sheet collected with the declaration; written to the customer.
 *   Omitted, the customer's existing address is used, and a customer with no complete address refuses.
 */
export async function preparePaidOrder(input: {
	readonly orgId: string;
	readonly userId: string;
	readonly customerId: string;
	readonly billingAddress?: OrderBillingAddressInput | null;
	readonly stripe: Stripe;
}): Promise<PreparedOrder> {
	const facts = await readPayerFacts(input.orgId);
	const capacity = narrowCapacity(facts?.capacity);
	const billingCountry = present(facts?.billingCountry)?.toUpperCase() ?? null;
	if (!facts || !capacity || !billingCountry) {
		throw new PaidOrderRefusedError("Tell us who this purchase is for before subscribing.");
	}
	const billingState = billingCountry === "US" ? present(facts.billingState) : null;
	const vatIdStatus = narrowVatIdStatus(facts.vatIdStatus);

	let address: CommerceBillingAddress;
	let billingName: string;
	if (input.billingAddress) {
		const parsed = orderBillingAddressSchema.safeParse(input.billingAddress);
		if (!parsed.success) {
			throw new PaidOrderRefusedError(
				parsed.error.issues[0]?.message ?? "Check the billing address.",
			);
		}
		const a = parsed.data;
		if (a.country !== billingCountry) {
			throw new PaidOrderRefusedError(
				"The billing address is in a different country from the one declared for this purchase.",
			);
		}
		billingName = a.name;
		address = {
			line1: a.line1,
			line2: present(a.line2),
			city: a.city,
			postalCode: a.postalCode,
			region: billingState ?? present(a.state),
			country: billingCountry,
		};
		await input.stripe.customers.update(input.customerId, {
			name: billingName,
			address: {
				line1: address.line1,
				line2: address.line2 ?? "",
				city: address.city,
				state: address.region ?? "",
				postal_code: address.postalCode,
				country: address.country,
			},
		});
	} else {
		const customer = await input.stripe.customers.retrieve(input.customerId);
		if (customer.deleted) throw new PaidOrderRefusedError("Add a billing address before subscribing.");
		const a = customer.address;
		const line1 = present(a?.line1);
		const city = present(a?.city);
		const postalCode = present(a?.postal_code);
		const country = present(a?.country)?.toUpperCase() ?? null;
		const name = present(customer.name);
		if (!line1 || !city || !postalCode || !country || !name) {
			throw new PaidOrderRefusedError("Add a billing address before subscribing.");
		}
		if (country !== billingCountry) {
			throw new PaidOrderRefusedError(
				"The billing address is in a different country from the one declared for this purchase.",
			);
		}
		billingName = name;
		address = {
			line1,
			line2: present(a?.line2),
			city,
			postalCode,
			region: billingState ?? present(a?.state),
			country,
		};
	}

	const vatId = vatIdStatus === "given" ? present(facts.vatId) : null;
	if (vatId && euVatNumberMayBeRecorded(billingCountry, LEGAL_ENTITY.vatRegistered)) {
		await ensureEuVatTaxId(input.stripe, input.customerId, vatId);
	}

	return {
		organizationId: input.orgId,
		placedByUserId: input.userId,
		capacity,
		authorityAttestation: capacity === "organization" ? present(facts.authorityAttestation) : null,
		billingCountry,
		billingState,
		vatIdStatus,
		vatId,
		billingName,
		billingAddress: address,
	};
}

/**
 * Prepares a paid order for a sale through a MERCHANT OF RECORD (Paddle), BEFORE its checkout opens.
 * The same declared facts and the same refusals as {@link preparePaidOrder}, but nothing is written to
 * a payment provider here: the MoR adapter pre-fills its own customer records from the result.
 *
 * The address is the one the sheet collected; omitted (a credit pack, a team created first), the
 * org's most recent order address is used when it is in the declared country, else a country-only
 * snapshot — Paddle, the seller, collects and invoices the full address itself.
 */
export async function prepareMorOrder(input: {
	readonly orgId: string;
	readonly userId: string;
	readonly billingAddress?: OrderBillingAddressInput | null;
}): Promise<PreparedOrder> {
	const facts = await readPayerFacts(input.orgId);
	const capacity = narrowCapacity(facts?.capacity);
	const billingCountry = present(facts?.billingCountry)?.toUpperCase() ?? null;
	if (!facts || !capacity || !billingCountry) {
		throw new PaidOrderRefusedError("Tell us who this purchase is for before subscribing.");
	}
	const billingState = billingCountry === "US" ? present(facts.billingState) : null;
	const vatIdStatus = narrowVatIdStatus(facts.vatIdStatus);

	let address: CommerceBillingAddress;
	let billingName: string;
	if (input.billingAddress) {
		const parsed = orderBillingAddressSchema.safeParse(input.billingAddress);
		if (!parsed.success) {
			throw new PaidOrderRefusedError(parsed.error.issues[0]?.message ?? "Check the billing address.");
		}
		const a = parsed.data;
		if (a.country !== billingCountry) {
			throw new PaidOrderRefusedError(
				"The billing address is in a different country from the one declared for this purchase.",
			);
		}
		billingName = a.name;
		address = {
			line1: a.line1,
			line2: present(a.line2),
			city: a.city,
			postalCode: a.postalCode,
			region: billingState ?? present(a.state),
			country: billingCountry,
		};
	} else {
		const last = await latestOrderAddress(input.orgId);
		if (last && last.address.country === billingCountry) {
			address = last.address;
			billingName = last.name;
		} else {
			// No address collected and none on file (a team created first, O2). The merchant of record
			// collects the full address in its checkout and invoices with it; our record keeps the declared
			// country — the fact the gate judged — and the org's name, and says nothing it was not told.
			address = { line1: "", line2: null, city: "", postalCode: "", region: billingState, country: billingCountry };
			billingName = (await orgNameOf(input.orgId)) ?? "";
		}
	}

	return {
		organizationId: input.orgId,
		placedByUserId: input.userId,
		capacity,
		authorityAttestation: capacity === "organization" ? present(facts.authorityAttestation) : null,
		billingCountry,
		billingState,
		vatIdStatus,
		vatId: vatIdStatus === "given" ? present(facts.vatId) : null,
		billingName,
		billingAddress: address,
	};
}

/**
 * The address snapshot of the org's most recent order, with the org's name as the name to bill —
 * the order row stores no billing name of its own.
 */
async function latestOrderAddress(
	orgId: string,
): Promise<{ address: CommerceBillingAddress; name: string } | null> {
	const [row] = await getServiceDb()
		.select({ address: commerceOrder.billingAddress, orgName: organization.name })
		.from(commerceOrder)
		.innerJoin(organization, eq(organization.id, commerceOrder.organizationId))
		.where(eq(commerceOrder.organizationId, orgId))
		.orderBy(desc(commerceOrder.placedAt))
		.limit(1);
	return row ? { address: row.address, name: row.orgName } : null;
}

/** The organization's name, or null when it does not exist. */
async function orgNameOf(orgId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	return row?.name ?? null;
}

/** Puts `vatId` on the customer as its one `eu_vat` tax id, leaving it alone when it is already there. */
async function ensureEuVatTaxId(stripe: Stripe, customerId: string, vatId: string): Promise<void> {
	const existing = await stripe.customers.listTaxIds(customerId, { limit: 5 });
	if (existing.data.some((t) => t.type === "eu_vat" && t.value === vatId)) return;
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(customerId, t.id);
	}
	await stripe.customers.createTaxId(customerId, { type: "eu_vat", value: vatId });
}

/** The acceptance-required documents in force now, with version and hash, for the order snapshot. */
function documentsInForce(): CommerceDocumentVersions {
	return {
		documents: LEGAL_DOCUMENTS.filter((d) => d.acceptanceRequired).map((d) => ({
			id: d.id,
			version: d.version,
			hash: d.contentHash,
		})),
	};
}

/** What was charged, for the order row. */
export interface PaidOrderCharge {
	/** The plan or product, as the product names it (`team`, `ai_plus`, `ai_credits:<pack>`). */
	readonly productId: string;
	/** The first invoice's total, tax-inclusive, in minor units. */
	readonly totalMinorUnits: number;
	readonly currency: string;
	/** The billed period in days; 0 for a one-time purchase. */
	readonly periodDays: number;
	readonly renewsAutomatically: boolean;
	readonly stripeSubscriptionId?: string | null;
	readonly stripePaymentIntentId?: string | null;
	/** The provider the order is placed through; Stripe when omitted (the column's default). */
	readonly provider?: BillingProviderId;
}

/**
 * Writes the `commerce_order` row for a successful mint and returns its id. `vatIdCommunicated` is
 * true exactly when the organization declared `given`: a buyer that declared "no VAT number" reads
 * `false` here whatever else is on file. Throws when the write fails — the caller closes out its mint.
 */
export async function recordPaidOrder(
	order: PreparedOrder,
	charge: PaidOrderCharge,
): Promise<string> {
	const [row] = await getServiceDb()
		.insert(commerceOrder)
		.values({
			organizationId: order.organizationId,
			placedByUserId: order.placedByUserId,
			capacity: order.capacity,
			authorityAttestation: order.authorityAttestation,
			billingCountry: order.billingCountry,
			billingAddress: order.billingAddress,
			taxId: order.vatId,
			vatIdCommunicated: order.vatIdStatus === "given",
			totalMinorUnits: charge.totalMinorUnits,
			currency: charge.currency.toLowerCase(),
			productId: charge.productId,
			periodDays: charge.periodDays,
			renewsAutomatically: charge.renewsAutomatically,
			// Cancellation takes effect at the end of the paid period; no notice is required.
			cancellationNoticeDays: 0,
			documentVersions: documentsInForce(),
			stripeSubscriptionId: charge.stripeSubscriptionId ?? null,
			stripePaymentIntentId: charge.stripePaymentIntentId ?? null,
			...(charge.provider ? { provider: charge.provider } : {}),
		})
		.returning({ id: commerceOrder.id });
	if (!row) throw new Error("The order record was not written.");
	return row.id;
}

/** Links a Paddle order to the checkout transaction opened for it. */
export async function attachPaddleTransaction(orderId: string, transactionId: string): Promise<void> {
	await getServiceDb()
		.update(commerceOrder)
		.set({ paddleTransactionId: transactionId, updatedAt: new Date() })
		.where(and(eq(commerceOrder.id, orderId), eq(commerceOrder.provider, "paddle")));
}

/**
 * Marks an order whose checkout could not be opened as `cancelled`: nothing payable exists for it.
 * Kept, not deleted — the row records what was offered and when.
 */
export async function cancelUnopenedOrder(orderId: string): Promise<void> {
	await getServiceDb()
		.update(commerceOrder)
		.set({ state: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
		.where(and(eq(commerceOrder.id, orderId), eq(commerceOrder.state, "placed")));
}
