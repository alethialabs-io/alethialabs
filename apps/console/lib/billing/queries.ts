// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed reads/writes for the per-org billing record. The billing table is a
// tenancy-control concern (it decides entitlements), so it is queried via the
// service connection (bypasses RLS) and the org boundary is enforced by the caller
// passing the resolved actor.orgId — never user input.

import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { getServiceDb, type Tx } from "@/lib/db";
import {
	organizationBilling,
	type OrganizationBilling,
	type OrganizationBillingInsert,
} from "@/lib/db/schema";
import type { Entitlements } from "@/lib/authz/types";
import type { AiTier } from "@/lib/billing/ai-plan";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import {
	COMMUNITY_ENTITLEMENTS,
	isBillingActive,
	isManualGrantExpired,
	resolvePlanEntitlements,
} from "./plan";

/**
 * Returns an org's billing record, or null if it has none (→ implicitly community).
 *
 * `tx` reads the row on the caller's transaction instead of a pooled service connection. The AI
 * hold (`reserveAiHold`, ADR 0003 §5.1 step 7) reads the plan this way, after its advisory lock:
 * a second pooled connection taken while the transaction holds one is the pool deadlock
 * `ai-guard.ts` warns against. Omitted, the read is exactly what it always was.
 */
export async function getOrgBilling(
	orgId: string,
	tx?: Tx,
): Promise<OrganizationBilling | null> {
	const [row] = await (tx ?? getServiceDb())
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row ?? null;
}

/**
 * Resolves an org's entitlements from its billing record: the plan's grant when the
 * subscription is live, the community baseline if there's no row or it's inactive.
 * This is the per-org resolution the ee/ entitlements seam delegates to (replacing
 * the global ALETHIA_LICENSE_ACTIVE env flag).
 */
export async function resolveOrgEntitlements(
	orgId: string,
): Promise<Entitlements> {
	const billing = await getOrgBilling(orgId);
	if (!billing) return COMMUNITY_ENTITLEMENTS;
	// An off-Stripe grant (Enterprise contract) lapses at its term end — fail closed to
	// community rather than granting paid features past a term nothing else enforces.
	if (isManualGrantExpired(billing)) return COMMUNITY_ENTITLEMENTS;
	return resolvePlanEntitlements(billing.plan, billing.status);
}

/** Fields the Stripe webhook writes onto an org's billing record. */
export interface BillingUpsert {
	organizationId: string;
	plan: BillingPlan;
	status: BillingStatus;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	seats?: number | null;
	currentPeriodEnd?: Date | null;
}

/**
 * Coerce a period boundary to a valid Date or null. TypeScript's Date|null is erased at runtime, so a
 * caller can pass "" or an invalid date (seen in prod: a canceled sub upsert with current_period_end="")
 * — Postgres then rejects it for a timestamptz column and the whole billing upsert fails. Anything not a
 * finite date becomes null. Cast-free (typeof/instanceof narrowing). Exported for unit tests.
 */
export function toValidDate(v: unknown): Date | null {
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
	if (typeof v === "number") {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof v === "string" && v.trim()) {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

/**
 * Upserts an org's billing record (one row per org) UNCONDITIONALLY — the off-Stripe write path:
 * the operator plane's plan grant (lib/platform/provision.ts) and the customer-id stamp in
 * `ensureCustomer`. It is NOT the Stripe subscription-event path; that is
 * `applySubscriptionToBilling` below, which refuses to let one subscription's event overwrite a
 * row naming another live one (#5514). Entitlements then resolve from the new plan + status on
 * the next request (no cache to invalidate — getActiveScope reads it fresh).
 */
export async function upsertOrgBilling(input: BillingUpsert): Promise<void> {
	const now = new Date();
	const values: OrganizationBillingInsert = {
		organizationId: input.organizationId,
		plan: input.plan,
		status: input.status,
		stripeCustomerId: input.stripeCustomerId ?? null,
		stripeSubscriptionId: input.stripeSubscriptionId ?? null,
		seats: input.seats ?? null,
		// Coerce defensively: the Date|null type is erased at runtime, and a caller (e.g. a
		// JSON/contract path) can pass "" for a canceled sub — Postgres rejects "" for a timestamptz
		// ("invalid input syntax"), failing the whole upsert. "" / invalid → null.
		currentPeriodEnd: toValidDate(input.currentPeriodEnd),
		updatedAt: now,
	};
	await getServiceDb()
		.insert(organizationBilling)
		.values(values)
		.onConflictDoUpdate({
			target: organizationBilling.organizationId,
			set: {
				plan: values.plan,
				status: values.status,
				stripeCustomerId: values.stripeCustomerId,
				stripeSubscriptionId: values.stripeSubscriptionId,
				seats: values.seats,
				currentPeriodEnd: values.currentPeriodEnd,
				updatedAt: now,
			},
		});
}

// ── The Stripe subscription write path (#5514) ──────────────────────────────────────────────
//
// `organization_billing` is ONE row per org, but an org can have more than one Stripe
// subscription in flight: a fresh purchase beside a `past_due` one, an `incomplete` attempt the
// purchase sweep has not cancelled yet, a trial started over an off-Stripe grant. Every
// subscription's events arrive here. Upserting on `organization_id` alone let the LAST event to
// arrive win, whichever subscription it was for — so a second subscription Z overwrote the row
// naming the org's live subscription Y, and Z's later cancellation wrote `canceled`/`community`
// onto an org that was still paying for Y.
//
// The rule, decided inside the statement (the row is read and written by the same `INSERT … ON
// CONFLICT DO UPDATE … WHERE` / `UPDATE … WHERE`, so two racing deliveries cannot both act on a
// stale read):
//   - SAME subscription as the row: applies unless the event is OLDER than the newest one already
//     applied for it (the event-time watermark), or it would bring a `canceled` row back to life
//     (`canceled`/`incomplete_expired` are terminal in Stripe, so only a stale event can say so).
//     A write with NO event time (a server action's read) has no place on the watermark, so it may
//     only hold or RAISE the lifecycle rank (`none` < live < `canceled`), never lower it (#5547).
//   - A DIFFERENT subscription: applies only when the row holds nothing live (its status is `none`
//     or `canceled`), or when the incoming one is PAID (active/trialing) and the row holds either
//     an unpaid `past_due` subscription or no subscription id at all (an off-Stripe grant, which a
//     Stripe purchase has always been able to replace). That second clause is the superseder.
//   - An ENDED event (`canceled`) touches only the row naming that same subscription. It never
//     creates a row and never lands on a row naming another subscription.
// Anything refused leaves the row byte-for-byte unchanged and the write reports `false`.

/** The billing statuses under which a subscription still holds the org's row. */
const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;

/**
 * Where a status sits in ONE subscription's lifecycle — incomplete (`none`) → live → ended. Breaks
 * a tie between two events stamped in the same second (Stripe's `created` has one-second
 * resolution): the later lifecycle stage wins, so `incomplete` cannot follow `active` on a tie.
 */
function lifecycleRank(status: BillingStatus): number {
	if (status === "none") return 0;
	if (status === "canceled") return 2;
	return 1;
}

/** The three columns that describe one subscription slot on the row (org plan, or AI). */
interface SubscriptionSlot {
	subscriptionId: typeof organizationBilling.stripeSubscriptionId | typeof organizationBilling.aiStripeSubscriptionId;
	status: typeof organizationBilling.status | typeof organizationBilling.aiSubscriptionStatus;
	eventAt:
		| typeof organizationBilling.stripeSubscriptionEventAt
		| typeof organizationBilling.aiStripeSubscriptionEventAt;
}

const PLAN_SLOT: SubscriptionSlot = {
	subscriptionId: organizationBilling.stripeSubscriptionId,
	status: organizationBilling.status,
	eventAt: organizationBilling.stripeSubscriptionEventAt,
};

const AI_SLOT: SubscriptionSlot = {
	subscriptionId: organizationBilling.aiStripeSubscriptionId,
	status: organizationBilling.aiSubscriptionStatus,
	eventAt: organizationBilling.aiStripeSubscriptionEventAt,
};

/** One subscription event as the guard sees it. */
interface IncomingSubscription {
	subscriptionId: string;
	status: BillingStatus;
	/** Stripe's event `created` time; null when the caller has no event (a server action). */
	eventAt: Date | null;
}

/** The event time as a SQL timestamptz parameter (NULL when there is none). */
function eventAtParam(eventAt: Date | null): SQL {
	return sql`${eventAt ? eventAt.toISOString() : null}::timestamptz`;
}

/** `lifecycleRank` of the slot's STORED status, as SQL — the same three bands, in the database. */
function storedLifecycleRank(slot: SubscriptionSlot): SQL {
	return sql`(CASE ${slot.status} WHEN 'none' THEN 0 WHEN 'canceled' THEN 2 ELSE 1 END)`;
}

/**
 * The predicate, over the EXISTING row, under which an event for the row's OWN subscription may
 * be applied: never reviving an ended subscription, and then —
 *
 * - WITH an event time: not older than the watermark (a same-second tie goes to the later
 *   lifecycle stage).
 * - WITHOUT one (a server action's sync, #5547): only when it does not LOWER the lifecycle rank.
 *
 * Why a rank guard and not "stamp the action's write with its read time": a read time is on OUR
 * clock while the watermark is Stripe's event `created`, and for most webhook events eventAt is
 * only a LOWER bound on the state written. `customer.subscription.created`/`.updated`,
 * `checkout.session.completed`, `invoice.payment_succeeded` and `invoice.payment_failed` each
 * write a fresh `subscriptions.retrieve` made after the event was created; only
 * `customer.subscription.deleted` writes the event's own snapshot (lib/billing/webhook-handler.ts).
 * An action stamped at its read time would therefore refuse a later-delivered retrieve-based event
 * whose state is newer than the action's read, and a refused webhook is never retried — the row
 * would be stuck until the subscription's next event. The rank guard needs no clock: the stale
 * case it refuses is exactly the one that can happen (`subscriptions.update` returning
 * `incomplete` after the `active` webhook already landed), while a raise (`none` → live, live →
 * `canceled`) and a move within the live band (equal rank, e.g. `past_due` → `active`) still
 * apply, so a trial start, a link and a real cancellation are unchanged.
 *
 * A limit a future caller must know: `mapStatus` (lib/billing/sync.ts) maps every Stripe status it
 * does not name — `incomplete`, and also `paused` — to `none`, rank 0. A no-time write of a
 * `paused` subscription over a live row is therefore REFUSED. Pausing is a real transition out of
 * the live band, not a stale read, so a caller that can observe one must not sync without an event
 * time: it must pass the time it read the subscription as `eventAt` (and accept the clock caveat
 * above), or leave the change to the `customer.subscription.updated` webhook, which carries its own.
 */
function sameSubscriptionMayApply(slot: SubscriptionSlot, incoming: IncomingSubscription): SQL {
	const notRevived =
		incoming.status === "canceled" ? sql`true` : sql`${slot.status} <> 'canceled'`;
	const at = eventAtParam(incoming.eventAt);
	const rank = lifecycleRank(incoming.status);
	const fresh = incoming.eventAt
		? sql`(${slot.eventAt} IS NULL OR ${slot.eventAt} < ${at} OR (${slot.eventAt} = ${at} AND ${rank} >= ${storedLifecycleRank(slot)}))`
		: sql`(${rank} >= ${storedLifecycleRank(slot)})`;
	return sql`(${slot.subscriptionId} = ${incoming.subscriptionId} AND ${notRevived} AND ${fresh})`;
}

/**
 * The full ON CONFLICT predicate for a non-ended event: the same-subscription rule, or a different
 * subscription taking over a row that holds nothing live, or a PAID one superseding an unpaid /
 * subscription-less row. See the block comment above for why each clause exists.
 */
function subscriptionMayApply(slot: SubscriptionSlot, incoming: IncomingSubscription): SQL {
	const live = sql.join(
		LIVE_STATUSES.map((s) => sql`${s}`),
		sql`, `,
	);
	const supersedes = isBillingActive(incoming.status)
		? sql` OR ${slot.subscriptionId} IS NULL OR ${slot.status} = 'past_due'`
		: sql``;
	return sql`(${sameSubscriptionMayApply(slot, incoming)} OR (${slot.subscriptionId} IS DISTINCT FROM ${incoming.subscriptionId} AND (${slot.status}::text NOT IN (${live})${supersedes})))`;
}

/**
 * The watermark to store when an event applies: the newer of the stored and incoming times when
 * it is the same subscription, otherwise the incoming time (a new subscription starts its own).
 */
function nextEventAt(slot: SubscriptionSlot, incoming: IncomingSubscription): SQL {
	const at = eventAtParam(incoming.eventAt);
	return sql`CASE WHEN ${slot.subscriptionId} IS NOT DISTINCT FROM ${incoming.subscriptionId} THEN GREATEST(${slot.eventAt}, ${at}) ELSE ${at} END`;
}

/** One Stripe subscription's state, as the webhook sync writes it onto the org-plan columns. */
export interface SubscriptionBillingWrite {
	organizationId: string;
	plan: BillingPlan;
	status: BillingStatus;
	stripeCustomerId: string;
	stripeSubscriptionId: string;
	seats: number | null;
	currentPeriodEnd: Date | null;
	/** Stripe's event `created` time; null from a server action that read the subscription live. */
	eventAt: Date | null;
}

/**
 * Applies one Stripe subscription's state to the org-plan columns, IF the guard above allows it,
 * and returns whether it did. The check and the write are one statement, so it is atomic against a
 * concurrent delivery. This — not `upsertOrgBilling` — is the write path for Stripe subscription
 * events (lib/billing/sync.ts).
 */
export async function applySubscriptionToBilling(
	input: SubscriptionBillingWrite,
): Promise<boolean> {
	const now = new Date();
	const incoming: IncomingSubscription = {
		subscriptionId: input.stripeSubscriptionId,
		status: input.status,
		eventAt: input.eventAt,
	};
	const fields = {
		plan: input.plan,
		status: input.status,
		stripeCustomerId: input.stripeCustomerId,
		stripeSubscriptionId: input.stripeSubscriptionId,
		seats: input.seats,
		currentPeriodEnd: toValidDate(input.currentPeriodEnd),
		updatedAt: now,
	};
	const db = getServiceDb();
	if (input.status === "canceled") {
		// An ended subscription touches only the row that names it — never inserts, never lands on a
		// row naming another subscription.
		const rows = await db
			.update(organizationBilling)
			.set({ ...fields, stripeSubscriptionEventAt: nextEventAt(PLAN_SLOT, incoming) })
			.where(
				and(
					eq(organizationBilling.organizationId, input.organizationId),
					sameSubscriptionMayApply(PLAN_SLOT, incoming),
				),
			)
			.returning({ id: organizationBilling.id });
		return rows.length > 0;
	}
	const rows = await db
		.insert(organizationBilling)
		.values({
			organizationId: input.organizationId,
			...fields,
			stripeSubscriptionEventAt: input.eventAt,
		})
		.onConflictDoUpdate({
			target: organizationBilling.organizationId,
			set: { ...fields, stripeSubscriptionEventAt: nextEventAt(PLAN_SLOT, incoming) },
			setWhere: subscriptionMayApply(PLAN_SLOT, incoming),
		})
		.returning({ id: organizationBilling.id });
	return rows.length > 0;
}

/** One STANDALONE AI subscription's state, as the webhook sync writes it onto the AI columns. */
export interface AiSubscriptionWrite {
	organizationId: string;
	aiTier: AiTier;
	aiSubscriptionStatus: BillingStatus;
	aiStripeSubscriptionId: string;
	/** Stripe's event `created` time; null from a server action that read the subscription live. */
	eventAt: Date | null;
}

/**
 * Applies a standalone AI subscription's state to ONLY the AI columns, under the same guard as
 * `applySubscriptionToBilling` (over the AI subscription id, status and watermark), and returns
 * whether it did. The org-plan columns are never touched — the AI product is orthogonal, so an org
 * can be e.g. community plan + AI Plus. Creates the row (plan defaults to community) if the org has
 * none, except for an ended subscription, which only ever updates the row naming it.
 */
export async function applyAiSubscriptionToBilling(
	input: AiSubscriptionWrite,
): Promise<boolean> {
	const now = new Date();
	const incoming: IncomingSubscription = {
		subscriptionId: input.aiStripeSubscriptionId,
		status: input.aiSubscriptionStatus,
		eventAt: input.eventAt,
	};
	const fields = {
		aiTier: input.aiTier,
		aiSubscriptionStatus: input.aiSubscriptionStatus,
		aiStripeSubscriptionId: input.aiStripeSubscriptionId,
		updatedAt: now,
	};
	const db = getServiceDb();
	if (input.aiSubscriptionStatus === "canceled") {
		const rows = await db
			.update(organizationBilling)
			.set({ ...fields, aiStripeSubscriptionEventAt: nextEventAt(AI_SLOT, incoming) })
			.where(
				and(
					eq(organizationBilling.organizationId, input.organizationId),
					sameSubscriptionMayApply(AI_SLOT, incoming),
				),
			)
			.returning({ id: organizationBilling.id });
		return rows.length > 0;
	}
	const rows = await db
		.insert(organizationBilling)
		.values({
			organizationId: input.organizationId,
			...fields,
			aiStripeSubscriptionEventAt: input.eventAt,
		})
		.onConflictDoUpdate({
			target: organizationBilling.organizationId,
			set: { ...fields, aiStripeSubscriptionEventAt: nextEventAt(AI_SLOT, incoming) },
			setWhere: subscriptionMayApply(AI_SLOT, incoming),
		})
		.returning({ id: organizationBilling.id });
	return rows.length > 0;
}

/**
 * Atomically claims the one-time "welcome to your plan" email for an org: sets
 * `welcomed_at` only if it was null, returning true for the single caller that won
 * the claim. Makes the welcome exactly-once across the webhook, the synchronous
 * trial-start path, and Stripe retries — no matter how many `sync` calls race.
 */
export async function claimPlanWelcome(orgId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.update(organizationBilling)
		.set({ welcomedAt: new Date() })
		.where(
			and(
				eq(organizationBilling.organizationId, orgId),
				isNull(organizationBilling.welcomedAt),
			),
		)
		.returning({ id: organizationBilling.id });
	return rows.length > 0;
}

/** Looks up the org a Stripe customer belongs to (set as subscription metadata). */
export async function getOrgByStripeCustomer(
	stripeCustomerId: string,
): Promise<OrganizationBilling | null> {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.stripeCustomerId, stripeCustomerId))
		.limit(1);
	return row ?? null;
}
