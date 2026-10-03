// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A paid-but-unfinished team setup, kept across a closed create-a-team sheet (#5445).
//
// The create-a-team sheet charges FIRST and creates the organization after. When the create or the
// link then fails, the sheet holds the only references that tie the charge to the team it was for —
// the Stripe subscription and customer ids — in React state. Closing the sheet used to `reset()`
// that state, so a customer who had just paid was left with a live subscription and no organization,
// and reopening the sheet started a NEW purchase, contradicting the "you won't be charged again" it
// had just shown.
//
// So the pending setup is written to the tab's sessionStorage while it is pending, read back when the
// sheet opens, and removed only once the subscription is linked. sessionStorage, not localStorage:
// the record carries the billing address the customer typed, and it should not outlive the tab. That
// bound is stated in the sheet's close confirmation, which is what the customer reads before closing.
//
// What it is NOT: a server-side record. sessionStorage is scoped to the tab, so closing the tab is not
// covered by this file; the sheet's `beforeunload` prompt is what warns about that. Storage
// that throws or is absent (a private window, blocked site data) degrades to that same in-memory
// behaviour — the confirmation still runs — rather than failing the sheet.

import { z } from "zod";
import type { CollectedBilling } from "@/components/billing/billing-checkout-form";
import type { PayerDeclaration } from "@/components/billing/payer-declaration-form";
import { TAX_ID_TYPES, type TaxIdType } from "@/lib/billing/tax-ids";
import { PAYER_CAPACITIES, type PayerCapacity } from "@repo/legal/commerce";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@repo/plan-catalog";

/** Everything `handlePaid` needs to finish a setup without a second charge. */
export interface PendingPaidSetup {
	subscriptionId: string;
	customerId: string;
	/** The team name and the slug last tried — restored into the sheet's form. */
	name: string;
	slug: string;
	currency: SupportedCurrency;
	declaration: PayerDeclaration;
	billing: CollectedBilling;
	/** Set when the org was created and the LINK failed: the retry must link this org, not create another. */
	createdOrgId: string | null;
	createdSlug: string;
	/** Whether the slug was refused at the create after payment (the sheet then asks for a new one). */
	slugClaimedAfterPayment: boolean;
}

const pendingSchema = z.object({
	subscriptionId: z.string().min(1),
	customerId: z.string().min(1),
	name: z.string(),
	slug: z.string(),
	currency: z.enum(SUPPORTED_CURRENCIES),
	declaration: z.object({
		capacity: z.custom<PayerCapacity>(
			(v) => typeof v === "string" && PAYER_CAPACITIES.some((c) => c === v),
		),
		billingCountry: z.string(),
		authorityAttestation: z.string().nullable(),
	}),
	billing: z.object({
		name: z.string(),
		line1: z.string(),
		line2: z.string().optional(),
		city: z.string(),
		state: z.string().optional(),
		postalCode: z.string(),
		country: z.string(),
		taxType: z.custom<TaxIdType>(
			(v) => typeof v === "string" && TAX_ID_TYPES.some((t) => t.value === v),
		),
		taxValue: z.string(),
		useAsPrimary: z.boolean(),
	}),
	createdOrgId: z.string().nullable(),
	createdSlug: z.string(),
	slugClaimedAfterPayment: z.boolean(),
});

/** The sessionStorage key for one user's pending setup — per user, so a second account in the tab never sees it. */
export function pendingPaidSetupKey(userId: string): string {
	return `alethia:create-team:paid-setup:${userId}`;
}

/** Reads the user's pending paid setup, or null when there is none, it is malformed, or storage is unavailable. */
export function readPendingPaidSetup(userId: string): PendingPaidSetup | null {
	try {
		const raw = window.sessionStorage.getItem(pendingPaidSetupKey(userId));
		if (!raw) return null;
		const parsed = pendingSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Writes the user's pending paid setup; a storage failure is swallowed (see the file header). */
export function writePendingPaidSetup(userId: string, setup: PendingPaidSetup): void {
	try {
		window.sessionStorage.setItem(pendingPaidSetupKey(userId), JSON.stringify(setup));
	} catch {
		// Storage unavailable — the in-memory state and the close confirmation still hold.
	}
}

/** Removes the user's pending paid setup — called once the subscription is linked to its org. */
export function clearPendingPaidSetup(userId: string): void {
	try {
		window.sessionStorage.removeItem(pendingPaidSetupKey(userId));
	} catch {
		// Nothing to clear when storage is unavailable.
	}
}
