// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server-side record of a paid create-a-team setup (#5445) — `pending_org_setups`, see
// lib/db/schema/pending-org-setups.ts for why it exists and what stamps each column.
//
// Every function here takes the ACTOR's user id from its caller (a server action that read it from
// the session, or the organization plugin's hook that read it from the request) and filters on it.
// Nothing here trusts a user id, an org id or a subscription id from the browser on its own.
//
// FINDING THE ORGANIZATION. better-auth's `/organization/create` inserts the organization row, then
// the creator's `member` row, then runs `afterCreateOrganization` — three statements, no transaction.
// So an organization can exist with its marker and NO owner: in the gap between the inserts, or for
// good when the member insert fails. A lookup that joined on an owner member could not see it, and the
// resume then created a second organization. `findSetupOrg` instead finds the organization by
// `created_org_id`, or by the server-stamped marker (lib/billing/new-org-setup.ts) — neither depends on
// the member row — and, when the organization has NO members at all, adds the actor as its owner. It
// never adds the actor to an organization that has other members: a team someone else is in is not
// "the one I paid for and lost", whatever its metadata says.

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, max, ne, or, type SQL, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { BILLING_FIELD_CAPS } from "@/lib/billing/billing-field-caps";
import { type FirstPayment, readFirstPayment } from "@/lib/billing/first-payment";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { getOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	NEW_ORG_CREATED_BY_KEY,
	NEW_ORG_SETUP_IN_PROGRESS_CODE,
	NEW_ORG_SETUP_ORG_EXISTS_CODE,
	NEW_ORG_SUBSCRIPTION_KEY,
	newOrgCreatedByOf,
	newOrgSubscriptionIdOf,
} from "@/lib/billing/new-org-setup";
import { TAX_ID_TYPES, type TaxIdType } from "@/lib/billing/tax-ids";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	organizationBilling,
	type PaymentHoldRow,
	paymentHolds,
	pendingOrgSetups,
} from "@/lib/db/schema";
import { REFUND_NOTICE_WINDOW_MS } from "@/lib/billing/new-org-hold-copy";
import type {
	PendingOrgSetupClosedReason,
	PendingOrgSetupRefusedReason,
} from "@/lib/db/schema/pending-org-setups";
import { ORG_SLUG_MAX_LENGTH, ORG_SLUG_PATTERN } from "@repo/org-slug";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";

/** One `pending_org_setups` row. */
export type PendingOrgSetupRow = typeof pendingOrgSetups.$inferSelect;

/**
 * The checkout billing details as the browser sends them — validated, never trusted as typed. The caps
 * are the checkout form's own (lib/billing/billing-field-caps.ts), so a value the form accepts is never
 * refused here.
 */
export const pendingOrgSetupBillingSchema = z.object({
	name: z.string().max(BILLING_FIELD_CAPS.name),
	line1: z.string().max(BILLING_FIELD_CAPS.line1),
	line2: z.string().max(BILLING_FIELD_CAPS.line2).optional(),
	city: z.string().max(BILLING_FIELD_CAPS.city),
	state: z.string().max(BILLING_FIELD_CAPS.state).optional(),
	postalCode: z.string().max(BILLING_FIELD_CAPS.postalCode),
	country: z.string().max(BILLING_FIELD_CAPS.country),
	taxType: z.custom<TaxIdType>(
		(v) => typeof v === "string" && TAX_ID_TYPES.some((t) => t.value === v),
	),
	taxValue: z.string().max(BILLING_FIELD_CAPS.taxValue),
	useAsPrimary: z.boolean(),
});

/**
 * A slug as the create-a-team form accepts it: the one org-slug rule (@repo/org-slug), so
 * `-acme`, `acme-`, `acme--cloud` and "" are refused here on the server's own authority, not only by
 * the form. Reserved and taken slugs are decided later, by the org's own rules.
 */
export const pendingOrgSetupSlugSchema = z
	.string()
	.trim()
	.max(ORG_SLUG_MAX_LENGTH)
	.regex(ORG_SLUG_PATTERN);

/**
 * Stripe statuses under which a new-org subscription MAY never have been paid — a necessary condition
 * for cancelling it and forgetting its record, never a sufficient one. `incomplete` also covers a first
 * payment that is `processing`, or that succeeded before its invoice settled; only the PaymentIntent can
 * tell those apart (`readFirstPayment`, lib/billing/first-payment.ts). Every other status is a charge,
 * or was one (`active`, `trialing`, `past_due`, `unpaid`, `paused`, `canceled` after payment), and its
 * record is the server's only way back to it.
 */
export const REPLACEABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
	"incomplete",
	"incomplete_expired",
]);

/** What `forgetPendingOrgSetup` needs to know about a subscription, read from Stripe by the caller. */
export interface RetrievedSubscription {
	id: string;
	status: string;
	metadata?: { created_by?: string } | null;
}

/**
 * Records a new-org subscription the moment it is minted, before the client can pay it. A second call
 * for the same subscription (it never happens: Stripe ids are unique) changes nothing.
 */
export async function recordPendingOrgSetup(input: {
	userId: string;
	subscriptionId: string;
	customerId: string;
	name: string;
	slug: string;
}): Promise<void> {
	await getServiceDb()
		.insert(pendingOrgSetups)
		.values({
			user_id: input.userId,
			subscription_id: input.subscriptionId,
			customer_id: input.customerId,
			intended_name: input.name,
			intended_slug: input.slug,
		})
		.onConflictDoNothing({ target: pendingOrgSetups.subscription_id });
}

/**
 * Drops the record of a subscription that was replaced before it was paid (a currency switch, a
 * "← Back" and re-declare). `sub` is the subscription AS STRIPE RETURNED IT to the caller, never an id
 * from the browser, and `firstPayment` is what `readFirstPayment` read from Stripe for it: the record
 * goes only when Stripe says `userId` minted it, its status is `REPLACEABLE_SUBSCRIPTION_STATUSES`, its
 * first payment provably never happened (`never_paid`), and nothing has been created for it. Returns
 * whether it was allowed to; the record of a payment that is in flight or went through is never
 * dropped here.
 *
 * And no payment hold names the subscription (ADR 0002 §8), open or released for any reason but one
 * that proves it can never become payable (`FORGETTABLE_RELEASES`), in the same DELETE. So a record
 * that goes had no org (§5.7 never needed it) and a subscription that cannot be paid again (§4.3 never
 * needs it).
 */
export async function forgetPendingOrgSetup(
	userId: string,
	sub: RetrievedSubscription,
	firstPayment: FirstPayment,
): Promise<boolean> {
	if (sub.metadata?.created_by !== userId) return false;
	if (!REPLACEABLE_SUBSCRIPTION_STATUSES.has(sub.status)) return false;
	if (firstPayment !== "never_paid") return false;
	await getServiceDb()
		.delete(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, sub.id),
				isNull(pendingOrgSetups.created_org_id),
				isNull(pendingOrgSetups.linked_at),
				sql`NOT EXISTS (SELECT 1 FROM payment_holds h WHERE h.subscription_id = ${sub.id}
					AND (h.state <> 'released' OR h.release_reason NOT IN ('voided_unpaid', 'deleted_draft', 'expired_unpaid')))`,
			),
		);
	return true;
}

/** The release reasons after which a held subscription can never become payable again (§8). */
export const FORGETTABLE_RELEASES: ReadonlySet<string> = new Set(["voided_unpaid", "deleted_draft", "expired_unpaid"]);

// THE CREATE-A-TEAM HOLD READERS (ADR 0004 D1 rule 3). The three below decide or route a create-a-team
// purchase, link or resume, so they read `scope = 'new_org'` only: an org-plan hold never blocks or
// reroutes create-a-team. The setup predicates that WAIT on holds (`noOpenHold`, `unclosedVerdict`, and
// `forgetPendingOrgSetup`'s hold condition) stay scope-free on purpose (D1 rule 4): narrowing them could
// only close or forget a setup the design means to keep.

/**
 * The OPEN `new_org` payment hold on `subscriptionId`, or null (I6: at most one open hold per
 * subscription). Service role: holds have no app policy.
 */
export async function openPaymentHoldOn(subscriptionId: string): Promise<PaymentHoldRow | null> {
	const [hold] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				eq(paymentHolds.scope, "new_org"),
				eq(paymentHolds.subscription_id, subscriptionId),
				ne(paymentHolds.state, "released"),
			),
		)
		.limit(1);
	return hold ?? null;
}

/**
 * The newest RELEASED `new_org` payment hold on `subscriptionId`, or null. Service role: holds have no app
 * policy. It has NO time bound, unlike the 14-day refund notice of `paymentHoldsOfPayer`: its callers
 * (`refuseEndedLink`, `endedSetupFor`) read it as what happened to X's money (ADR 0002 §5.6, C104), and
 * a refund older than 14 days is still a refund.
 */
export async function latestReleasedHoldOn(subscriptionId: string): Promise<PaymentHoldRow | null> {
	const [hold] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				eq(paymentHolds.scope, "new_org"),
				eq(paymentHolds.subscription_id, subscriptionId),
				eq(paymentHolds.state, "released"),
			),
		)
		.orderBy(desc(paymentHolds.released_at))
		.limit(1);
	return hold ?? null;
}

/**
 * The `new_org` payment holds of `payerKey` the create-a-team purchase reads (ADR 0002 §3.2 E1 (a),
 * §5.5): every OPEN one, which it advances before it may mint (I1 (a)), and every one released
 * `refunded` or `already_refunded` within the refund notice window, whose clause its response carries.
 * Only this payer's: the purchase reads nobody else's holds (I7), and no org-plan hold, even one whose
 * `payer_key` is the same string (ADR 0004 O1). The window is measured on the database's clock, the one
 * that stamped `released_at`, so the app server's clock can neither show nor hide a refund.
 */
export async function paymentHoldsOfPayer(payerKey: string): Promise<PaymentHoldRow[]> {
	const since = sql`now() - ${`${REFUND_NOTICE_WINDOW_MS} milliseconds`}::interval`;
	return getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				eq(paymentHolds.scope, "new_org"),
				eq(paymentHolds.payer_key, payerKey),
				or(
					ne(paymentHolds.state, "released"),
					and(
						inArray(paymentHolds.release_reason, ["refunded", "already_refunded"]),
						gt(paymentHolds.released_at, since),
					),
				),
			),
		)
		.orderBy(asc(paymentHolds.created_at));
}

/** The actor's record for one subscription, or null — never another user's. */
export async function pendingOrgSetupFor(
	userId: string,
	subscriptionId: string,
): Promise<PendingOrgSetupRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Where the next page of `unfinishedPendingOrgSetups` starts: just after the row with this `created_at`
 * and `id`. `at` is Postgres's own text of the timestamp, so it keeps the microseconds a JS `Date` would
 * drop — a cursor rounded to the millisecond skips the rows created later in that same millisecond.
 */
export interface UnfinishedSetupCursor {
	at: string;
	id: string;
}

/**
 * One page of the actor's setups whose last step (the payer declaration) has not been recorded and
 * that are not closed, newest first (ties broken by id), and the cursor of the page after it — null when this page is the last.
 *
 * A KEYSET page (#5463): it starts after `after`'s position in that order, not after a row count, so a
 * caller that deletes rows from a page it has read (`findUnfinishedNewOrgSetup` drops expired ones)
 * neither skips a row nor reads one twice. The position does not depend on the cursor's row still
 * existing.
 */
export async function unfinishedPendingOrgSetups(
	userId: string,
	limit = 10,
	after?: UnfinishedSetupCursor,
): Promise<{ rows: PendingOrgSetupRow[]; next: UnfinishedSetupCursor | null }> {
	const page = await getServiceDb()
		.select({ row: pendingOrgSetups, at: sql<string>`${pendingOrgSetups.created_at}::text` })
		.from(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				isNull(pendingOrgSetups.declared_at),
				// A closed setup is finished for good (ADR 0002 §5.6): never offered for resume again.
				isNull(pendingOrgSetups.closed_at),
				after
					? sql`(${pendingOrgSetups.created_at}, ${pendingOrgSetups.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
					: undefined,
			),
		)
		.orderBy(desc(pendingOrgSetups.created_at), desc(pendingOrgSetups.id))
		.limit(limit);
	const last = page.at(-1);
	return {
		rows: page.map((p) => p.row),
		next: page.length === limit && last ? { at: last.at, id: last.row.id } : null,
	};
}

/** The most distinct customers `unlinkedPendingOrgSetupCustomers` returns before it refuses (ADR 0002 §4.5). */
export const UNLINKED_SETUP_CUSTOMER_CAP = 50;

/** How many records one keyset page of `unlinkedPendingOrgSetupCustomers` reads. */
const UNLINKED_SETUP_PAGE = 100;

/**
 * What `unlinkedPendingOrgSetupCustomers` found: every customer (`all`), or `over_cap` when the actor's
 * unlinked records name more than `UNLINKED_SETUP_CUSTOMER_CAP` distinct customers. `over_cap` carries
 * no list ON PURPOSE: a partial list would let the purchase sweep fewer customers than exist and mint
 * beside a payment still settling on one it never read, so the caller has nothing to proceed with and
 * must refuse.
 */
export type UnlinkedSetupCustomers = { kind: "all"; customers: string[] } | { kind: "over_cap" };

/**
 * The Stripe customers of the actor's setups that have no organization yet (nothing created, nothing
 * linked, nothing declared), newest record first, each once. The new-org purchase reuses the first when
 * the browser lost its `customerId`, and sweeps all of them for a payment still settling (#5463).
 *
 * It reads EVERY such record (ADR 0002 §4.5, C21), in keyset pages of `UNLINKED_SETUP_PAGE` ordered by
 * `(created_at, id)` descending — a cursor on that position, not a row count, so no record is skipped or
 * read twice — and stops only at the last page, or as soon as a customer beyond
 * `UNLINKED_SETUP_CUSTOMER_CAP` appears, which answers `over_cap`. It never answers with a list it
 * stopped reading early.
 */
export async function unlinkedPendingOrgSetupCustomers(userId: string): Promise<UnlinkedSetupCustomers> {
	return setupCustomers(
		userId,
		and(
			isNull(pendingOrgSetups.created_org_id),
			isNull(pendingOrgSetups.linked_at),
			isNull(pendingOrgSetups.declared_at),
		),
	);
}

/**
 * THE LIVE CHECK'S RECORD SET (ADR 0002 §4.3, C94): the Stripe customers of EVERY setup of the actor
 * that is not linked — whether or not its organization exists, whether or not it is declared or closed —
 * newest record first, each once, or `over_cap` past `UNLINKED_SETUP_CUSTOMER_CAP`. It is not
 * `unlinkedPendingOrgSetupCustomers`, which leaves out every record with an organization because it
 * answers which customer to reuse: with that set, a paid, unlinked subscription whose team exists was
 * invisible to the check that keeps a second one from being minted beside it.
 */
export async function liveCheckSetupCustomers(userId: string): Promise<UnlinkedSetupCustomers> {
	return setupCustomers(userId, isNull(pendingOrgSetups.linked_at));
}

/**
 * The `created_at` of the actor's newest setup record that is not linked — the live check's record set
 * (`liveCheckSetupCustomers`), closed records included — or null when there is none. The create-a-team
 * purchase reads it as the marker of a CAP STATE, to alert the operator once per state when that set is
 * over `UNLINKED_SETUP_CUSTOMER_CAP` (#5989).
 */
export async function newestUnlinkedSetupAt(userId: string): Promise<Date | null> {
	const [row] = await getServiceDb()
		.select({ at: max(pendingOrgSetups.created_at) })
		.from(pendingOrgSetups)
		.where(and(eq(pendingOrgSetups.user_id, userId), isNull(pendingOrgSetups.linked_at)));
	return row?.at ?? null;
}

/**
 * The distinct customers of the actor's records matching `where`, in keyset pages of
 * `UNLINKED_SETUP_PAGE` ordered by `(created_at, id)` descending — so no record is skipped or read twice
 * — stopping only at the last page, or at the first customer beyond `UNLINKED_SETUP_CUSTOMER_CAP`, which
 * answers `over_cap`.
 */
async function setupCustomers(userId: string, where: SQL | undefined): Promise<UnlinkedSetupCustomers> {
	const customers: string[] = [];
	const seen = new Set<string>();
	let after: UnfinishedSetupCursor | null = null;
	for (;;) {
		const page = await getServiceDb()
			.select({
				id: pendingOrgSetups.id,
				customerId: pendingOrgSetups.customer_id,
				at: sql<string>`${pendingOrgSetups.created_at}::text`,
			})
			.from(pendingOrgSetups)
			.where(
				and(
					eq(pendingOrgSetups.user_id, userId),
					where,
					after
						? sql`(${pendingOrgSetups.created_at}, ${pendingOrgSetups.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
						: undefined,
				),
			)
			.orderBy(desc(pendingOrgSetups.created_at), desc(pendingOrgSetups.id))
			.limit(UNLINKED_SETUP_PAGE);
		for (const row of page) {
			if (seen.has(row.customerId)) continue;
			if (customers.length === UNLINKED_SETUP_CUSTOMER_CAP) return { kind: "over_cap" };
			seen.add(row.customerId);
			customers.push(row.customerId);
		}
		const last = page.at(-1);
		if (page.length < UNLINKED_SETUP_PAGE || !last) return { kind: "all", customers };
		after = { at: last.at, id: last.id };
	}
}

/**
 * Saves the slug and the checkout billing details on the actor's unfinished record — each only when
 * given (null leaves the stored value as it is).
 */
export async function savePendingOrgSetupDetails(
	userId: string,
	subscriptionId: string,
	details: { slug: string | null; billing: PendingOrgSetupBilling | null },
): Promise<void> {
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({
			...(details.slug !== null ? { intended_slug: details.slug } : {}),
			...(details.billing ? { billing: details.billing } : {}),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.declared_at),
			),
		);
}

/**
 * Stamps the link step: the subscription now names `orgId`. A CLOSED setup is left closed (#5714):
 * closed is terminal, and the link of a subscription the closer has just read as ended must not turn
 * it back into a linked one.
 */
export async function markPendingOrgSetupLinked(
	userId: string,
	subscriptionId: string,
	orgId: string,
): Promise<void> {
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ created_org_id: orgId, linked_at: new Date(), updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.closed_at),
			),
		);
}

/**
 * Stamps the last step — the payer declaration for `orgId` — on the actor's record for that org, and
 * drops the billing details it no longer needs.
 *
 * The record is matched by `created_org_id`, OR by its subscription: the one `orgId`'s billing row
 * names (the link step wrote it there), or `subscriptionId` when the caller has just read it linked to
 * `orgId` from Stripe. A record with no `created_org_id` — one backfilled for a subscription minted
 * before the table existed, or one whose org was found by the link rather than by the marker — is
 * closed by its subscription and gets `created_org_id` filled in. Matched on the created org alone it
 * stayed open for good, and every Create-a-team open retrieved it from Stripe again.
 */
export async function markPendingOrgSetupDeclared(
	userId: string,
	orgId: string,
	subscriptionId?: string,
): Promise<void> {
	const db = getServiceDb();
	const linkedSubscription = db
		.select({ id: organizationBilling.stripeSubscriptionId })
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId));
	await db
		.update(pendingOrgSetups)
		.set({
			declared_at: new Date(),
			billing: null,
			created_org_id: sql`coalesce(${pendingOrgSetups.created_org_id}, ${orgId}::uuid)`,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				isNull(pendingOrgSetups.declared_at),
				or(
					eq(pendingOrgSetups.created_org_id, orgId),
					inArray(pendingOrgSetups.subscription_id, linkedSubscription),
					subscriptionId ? eq(pendingOrgSetups.subscription_id, subscriptionId) : undefined,
				),
			),
		);
}

/**
 * What `beforeCreateOrganization` should do with a create's metadata: leave it alone (null — it
 * carries neither key), replace it, or refuse the create.
 */
export type NewOrgMetadataVerdict =
	| null
	| { metadata: Record<string, unknown> | undefined }
	| { refusal: { code: string; message: string } };

/**
 * The organization plugin's `beforeCreateOrganization` half (ee/src/new-org-setup-hooks.ts). Returns
 * the metadata to insert: the marker kept, and the creator stamped beside it, only when `userId` owns
 * the setup record the marker names. Both keys are removed from anything else, so no client can make
 * an organization claim a setup it does not own.
 *
 * Refuses a create naming a setup that already has an organization — the server-side idempotency key
 * for "one organization per charge". Before it lets a create through it CLAIMS the record
 * (`claimPendingOrgSetup`, one conditional UPDATE), so of two creates for one charge arriving in the
 * same instant exactly one gets the claim; the other is refused with `NEW_ORG_SETUP_IN_PROGRESS_CODE`
 * and its retry finds the organization the first one made. A claim whose create then failed (the org
 * insert itself, after this hook) is released when that request answers (`runOrgCreate`); one whose
 * request never answered (a process that died) lapses after `CLAIM_TTL`. A retry after either still
 * cannot make a second org: a committed one carries the marker, which is checked after the claim.
 *
 * Runs in better-auth's create AFTER its slug check and after the reserved-slug hook (ee/src/index.ts),
 * so a slug refusal never leaves a claim behind.
 */
export async function stampNewOrgMetadata(
	metadata: unknown,
	userId: string,
): Promise<NewOrgMetadataVerdict> {
	if (typeof metadata !== "object" || metadata === null) return null;
	if (!(NEW_ORG_SUBSCRIPTION_KEY in metadata) && !(NEW_ORG_CREATED_BY_KEY in metadata)) return null;
	const subscriptionId = newOrgSubscriptionIdOf(metadata);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (key !== NEW_ORG_SUBSCRIPTION_KEY && key !== NEW_ORG_CREATED_BY_KEY) rest[key] = value;
	}
	const keep = (): NewOrgMetadataVerdict => ({
		metadata: Object.keys(rest).length > 0 ? rest : undefined,
	});
	if (!subscriptionId) return keep();
	const row = await pendingOrgSetupFor(userId, subscriptionId);
	if (!row) return keep();
	const exists: NewOrgMetadataVerdict = {
		refusal: {
			code: NEW_ORG_SETUP_ORG_EXISTS_CODE,
			message: "A team was already created for this payment.",
		},
	};
	if (row.created_org_id) return exists;
	if (!(await claimPendingOrgSetup(row.id, userId))) {
		const now = await pendingOrgSetupFor(userId, subscriptionId);
		if (now?.created_org_id) return exists;
		return {
			refusal: {
				code: NEW_ORG_SETUP_IN_PROGRESS_CODE,
				message: "This team is already being set up. Try again in a minute.",
			},
		};
	}
	if ((await markedOrgs(subscriptionId, userId)).length > 0) return exists;
	return {
		metadata: {
			...rest,
			[NEW_ORG_SUBSCRIPTION_KEY]: subscriptionId,
			[NEW_ORG_CREATED_BY_KEY]: userId,
		},
	};
}

/** How long a create's claim on a setup record holds before another create may take it. */
const CLAIM_TTL = sql`interval '1 minute'`;

/** The claim one `/organization/create` request took, if it took one (see `runOrgCreate`). */
interface CreateRequestScope {
	claim: { rowId: string; userId: string; at: Date } | null;
}

const createRequestScope = new AsyncLocalStorage<CreateRequestScope>();

/**
 * Runs one `/organization/create` request (app/api/auth/[...all]/route.ts) and, when it does not
 * succeed, releases the setup claim it took. A claim exists to stop a SECOND create while the first is
 * still in flight; once this request has answered with a failure — the org insert refused its slug,
 * the database failed — it is not in flight, and holding the claim for the rest of `CLAIM_TTL` only
 * refused every retry with "already being set up". Only this request's own claim is cleared (same row,
 * same `creating_at`), and only while no organization is recorded for it. An organization that was
 * inserted before a later step failed still carries its marker, which a retry checks after its claim,
 * so a release never allows a second one.
 */
export async function runOrgCreate(create: () => Promise<Response>): Promise<Response> {
	const scope: CreateRequestScope = { claim: null };
	const response = await createRequestScope.run(scope, create);
	if (!response.ok && scope.claim) {
		const { rowId, userId, at } = scope.claim;
		await getServiceDb()
			.update(pendingOrgSetups)
			.set({ creating_at: null, updated_at: new Date() })
			.where(
				and(
					eq(pendingOrgSetups.id, rowId),
					eq(pendingOrgSetups.user_id, userId),
					eq(pendingOrgSetups.creating_at, at),
					isNull(pendingOrgSetups.created_org_id),
				),
			);
	}
	return response;
}

/**
 * Claims the actor's setup record for one organization create: sets `creating_at` only while no
 * organization is recorded for it and no live claim holds it, in ONE statement, so two concurrent
 * creates cannot both succeed. True when this call got the claim; the claim is noted on the request
 * (`runOrgCreate`) so a failed create gives it back.
 */
async function claimPendingOrgSetup(rowId: string, userId: string): Promise<boolean> {
	const at = new Date();
	const claimed = await getServiceDb()
		.update(pendingOrgSetups)
		.set({ creating_at: at, updated_at: at })
		.where(
			and(
				eq(pendingOrgSetups.id, rowId),
				eq(pendingOrgSetups.user_id, userId),
				isNull(pendingOrgSetups.created_org_id),
				or(
					isNull(pendingOrgSetups.creating_at),
					lt(pendingOrgSetups.creating_at, sql`now() - ${CLAIM_TTL}`),
				),
			),
		)
		.returning({ id: pendingOrgSetups.id });
	if (claimed.length === 0) return false;
	const scope = createRequestScope.getStore();
	if (scope) scope.claim = { rowId, userId, at };
	return true;
}

/**
 * The organization plugin's `beforeUpdateOrganization` half: an update that writes the metadata blob
 * gets the two marker keys from what is STORED, never from the request. Without it any admin could
 * write a marker naming someone else's charge onto their own organization (blocking that customer's
 * setup), and a settings save that rewrites the blob would drop a real one. Null when the update does
 * not touch the metadata.
 */
export async function keepStoredNewOrgMarker(
	orgId: string,
	metadata: unknown,
): Promise<{ metadata: Record<string, unknown> } | null> {
	if (typeof metadata !== "object" || metadata === null) return null;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (key !== NEW_ORG_SUBSCRIPTION_KEY && key !== NEW_ORG_CREATED_BY_KEY) next[key] = value;
	}
	const [stored] = await getServiceDb()
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const subscriptionId = newOrgSubscriptionIdOf(stored?.metadata ?? null);
	const createdBy = newOrgCreatedByOf(stored?.metadata ?? null);
	if (subscriptionId) next[NEW_ORG_SUBSCRIPTION_KEY] = subscriptionId;
	if (createdBy) next[NEW_ORG_CREATED_BY_KEY] = createdBy;
	return { metadata: next };
}

/**
 * The organization plugin's `afterCreateOrganization` half: records the new organization on the
 * creator's setup record. Only for a marker the before-hook stamped for this same user.
 */
export async function recordNewOrgCreated(
	orgId: string,
	metadata: unknown,
	userId: string,
): Promise<void> {
	const subscriptionId = newOrgSubscriptionIdOf(metadata);
	if (!subscriptionId || newOrgCreatedByOf(metadata) !== userId) return;
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ created_org_id: orgId, updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.created_org_id),
			),
		);
}

/**
 * Organizations whose server-stamped marker names `subscriptionId` and `userId` as creator, oldest
 * first. The LIKE is only a prefilter (it can over-match: `_` is a wildcard); the parsed metadata
 * decides.
 */
async function markedOrgs(
	subscriptionId: string,
	userId: string,
): Promise<{ id: string; slug: string | null }[]> {
	const candidates = await getServiceDb()
		.select({ id: organization.id, slug: organization.slug, metadata: organization.metadata })
		.from(organization)
		.where(like(organization.metadata, `%${subscriptionId}%`))
		.orderBy(asc(organization.createdAt));
	return candidates.filter(
		(o) =>
			newOrgSubscriptionIdOf(o.metadata) === subscriptionId &&
			newOrgCreatedByOf(o.metadata) === userId,
	);
}

/**
 * The organization created for the actor's setup `row`, found without depending on the owner member
 * row; null when there is none, or when it is a team the actor is not in and others are.
 *
 * Found by `created_org_id`, else by the server-stamped marker (and then recorded as
 * `created_org_id`, once it is known to be the actor's). An organization with NO members — better-auth's member insert never landed — is
 * repaired by adding the actor as its owner, with the owner grant `afterCreateOrganization` would have
 * written. Both ways of finding it are proof the actor created it: the hook stamped the marker from the
 * request's own session, and `created_org_id` is written only from that marker or by a link the actor
 * was authorized for in that organization.
 */
export async function findSetupOrg(
	row: PendingOrgSetupRow,
	userId: string,
): Promise<{ id: string; slug: string } | null> {
	if (row.user_id !== userId) return null;
	const db = getServiceDb();
	let org: { id: string; slug: string | null } | null = null;
	if (row.created_org_id) {
		const [found] = await db
			.select({ id: organization.id, slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, row.created_org_id))
			.limit(1);
		org = found ?? null;
	}
	let foundByMarker = false;
	if (!org) {
		const [marked] = await markedOrgs(row.subscription_id, userId);
		if (!marked) return null;
		org = marked;
		foundByMarker = true;
	}
	const members = await db
		.select({ userId: member.userId })
		.from(member)
		.where(eq(member.organizationId, org.id));
	if (!members.some((m) => m.userId === userId)) {
		if (members.length > 0) return null;
		// Inserted only while the organization still has no member at all, so nothing lands in a team
		// someone joined since. `not exists` alone does not stop two concurrent inserts (each reads before
		// either commits) — nor this one racing better-auth's own member insert for the creator, still in
		// flight; the unique (organization_id, user_id) index does, and the loser does nothing.
		await db.execute(sql`
			insert into public.member (organization_id, user_id, role)
			select ${org.id}::uuid, ${userId}::uuid, 'owner'
			 where not exists (select 1 from public.member where organization_id = ${org.id}::uuid)
			on conflict (organization_id, user_id) do nothing`);
		const [mine] = await db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, org.id), eq(member.userId, userId)))
			.limit(1);
		if (!mine) return null;
		await ensureMemberGrant(org.id, userId, mine.role);
	}
	// Recorded only now, once the organization is known to be the actor's.
	if (foundByMarker) {
		await db
			.update(pendingOrgSetups)
			.set({ created_org_id: org.id, updated_at: new Date() })
			.where(and(eq(pendingOrgSetups.id, row.id), eq(pendingOrgSetups.user_id, userId)));
	}
	return { id: org.id, slug: org.slug ?? "" };
}

// ── The open setup, its guard and its exits (ADR 0002 §5.7, #5714) ─────────────────────────────────
//
// An org is created BEFORE its subscription is linked to it, so for a while the org carries a paid
// setup that its billing row does not show. Its own purchase flows must not mint a second plan there
// (`openPendingOrgSetupsForOrg` is what they read), and every such setup needs a way out that does not
// depend on its creator coming back (`settleOpenSetup`, the closer). "Open" is
// `linked_at IS NULL AND closed_at IS NULL`.
//
// Every write below is a COMPARE-AND-SET on that predicate, returning the row. Several readers can
// find the same subscription at once (the guard, both resume lookups, the link); only the caller whose
// statement returned the row logs the event or raises the alert, so "alerted once" has a mechanism.

/** Subscription statuses under which Stripe will never collect a payment for it again. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/** Billing statuses that mean the org's row holds a live plan. */
const LIVE_BILLING_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/**
 * Writes one structured log line with a stable event name (ADR 0002 §5.4: the console has no billing
 * audit table, so the durable record is the row's own columns and this line is the event).
 */
export function logBillingEvent(event: string, fields: Record<string, string | null>): void {
	console.info(JSON.stringify({ event, ...fields }));
}

/** True for Stripe's "No such …" error — the id names nothing in this account. */
function isStripeResourceMissing(e: unknown): boolean {
	return typeof e === "object" && e !== null && Reflect.get(e, "code") === "resource_missing";
}

/**
 * The OPEN setups that name `orgId` — by `created_org_id`, or by the subscription in the org's own
 * server-stamped marker (so the guard holds even when `recordNewOrgCreated` never wrote
 * `created_org_id`, C93). Read with the SERVICE role on purpose: the buyer may be another owner of the
 * org, whom RLS would show nothing of the creator's row. The caller turns a row into a refusal and, at
 * most, the creator's name from the org's own member list; no other column reaches the buyer.
 */
export async function openPendingOrgSetupsForOrg(orgId: string): Promise<PendingOrgSetupRow[]> {
	const db = getServiceDb();
	const [org] = await db
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const marker = newOrgSubscriptionIdOf(org?.metadata ?? null);
	return db
		.select()
		.from(pendingOrgSetups)
		.where(
			and(
				isNull(pendingOrgSetups.linked_at),
				isNull(pendingOrgSetups.closed_at),
				or(
					eq(pendingOrgSetups.created_org_id, orgId),
					marker ? eq(pendingOrgSetups.subscription_id, marker) : undefined,
				),
			),
		);
}

/**
 * Closes the open setup of `subscriptionId` — one compare-and-set on `closed_at IS NULL AND
 * linked_at IS NULL` — and returns the row it closed, or null when it was not open (already closed or
 * linked, by this caller or another one) or does not exist. `userId`, when given, must own it.
 *
 * NEVER WHILE A PAYMENT HOLD IS OPEN on the subscription (ADR 0002 I16 (a), C92): the same statement
 * requires that no open hold names it, and matches nothing otherwise. The hold decides the setup when
 * it ends — its release closes it, or an adoption leaves it open (lib/billing/payment-holds/store.ts).
 */
export async function closePendingOrgSetup(input: {
	subscriptionId: string;
	reason: PendingOrgSetupClosedReason;
	refusedReason?: PendingOrgSetupRefusedReason;
	userId?: string;
	closedBy?: string;
	note?: string;
}): Promise<PendingOrgSetupRow | null> {
	const now = new Date();
	const [closed] = await getServiceDb()
		.update(pendingOrgSetups)
		.set({
			closed_at: now,
			closed_reason: input.reason,
			...(input.refusedReason ? { refused_reason: input.refusedReason } : {}),
			...(input.closedBy ? { closed_by: input.closedBy } : {}),
			...(input.note ? { closed_note: input.note } : {}),
			updated_at: now,
		})
		.where(
			and(
				eq(pendingOrgSetups.subscription_id, input.subscriptionId),
				input.userId ? eq(pendingOrgSetups.user_id, input.userId) : undefined,
				isNull(pendingOrgSetups.closed_at),
				isNull(pendingOrgSetups.linked_at),
				noOpenHold(input.subscriptionId),
			),
		)
		.returning();
	return closed ?? null;
}

/**
 * I16 (a), inside a statement on `pending_org_setups`: no open payment hold, of any scope, names
 * `subscriptionId` (ADR 0004 D1 rule 4).
 */
function noOpenHold(subscriptionId: string): SQL {
	return sql`NOT EXISTS (SELECT 1 FROM payment_holds h WHERE h.subscription_id = ${subscriptionId} AND h.state <> 'released')`;
}

/**
 * Records why the link refused `userId`'s setup of `subscriptionId` (ADR 0002 §5.6, I16). With `close`
 * (the link read X ended), one compare-and-set writes `refused_reason`, `closed_at` and
 * `closed_reason = 'ended'` — and, as every close does (`closePendingOrgSetup`), only while no open
 * payment hold names X. Otherwise, or when that matched nothing, `refused_reason` alone is written on
 * the setup if it is still open, and it stays open: the hold that names X, or an operator, decides it.
 * A closed or linked setup keeps the reason it already has. Returns the row this call CLOSED, or null.
 */
export async function recordSetupRefusal(input: {
	userId: string;
	subscriptionId: string;
	refused: PendingOrgSetupRefusedReason;
	close: boolean;
}): Promise<PendingOrgSetupRow | null> {
	if (input.close) {
		const closed = await closePendingOrgSetup({
			subscriptionId: input.subscriptionId,
			userId: input.userId,
			reason: "ended",
			refusedReason: input.refused,
		});
		if (closed) return closed;
	}
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ refused_reason: input.refused, updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, input.userId),
				eq(pendingOrgSetups.subscription_id, input.subscriptionId),
				isNull(pendingOrgSetups.closed_at),
				isNull(pendingOrgSetups.linked_at),
			),
		);
	return null;
}

/**
 * The verdict of a close whose compare-and-set matched nothing: `open` while a payment hold of ANY scope
 * keeps the setup open (I16; the same scope-free question as `noOpenHold`, ADR 0004 D1 rule 4), else
 * `closed` (another reader closed or linked it first).
 */
async function unclosedVerdict(subscriptionId: string): Promise<SetupCloserVerdict> {
	const [hold] = await getServiceDb()
		.select({ id: paymentHolds.id })
		.from(paymentHolds)
		.where(and(eq(paymentHolds.subscription_id, subscriptionId), ne(paymentHolds.state, "released")))
		.limit(1);
	return hold ? "open" : "closed";
}

/**
 * Marks the open setup of `subscriptionId` linked to `orgId` — the write the link's last step would
 * have made — with the same compare-and-set as `closePendingOrgSetup`. Returns the row, or null when it
 * was not open.
 */
async function adoptPendingOrgSetup(
	subscriptionId: string,
	orgId: string,
): Promise<PendingOrgSetupRow | null> {
	const now = new Date();
	const [adopted] = await getServiceDb()
		.update(pendingOrgSetups)
		.set({
			linked_at: now,
			created_org_id: sql`coalesce(${pendingOrgSetups.created_org_id}, ${orgId}::uuid)`,
			updated_at: now,
		})
		.where(
			and(
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.closed_at),
				isNull(pendingOrgSetups.linked_at),
			),
		)
		.returning();
	return adopted ?? null;
}

/**
 * What the closer left the setup as: `closed` (it no longer blocks anything), `linked` (adopted, or
 * already linked), or `open` (it still blocks the org's purchases, and some other exit must end it).
 */
export type SetupCloserVerdict = "closed" | "linked" | "open";

/**
 * THE SETUP CLOSER (ADR 0002 §5.7 "Every open setup has an exit"). Run by the guard, both resume
 * lookups and the link before they answer. It has two branches, and nothing else in it writes:
 *
 *   - CLOSE: the subscription X reads ended (`canceled`, `incomplete_expired`) and no payment hold on X
 *     is open. The setup is closed (`closed_reason = 'ended'`), and when `readFirstPayment` does not read
 *     `never_paid` — money may have moved on a setup nobody will finish — the operator is alerted.
 *     Nothing is refunded here. While a hold on X is open the setup stays `open` (I16): the hold is
 *     watching that money, and its release closes the setup.
 *   - ADOPT: X is not ended, its `metadata.organization_id` is the setup's org, its
 *     `metadata.created_by` is the setup's user, and the org's billing row names X — the state a link
 *     leaves when it throws after `subscriptions.update` and before its mark (C96). The setup is marked
 *     linked. When the metadata names the org but the row does not name X yet, X is synced once first
 *     (the same idempotent call the webhook makes); a row that then names ANOTHER live plan is the S1
 *     refusal (closed with `org_has_plan`, alerted) — except when `linkRefuses` is set: the caller is
 *     the link, which refuses that X itself under a `needs_operator` hold (ADR 0002 §5.6), so the
 *     closer writes nothing and answers `open`. Metadata naming a different org or user is never
 *     adopted.
 *
 * Everything else stays open. A subscription Stripe cannot find (`resource_missing`) is NEVER closed
 * here: a wrong key makes every read missing, and only an operator can tell that from a reset test
 * account (`scripts/pending-org-setups.ts close-setup`). Any other failed read is THROWN with nothing
 * written, so the guard can refuse the purchase rather than pass it.
 *
 * `sub` is X as the caller already read it (saves a read); `orgId` is the org the caller knows the
 * setup by, else the row's `created_org_id`.
 */
export async function settleOpenSetup(
	row: PendingOrgSetupRow,
	opts: { sub?: Stripe.Subscription; orgId?: string | null; linkRefuses?: boolean } = {},
): Promise<SetupCloserVerdict> {
	if (row.closed_at) return "closed";
	if (row.linked_at) return "linked";
	let sub = opts.sub;
	if (!sub) {
		try {
			sub = await getStripe().subscriptions.retrieve(row.subscription_id);
		} catch (e) {
			if (isStripeResourceMissing(e)) return "open";
			throw e;
		}
	}
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

	if (ENDED_STATUSES.has(sub.status)) {
		// Read BEFORE the write: a failed read throws with nothing written (fail closed).
		const firstPayment = await readFirstPayment(sub);
		const closed = await closePendingOrgSetup({ subscriptionId: row.subscription_id, reason: "ended" });
		if (!closed) return unclosedVerdict(row.subscription_id);
		logBillingEvent("billing.pending_org_setup.closed", {
			subscription_id: row.subscription_id,
			user_id: row.user_id,
			org_id: closed.created_org_id,
			closed_reason: "ended",
			x_read: sub.status,
			first_payment: firstPayment,
		});
		if (firstPayment !== "never_paid") {
			await alertPaymentNeedsSupport({
				subscriptionId: sub.id,
				customerId,
				paymentIntentId: null,
				context: "setup_closed",
				detail: `it reads ${sub.status} and its first payment is not proven unmoved, so money may have been taken for a team setup nobody will finish. Nothing was refunded automatically; check the payment and refund it by hand if it was taken.`,
			});
		}
		return "closed";
	}

	const orgId = opts.orgId ?? row.created_org_id;
	if (
		!orgId ||
		sub.metadata?.organization_id !== orgId ||
		sub.metadata?.created_by !== row.user_id
	) {
		return "open";
	}
	let billing = await getOrgBilling(orgId);
	if (billing?.stripeSubscriptionId !== sub.id) {
		await syncSubscriptionToBilling(sub);
		billing = await getOrgBilling(orgId);
	}
	if (billing?.stripeSubscriptionId === sub.id) {
		const adopted = await adoptPendingOrgSetup(row.subscription_id, orgId);
		if (adopted) {
			logBillingEvent("billing.pending_org_setup.adopted", {
				subscription_id: row.subscription_id,
				user_id: row.user_id,
				org_id: orgId,
				x_read: sub.status,
			});
		}
		return "linked";
	}
	if (billing?.stripeSubscriptionId && LIVE_BILLING_STATUSES.has(billing.status)) {
		if (opts.linkRefuses) return "open";
		const closed = await closePendingOrgSetup({
			subscriptionId: row.subscription_id,
			reason: "org_has_plan",
			refusedReason: "org_has_plan",
		});
		if (closed) {
			logBillingEvent("billing.pending_org_setup.closed", {
				subscription_id: row.subscription_id,
				user_id: row.user_id,
				org_id: orgId,
				closed_reason: "org_has_plan",
				x_read: sub.status,
				org_subscription_id: billing.stripeSubscriptionId,
			});
			await alertPaymentNeedsSupport({
				subscriptionId: sub.id,
				customerId,
				paymentIntentId: null,
				context: "link_refused",
				detail: `it names team ${orgId}, whose billing row holds another live subscription (${billing.stripeSubscriptionId}), so it was not linked and keeps renewing beside it. Refund it, or move it to the right team.`,
			});
		}
		return closed ? "closed" : unclosedVerdict(row.subscription_id);
	}
	return "open";
}
