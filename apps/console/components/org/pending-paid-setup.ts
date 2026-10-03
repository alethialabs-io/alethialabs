// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A paid-but-unfinished team setup, kept across a closed create-a-team sheet (#5445).
//
// The create-a-team sheet charges FIRST and then runs four steps against the charge: save the billing
// details on the Stripe customer, create the organization, link the subscription to it, and record the
// payer declaration on it. The sheet used to hold the only references that tie the charge to the team
// it was for — the Stripe subscription and customer ids — in React state, and closing the sheet
// `reset()` that state. A customer who had just paid was left with a live subscription and no
// organization, and reopening the sheet started a NEW purchase.
//
// So the record below is written the moment the charge is confirmed — before any of the four steps
// runs — and rewritten as each step completes (`customerDetailsSaved`, `createdOrgId`, `linked`). It
// is removed only once the LAST step, the payer declaration, has succeeded. Reopening the sheet reads
// it back and resumes at the first step that has not completed: an org already created is linked,
// never created a second time; a subscription already linked is declared, never linked again; and the
// payer's typed attestation rides in `declaration` all the way to `declarePayer`.
//
// The steps themselves run here, outside the sheet's React state, for the same reason: a close while
// they are in flight must not orphan them. `finishPaidSetup` keeps one run per subscription, so a
// reopened sheet attaches to a run still in flight instead of starting a second one beside it.
//
// sessionStorage, not localStorage: the record carries the billing address the customer typed, and it
// should not outlive the tab. That bound is stated in the sheet's close confirmation, which is what the
// customer reads before closing.
//
// What it is NOT: a server-side record. sessionStorage is scoped to the tab, so closing the tab is not
// covered by this file; the sheet's `beforeunload` prompt is what warns about that. Storage that throws
// (a private window, blocked site data) falls back to a module-level copy, which survives the sheet
// closing and unmounting but not a page reload.

import { toast } from "sonner";
import { z } from "zod";
import {
	attachTaxIdToCustomer,
	linkSubscriptionToNewOrg,
	setCustomerBillingAddress,
} from "@/app/server/actions/billing";
import { declarePayer } from "@/app/server/actions/legal";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import {
	billingAddressFrom,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import type { PayerDeclaration } from "@/components/billing/payer-declaration-form";
import { authClient } from "@/lib/auth/client";
import { TAX_ID_TYPES, type TaxIdType } from "@/lib/billing/tax-ids";
import {
	ORG_SLUG_RESERVED_CODE,
	ORG_SLUG_RESERVED_MESSAGE,
} from "@/lib/routing";
import { PAYER_CAPACITIES, type PayerCapacity } from "@repo/legal/commerce";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@repo/plan-catalog";

/** The sentence for a slug that is in use — the same one `configureOnboardingOrg` returns. */
export const SLUG_TAKEN = "That slug is taken — try another.";

/** Everything needed to finish a paid setup without a second charge, and how far it has got. */
export interface PendingPaidSetup {
	subscriptionId: string;
	customerId: string;
	/** The team name and the slug to create it at — restored into the sheet's form. */
	name: string;
	slug: string;
	currency: SupportedCurrency;
	/** The payer facts, including the authority attestation `declarePayer` records last. */
	declaration: PayerDeclaration;
	billing: CollectedBilling;
	/** The billing address (and tax id) were sent to the Stripe customer. */
	customerDetailsSaved: boolean;
	/** Set once the org exists: every later attempt links THIS org, never creates another. */
	createdOrgId: string | null;
	createdSlug: string;
	/** The subscription is linked to `createdOrgId`: a later attempt goes straight to the declaration. */
	linked: boolean;
	/**
	 * The sentence the create refused the slug with after payment, or null. The sheet then asks for a
	 * new slug and shows this under the field — kept here so a resumed sheet can still say why.
	 */
	slugRefusal: string | null;
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
	customerDetailsSaved: z.boolean(),
	createdOrgId: z.string().nullable(),
	createdSlug: z.string(),
	linked: z.boolean(),
	slugRefusal: z.string().nullable(),
});

/**
 * The fallback for a tab whose storage throws: one record per user, held for the page's lifetime. It
 * is consulted ONLY when storage itself fails, so a working sessionStorage stays the single source.
 */
const memoryFallback = new Map<string, PendingPaidSetup>();

/** The sessionStorage key for one user's pending setup — per user, so a second account in the tab never sees it. */
export function pendingPaidSetupKey(userId: string): string {
	return `alethia:create-team:paid-setup:${userId}`;
}

/** Reads the user's pending paid setup, or null when there is none or it is malformed. */
export function readPendingPaidSetup(userId: string): PendingPaidSetup | null {
	if (!userId) return null;
	let raw: string | null;
	try {
		raw = window.sessionStorage.getItem(pendingPaidSetupKey(userId));
	} catch {
		return memoryFallback.get(userId) ?? null;
	}
	if (!raw) return memoryFallback.get(userId) ?? null;
	try {
		const parsed = pendingSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Writes the user's pending paid setup — to sessionStorage, or to the in-page fallback when storage throws. */
export function writePendingPaidSetup(userId: string, setup: PendingPaidSetup): void {
	if (!userId) return;
	try {
		window.sessionStorage.setItem(pendingPaidSetupKey(userId), JSON.stringify(setup));
		memoryFallback.delete(userId);
	} catch {
		memoryFallback.set(userId, setup);
	}
}

/** Removes the user's pending paid setup — called once the payer declaration, the last step, succeeded. */
function clearPendingPaidSetup(userId: string): void {
	memoryFallback.delete(userId);
	try {
		window.sessionStorage.removeItem(pendingPaidSetupKey(userId));
	} catch {
		// Storage unavailable — the fallback above was the only copy.
	}
}

/** How a run of the post-payment steps ended. Every non-`done` outcome carries the record to resume from. */
export type PaidSetupOutcome =
	| { kind: "done"; orgId: string; slug: string }
	| { kind: "slug-refused"; message: string; record: PendingPaidSetup }
	| { kind: "failed"; message: string; record: PendingPaidSetup };

/** The run in flight for each subscription, so a reopened sheet attaches to it rather than racing it. */
const runs = new Map<string, Promise<PaidSetupOutcome>>();

/** The run still in flight for this subscription, if any. */
export function paidSetupInFlight(subscriptionId: string): Promise<PaidSetupOutcome> | undefined {
	return runs.get(subscriptionId);
}

/** What a run reports back to the sheet that started it. */
interface RunHooks {
	/** Called with the record after each step is persisted — the sheet mirrors it while it is open. */
	onProgress: (record: PendingPaidSetup) => void;
	/** Refreshes the workspace switcher once the org is fully set up. */
	fetchWorkspace: () => Promise<unknown>;
}

/**
 * Runs the post-payment steps for `start`, resuming at the first one not yet completed. One run per
 * subscription: a call while another is in flight waits for it, then continues from the record that
 * run left behind (its org, its link), so two calls can never create two orgs for one charge.
 */
export function finishPaidSetup(
	userId: string,
	start: PendingPaidSetup,
	hooks: RunHooks,
): Promise<PaidSetupOutcome> {
	const prior = runs.get(start.subscriptionId);
	const run = (async (): Promise<PaidSetupOutcome> => {
		let record = start;
		if (prior) {
			const before = await prior;
			if (before.kind === "done") return before;
			// The earlier run advanced the record; keep its progress and this call's slug.
			record = { ...before.record, slug: start.slug, name: start.name };
		}
		return runSteps(userId, record, hooks);
	})();
	runs.set(start.subscriptionId, run);
	void run.finally(() => {
		if (runs.get(start.subscriptionId) === run) runs.delete(start.subscriptionId);
	});
	return run;
}

/** The four post-payment steps, each persisted before the next one starts. */
async function runSteps(
	userId: string,
	start: PendingPaidSetup,
	hooks: RunHooks,
): Promise<PaidSetupOutcome> {
	let record: PendingPaidSetup = { ...start, slugRefusal: null };
	/** Persists the record and reports it to the sheet. */
	const save = (next: PendingPaidSetup) => {
		record = next;
		writePendingPaidSetup(userId, next);
		hooks.onProgress(next);
	};
	save(record);
	let finishedOrgId = "";
	try {
		if (!record.customerDetailsSaved) {
			try {
				await setCustomerBillingAddress({
					customerId: record.customerId,
					address: billingAddressFrom(record.billing),
				});
			} catch {
				// Non-fatal — Stripe still has the address from the payment method.
			}
			if (record.billing.taxValue.trim()) {
				try {
					await attachTaxIdToCustomer({
						customerId: record.customerId,
						type: record.billing.taxType,
						value: record.billing.taxValue,
					});
				} catch {
					toast.warning("Couldn't save the tax id — add it later in billing.");
				}
			}
			save({ ...record, customerDetailsSaved: true });
		}

		let orgId = record.createdOrgId;
		if (!orgId) {
			const { data: org, error } = await authClient.organization.create({
				name: record.name,
				slug: record.slug,
			});
			if (error || !org) {
				// The server's reserved-slug hook (ee/) answers with its own code: say RESERVED, not
				// taken. Checked first because its sentence contains "slug", which the pattern below
				// would read as a collision.
				const message =
					error?.code === ORG_SLUG_RESERVED_CODE
						? ORG_SLUG_RESERVED_MESSAGE
						: /slug|unique|exist|taken/i.test(error?.message ?? "")
							? SLUG_TAKEN
							: null;
				if (message === null) {
					throw new Error(error?.message ?? "Couldn't create the organization");
				}
				save({ ...record, slugRefusal: message });
				return { kind: "slug-refused", message, record };
			}
			orgId = org.id;
			save({ ...record, createdOrgId: org.id, createdSlug: org.slug ?? record.slug });
			await setActiveOrganization(org.id);
		}

		if (!record.linked) {
			await linkSubscriptionToNewOrg({
				orgId,
				subscriptionId: record.subscriptionId,
				customerId: record.customerId,
				payer: {
					capacity: record.declaration.capacity,
					billingCountry: record.declaration.billingCountry,
				},
			});
			save({ ...record, linked: true });
		}

		// Completes the record with the attestation, which `linkSubscriptionToNewOrg` does not
		// carry. NAMED org, never ambient: the sheet is open on a page inside the CURRENT org, so an
		// ambient declaration would land on the old one — the #4133 failure, which is silent here
		// because both writes would succeed.
		await declarePayer(record.declaration, { orgId });
		clearPendingPaidSetup(userId);
		finishedOrgId = orgId;
	} catch (e) {
		const message =
			e instanceof Error
				? e.message
				: "Payment succeeded but setup failed — retry, you won't be charged again.";
		toast.error(message);
		return { kind: "failed", message, record };
	}

	// Setup is complete; what follows is best-effort and never re-opens the record.
	await hooks.fetchWorkspace().catch(() => {});
	if (record.billing.useAsPrimary) {
		try {
			// The org just created — ambient here is the page's org.
			await updateOrgPrimaryAddress(billingAddressFrom(record.billing), finishedOrgId);
		} catch {
			toast.warning("Couldn't save the billing address as the team's address — set it in settings.");
		}
	}
	toast.success("Subscription active — your organization is ready.");
	return { kind: "done", orgId: finishedOrgId, slug: record.createdSlug };
}
