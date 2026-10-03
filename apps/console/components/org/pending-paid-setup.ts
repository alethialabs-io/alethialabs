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
// is removed only once the LAST step, the payer declaration, has succeeded.
//
// THE RECORD IS A HINT; THE SERVER IS THE AUTHORITY. The server keeps its own record of the setup
// (`pending_org_setups`, lib/billing/pending-org-setup.ts), written when the subscription is minted —
// before the charge — and stamped as each step lands. Every run starts by asking the server where the
// setup stands (`resolveNewOrgSetup`): which organization this user already created for the
// subscription, and whether the subscription is linked to it. The browser cannot know that by itself
// — a create whose response was lost (a reload, a dropped connection) leaves an organization on the
// server and `createdOrgId: null` here, and trusting the record created a second one. The server finds
// that organization by its record, or by a marker its own create hook stamps in the same insert as the
// organization row — never by the owner member row, which better-auth inserts in a SEPARATE statement
// that can fail; an organization left with no member is repaired with the payer as owner rather than
// made again. Every step is idempotent against that answer: an org found is reused, a second create for
// the same charge is refused by the server, a link already written is completed rather than refused,
// and the declaration is an upsert.
//
// The slug and the billing details typed at checkout are sent to the server record BEFORE the card is
// confirmed (the checkout form's `beforeConfirm`), and again at the start of each run, so a setup
// finished from ANY tab — `findUnfinishedNewOrgSetup` reads the record by user, no browser copy and no
// search index involved — still creates at the chosen URL, sends the tax id and honours "use as the
// team's address". The typed authority attestation is the one thing it does not
// keep: a recovered setup asks the payer to declare again, through the same gate as a purchase.

// The steps themselves run here, outside the sheet's React state, for the same reason: a close while
// they are in flight must not orphan them. `finishPaidSetup` keeps one run per subscription, so a
// reopened sheet attaches to a run still in flight instead of starting a second one beside it. A run
// that ends while no sheet is watching it says so in a toast: success, or that the payment is safe
// and Create a team finishes it.
//
// sessionStorage, not localStorage: the record carries the billing address the customer typed, and it
// should not outlive the tab. Storage that throws (a private window, blocked site data) falls back to
// a module-level copy, which survives the sheet closing and unmounting but not a page reload; the
// close confirmation says which of the two this tab has.

import { toast } from "sonner";
import { z } from "zod";
import {
	attachTaxIdToCustomer,
	findUnfinishedNewOrgSetup,
	linkSubscriptionToNewOrg,
	resolveNewOrgSetup,
	saveNewOrgSetupDetails,
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
import {
	NEW_ORG_SETUP_IN_PROGRESS_CODE,
	NEW_ORG_SETUP_ORG_EXISTS_CODE,
	NEW_ORG_SUBSCRIPTION_KEY,
	type NewOrgSetupState,
} from "@/lib/billing/new-org-setup";
import { TAX_ID_TYPES, type TaxIdType } from "@/lib/billing/tax-ids";
import {
	ORG_SLUG_RESERVED_CODE,
	ORG_SLUG_RESERVED_MESSAGE,
} from "@/lib/routing";
import { PAYER_CAPACITIES, type PayerCapacity } from "@repo/legal/commerce";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@repo/plan-catalog";

/** The sentence for a slug that is in use — the same one `configureOnboardingOrg` returns. */
export const SLUG_TAKEN = "That slug is taken — try another.";

/** What a run that failed says when no sheet is open to show it: the payment is safe, and where to finish. */
export const UNATTENDED_FAILURE =
	"Your payment went through, but we couldn't finish setting up your team. Open Create a team to finish — you won't be charged again.";

/** What a slug refused after payment says when no sheet is open to show it. */
export const UNATTENDED_SLUG_REFUSAL =
	"Your payment went through, but your team couldn't be created at the URL you chose. Open Create a team to choose another — you won't be charged again.";

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
	/**
	 * The billing details typed at checkout, or null for a setup recovered from the server with no
	 * browser record — Stripe then has the address from the payment method, and nothing is re-sent.
	 */
	billing: CollectedBilling | null;
	/** The billing address (and tax id) were sent to the Stripe customer. */
	customerDetailsSaved: boolean;
	/** The org this setup created, as last seen. A hint: every run asks the server first. */
	createdOrgId: string | null;
	createdSlug: string;
	/** The link step returned successfully for `createdOrgId`. A hint, re-checked against the server. */
	linked: boolean;
	/**
	 * The sentence the create refused the slug with after payment, or null. The sheet then asks for a
	 * new slug and shows this under the field — kept here so a resumed sheet can still say why.
	 */
	slugRefusal: string | null;
}

const billingSchema = z.object({
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
});

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
	billing: billingSchema.nullable(),
	customerDetailsSaved: z.boolean(),
	createdOrgId: z.string().nullable(),
	createdSlug: z.string(),
	linked: z.boolean(),
	slugRefusal: z.string().nullable(),
});

/** The two ids that identify the charge — all a record that no longer parses can still give the server. */
const idsSchema = z.object({
	subscriptionId: z.string().min(1),
	customerId: z.string().min(1),
});

/**
 * The copy for a tab whose storage threw on the LAST write: one record per user, held for the
 * page's lifetime. It exists only because a later write failed, so whenever it is present it is
 * newer than anything sessionStorage holds, and it is read first.
 */
const memoryFallback = new Map<string, PendingPaidSetup>();

/** The sessionStorage key for one user's pending setup — per user, so a second account in the tab never sees it. */
export function pendingPaidSetupKey(userId: string): string {
	return `alethia:create-team:paid-setup:${userId}`;
}

/** What this tab holds for a user: nothing, a record, or a record that no longer parses (with any ids it still carries). */
export type StoredPaidSetup =
	| { kind: "none" }
	| { kind: "ok"; record: PendingPaidSetup }
	| { kind: "unreadable"; ids: { subscriptionId: string; customerId: string } | null };

/** Reads what this tab holds for the user — the in-page copy first (it is the newer), then sessionStorage. */
export function readStoredPaidSetup(userId: string): StoredPaidSetup {
	if (!userId) return { kind: "none" };
	const inPage = memoryFallback.get(userId);
	if (inPage) return { kind: "ok", record: inPage };
	let raw: string | null;
	try {
		raw = window.sessionStorage.getItem(pendingPaidSetupKey(userId));
	} catch {
		return { kind: "none" };
	}
	if (!raw) return { kind: "none" };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { kind: "unreadable", ids: null };
	}
	const parsed = pendingSchema.safeParse(json);
	if (parsed.success) return { kind: "ok", record: parsed.data };
	const ids = idsSchema.safeParse(json);
	return { kind: "unreadable", ids: ids.success ? ids.data : null };
}

/** Reads the user's pending paid setup, or null when there is none or it does not parse. */
export function readPendingPaidSetup(userId: string): PendingPaidSetup | null {
	const stored = readStoredPaidSetup(userId);
	return stored.kind === "ok" ? stored.record : null;
}

/**
 * Writes the user's pending paid setup — to sessionStorage, or to the in-page copy when storage
 * throws. Returns false when there is no user to key it by, so a caller can refuse rather than carry
 * on as if it were kept.
 */
export function writePendingPaidSetup(userId: string, setup: PendingPaidSetup): boolean {
	if (!userId) return false;
	try {
		window.sessionStorage.setItem(pendingPaidSetupKey(userId), JSON.stringify(setup));
		memoryFallback.delete(userId);
	} catch {
		memoryFallback.set(userId, setup);
	}
	return true;
}

/** True when the user's record lives only in this page (storage threw), so a reload loses it. */
export function pendingPaidSetupInPageOnly(userId: string): boolean {
	return memoryFallback.has(userId);
}

/** Removes the user's pending paid setup — once the payer declaration, the last step, succeeded. */
function clearPendingPaidSetup(userId: string): void {
	memoryFallback.delete(userId);
	try {
		window.sessionStorage.removeItem(pendingPaidSetupKey(userId));
	} catch {
		// Storage unavailable — the in-page copy above was the only one.
	}
}

/** What the server said about an unfinished paid setup: one to resume, none, or it could not be asked. */
export type RecoveredPaidSetup =
	| { kind: "found"; state: NewOrgSetupState }
	| { kind: "none" }
	| { kind: "unavailable" };

/**
 * Asks the server for a paid setup this user never finished, for a sheet opened with no usable
 * record. `ids` (from a record that no longer parses) is asked about directly; without them the server
 * reads the user's own setup records. A question that FAILED is reported as such, never as "none":
 * "none" lets the sheet offer a purchase, and the outage may be hiding one already paid.
 */
export async function recoverUnfinishedPaidSetup(
	ids: { subscriptionId: string; customerId: string } | null,
): Promise<RecoveredPaidSetup> {
	try {
		const state = ids ? await resolveNewOrgSetup(ids) : await findUnfinishedNewOrgSetup();
		if (!state || !state.paid || (state.linked && state.declared)) return { kind: "none" };
		return { kind: "found", state };
	} catch {
		return { kind: "unavailable" };
	}
}

/** How a run of the post-payment steps ended. Every non-`done` outcome carries the record to resume from. */
export type PaidSetupOutcome =
	| { kind: "done"; orgId: string; slug: string }
	| { kind: "slug-refused"; message: string; record: PendingPaidSetup }
	| {
			kind: "failed";
			message: string;
			record: PendingPaidSetup;
			/** False when retrying cannot help (the subscription is not this account's); `message` says what to do. */
			retryable: boolean;
	  };

/** The run in flight for each subscription, so a reopened sheet attaches to it rather than racing it. */
const runs = new Map<string, Promise<PaidSetupOutcome>>();

/** How many open sheets are showing each subscription's setup — the ones that will render its outcome. */
const watchers = new Map<string, number>();

/** The run still in flight for this subscription, if any. */
export function paidSetupInFlight(subscriptionId: string): Promise<PaidSetupOutcome> | undefined {
	return runs.get(subscriptionId);
}

/**
 * Registers an open sheet as showing this subscription's setup, so a run that ends renders there
 * instead of in a toast. Returns the unregister function; calling it more than once is harmless.
 */
export function watchPaidSetup(subscriptionId: string): () => void {
	watchers.set(subscriptionId, (watchers.get(subscriptionId) ?? 0) + 1);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const left = (watchers.get(subscriptionId) ?? 1) - 1;
		if (left > 0) watchers.set(subscriptionId, left);
		else watchers.delete(subscriptionId);
	};
}

/** What a run reports back to the sheet that started it. */
interface RunHooks {
	/** Called with the record after each step is persisted — the sheet mirrors it while it is open. */
	onProgress: (record: PendingPaidSetup) => void;
	/** Refreshes the workspace switcher once the org is fully set up. */
	fetchWorkspace: () => Promise<unknown>;
}

/**
 * Runs the post-payment steps for `start`, resuming at the first one the SERVER says has not
 * completed. One run per subscription: a call while another is in flight waits for it, then
 * continues from the record that run left behind.
 *
 * When the run ends and no open sheet is watching it (`watchPaidSetup`), a non-`done` outcome is
 * toasted with what is true — the payment is safe, and Create a team finishes it — so a customer
 * who chose "Close for now" is never left with silence. `done` toasts on its own.
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
		const outcome = await runSteps(userId, record, hooks);
		if (outcome.kind !== "done") {
			if (!watchers.get(start.subscriptionId)) {
				const message =
					outcome.kind === "slug-refused"
						? UNATTENDED_SLUG_REFUSAL
						: outcome.retryable
							? UNATTENDED_FAILURE
							: outcome.message;
				toast.error(message, { duration: Number.POSITIVE_INFINITY });
			} else if (outcome.kind === "failed") {
				toast.error(outcome.message);
			}
		}
		return outcome;
	})();
	runs.set(start.subscriptionId, run);
	void run.finally(() => {
		if (runs.get(start.subscriptionId) === run) runs.delete(start.subscriptionId);
	});
	return run;
}

/** The words for a setup field the server refused, as the customer knows it from the form. */
function fieldLabel(field: string): string {
	switch (field) {
		case "slug":
			return "the team URL";
		case "taxValue":
		case "taxType":
			return "the tax ID";
		case "postalCode":
			return "the postal code";
		case "name":
			return "the cardholder name";
		default:
			return "the billing address";
	}
}

/** Thrown inside a run for a refusal whose sentence is the customer's to read. */
class SetupStopped extends Error {}

/** The refusal sentence for a create that failed, or null when the failure is not about the slug. */
function slugRefusalOf(error: { code?: string; message?: string } | null): string | null {
	// The server's reserved-slug hook (ee/) answers with its own code: say RESERVED, not taken.
	// Checked first because its sentence contains "slug", which the pattern below would read as a
	// collision.
	if (error?.code === ORG_SLUG_RESERVED_CODE) return ORG_SLUG_RESERVED_MESSAGE;
	return /slug|unique|exist|taken/i.test(error?.message ?? "") ? SLUG_TAKEN : null;
}

/** The four post-payment steps, each persisted before the next one starts, each idempotent. */
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
	const ids = { subscriptionId: record.subscriptionId, customerId: record.customerId };
	let finishedOrgId = "";
	try {
		// The slug and the checkout details onto the SERVER's record, so a resume from another tab
		// restores them. The checkout already saved them before the charge; this run re-saves because the
		// slug can have changed since (a refusal after payment). A field the server refuses is SAID —
		// the steps below still run on this tab's copy, but a resume elsewhere would not have it. A
		// failed call is not: this tab's record still carries everything, and the pre-charge save holds
		// the server's copy.
		try {
			const saved = await saveNewOrgSetupDetails({
				subscriptionId: record.subscriptionId,
				slug: record.slug,
				billing: record.billing,
			});
			if (!saved.ok) {
				toast.warning(
					`We couldn't keep ${saved.refused.map((r) => fieldLabel(r.field)).join(", ")} for finishing this setup from another tab (${saved.refused[0]?.message ?? "refused"}). This tab still has it.`,
				);
			}
		} catch {
			// Kept in this tab's record, and in the server's copy saved before the charge.
		}
		if (!record.customerDetailsSaved) {
			if (record.billing) {
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
			}
			save({ ...record, customerDetailsSaved: true });
		}

		// Where the setup stands, by the server's account. The record's `createdOrgId` and `linked`
		// are what this browser last SAW; the server's answer is what HAPPENED, including a create or
		// a link whose response never arrived.
		const server = await resolveNewOrgSetup(ids);
		if (!server) {
			throw new SetupStopped(
				"Your payment went through, but it isn't tied to this account. Contact support with the time of the payment — you won't be charged again.",
			);
		}
		let orgId = server.org?.id ?? null;
		if (server.org) {
			if (record.createdOrgId !== server.org.id) {
				save({ ...record, createdOrgId: server.org.id, createdSlug: server.org.slug });
			}
		} else if (record.createdOrgId) {
			// The browser remembers an org the server cannot find for this subscription (deleted
			// since). The server wins: create one.
			save({ ...record, createdOrgId: null, createdSlug: "", linked: false });
		}

		if (!orgId) {
			const { data: org, error } = await authClient.organization.create({
				name: record.name,
				slug: record.slug,
				// Written in the SAME insert as the org row: how the server finds this org again if
				// the response to this request is lost (lib/billing/new-org-setup.ts).
				metadata: { [NEW_ORG_SUBSCRIPTION_KEY]: record.subscriptionId },
			});
			if (org) {
				orgId = org.id;
				save({ ...record, createdOrgId: org.id, createdSlug: org.slug ?? record.slug });
			} else {
				// Refused — but possibly because an earlier create for THIS subscription already took
				// the slug (a response lost in a run still in flight elsewhere). Ask before refusing.
				const again = await resolveNewOrgSetup(ids);
				if (again?.org) {
					orgId = again.org.id;
					save({ ...record, createdOrgId: again.org.id, createdSlug: again.org.slug });
				} else if (error?.code === NEW_ORG_SETUP_IN_PROGRESS_CODE) {
					// Another create for this charge holds the claim right now (a second tab, or the
					// first attempt still in flight). A retry finds the team it makes.
					throw new Error(error.message ?? "This team is already being set up.");
				} else if (error?.code === NEW_ORG_SETUP_ORG_EXISTS_CODE) {
					// The server holds an organization for this charge that this account is not in
					// (someone else joined it, or it was left to them). Creating another is refused,
					// by design; this is for support to untangle.
					throw new SetupStopped(
						"Your payment went through and a team was already created for it, but this account isn't in it. Contact support with the time of the payment — you won't be charged again.",
					);
				} else {
					const message = slugRefusalOf(error);
					if (message === null) {
						throw new Error(error?.message ?? "Couldn't create the organization");
					}
					save({ ...record, slugRefusal: message });
					return { kind: "slug-refused", message, record };
				}
			}
			await setActiveOrganization(orgId);
		}

		const linkedOnServer = server.linked && server.org?.id === orgId;
		if (!record.linked || !linkedOnServer) {
			// Idempotent for this org: a link whose Stripe writes landed before a failure completes
			// the billing sync and the payer write instead of being refused.
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
		// because both writes would succeed. An upsert, so a repeat is harmless.
		await declarePayer(record.declaration, { orgId });
		clearPendingPaidSetup(userId);
		finishedOrgId = orgId;
	} catch (e) {
		if (e instanceof SetupStopped) {
			return { kind: "failed", message: e.message, record, retryable: false };
		}
		return {
			kind: "failed",
			message:
				"Your payment went through, but we couldn't finish setting up the team. Retry to complete setup — you won't be charged again.",
			record,
			retryable: true,
		};
	}

	// Setup is complete; what follows is best-effort and never re-opens the record.
	await hooks.fetchWorkspace().catch(() => {});
	if (record.billing?.useAsPrimary) {
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
