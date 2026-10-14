"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing server actions (hosted): start a Stripe Checkout to upgrade the active org's
// plan, or open the Customer Portal to manage an existing subscription. Both are
// owner-gated (the manage_billing permission via the PDP) and operate on the actor's
// active org — never a client-supplied org id. Stripe then drives the
// organization_billing record through the webhook; entitlements follow.

import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { RESERVED_SLUGS } from "@/lib/routing";
import {
	aiPaidTiersEnabled,
	aiPriceIdForTier,
	deploymentMode,
	getStripeConfig,
	isStripeConfigured,
	isStripeTaxEnabled,
	meterPriceIdForPlan,
	type PaidAiTier,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { creditPack } from "@/lib/billing/ai-credits";
import {
	AI_SESSION_WINDOW_MS,
	type AiTier,
	type AiPlanContext,
	aiTierSpec,
	effectiveAiTierSpec,
	resolveAiPlan,
	resolveAiTier,
} from "@/lib/billing/ai-plan";
import { canOrgInvite } from "@/lib/billing/collaboration";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";
import {
	type PaidConversionContext,
	assertOrgPaidConversionAllowed,
	assertPaidConversionAllowed,
	hasAcceptedCurrentDocuments,
} from "@/lib/billing/eligibility";
import type { PayerCapacity } from "@repo/legal/commerce";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { countBillableSeats } from "@/lib/billing/seats";
import type { TaxIdType } from "@/lib/billing/tax-ids";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";
import { type Money, money } from "@repo/format";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { currencyFromRequest } from "@/lib/billing/currency";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getOrgInvoice, listOrgInvoices } from "@/lib/billing/invoices";
import { backupRankOf, setBackupOrder } from "@/lib/billing/payment-methods";
import {
	getAllAiPrices,
	getAllPlanPrices,
	getPlanPrice,
	type LiveAiPriceMap,
	type LivePlanPriceMap,
} from "@/lib/billing/pricing";
import { getPurchaseStripe, getStripe, STRIPE_MAX_NETWORK_RETRIES, STRIPE_REQUEST_TIMEOUT_MS } from "@/lib/billing/stripe";
import { withPurchaseLock } from "@/lib/billing/purchase-lock";
import {
	fenceFor,
	type PurchaseLease,
	PurchaseLeaseLostError,
	renewPurchaseLease,
	type StripeWriteFence,
	UNFENCED,
	withPurchaseLease,
} from "@/lib/billing/purchase-lease";
import {
	type FirstPayment,
	type PaymentAfterCancel,
	readFirstPayment,
	readPaymentAfterCancel,
} from "@/lib/billing/first-payment";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { emitAlertEvent } from "@/lib/alerts/emit";
import {
	type FirstPaymentRead,
	type NewOrgPlanReport,
	type NewOrgPlanState,
	newOrgPlanState,
	PAYMENT_DEPENDENT_STATUSES,
} from "@/lib/billing/new-org-plan-state";
import { endedSetupClause, endedSetupRead, type NewOrgSetupState, PAID_SUBSCRIPTION_STATUSES } from "@/lib/billing/new-org-setup";
import {
	composeNewOrgHoldCopy,
	HOLD_NOT_RECORDED,
	holdClause,
	type KeptPayment,
	LIVE_CHECK_FAILED,
	NOT_CONFIRMED_CLOSED,
	PAID_SETUP_ELSEWHERE,
} from "@/lib/billing/new-org-hold-copy";
import { type AdvanceResult, advanceHold, decideOpen, LINK_REFUSED_NOTE } from "@/lib/billing/payment-holds/machine";
import { type HoldStripeReader, observeHold } from "@/lib/billing/payment-holds/observe";
import { type OpenHoldResult, openHold } from "@/lib/billing/payment-holds/store";
import {
	LINK_REFUSED_ALERTED,
	LINK_REFUSED_ORG_HAS_PLAN,
	linkSetupToOrg,
	liveSweepDeps,
	machineDepsFor,
	relinkAdoptedSetup,
} from "@/lib/billing/payment-holds/sweeper";
import {
	FORGETTABLE_RELEASES,
	findSetupOrg,
	forgetPendingOrgSetup,
	liveCheckSetupCustomers,
	newestUnlinkedSetupAt,
	logBillingEvent,
	markPendingOrgSetupDeclared,
	markPendingOrgSetupLinked,
	openPaymentHoldOn,
	openPendingOrgSetupsForOrg,
	paymentHoldsOfPayer,
	pendingOrgSetupBillingSchema,
	latestReleasedHoldOn,
	pendingOrgSetupFor,
	pendingOrgSetupSlugSchema,
	type PendingOrgSetupRow,
	REPLACEABLE_SUBSCRIPTION_STATUSES,
	recordPendingOrgSetup,
	recordSetupRefusal,
	savePendingOrgSetupDetails,
	settleOpenSetup,
	type UnfinishedSetupCursor,
	unfinishedPendingOrgSetups,
	UNLINKED_SETUP_CUSTOMER_CAP,
	unlinkedPendingOrgSetupCustomers,
} from "@/lib/billing/pending-org-setup";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { displayName } from "@/lib/user-display";
import { isOrgPlanSubscription, mapStatus, syncSubscriptionToBilling } from "@/lib/billing/sync";
import { computeUsage, type UsageSummary } from "@/lib/billing/usage";
import {
	queryJobMinutesByOrg,
	queryJobMinutesSeries,
} from "@/lib/queries/runner-usage";
import {
	aiCreditsSeries,
	oldestUsageSince,
	purchasedBalance,
	sumCredits,
} from "@/lib/billing/ai-quota";
import {
	queryResourceCounts,
	queryRunningJobs,
	type ResourceCounts,
} from "@/lib/queries/usage-counts";
import { authorize, authorizeInOrg, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import type {
	BillingPlan,
	BillingStatus,
	InvoiceStatus,
} from "@/lib/db/schema/enums";
import {
	alertDeliveries,
	type Invoice,
	member,
	organization,
	organizationBilling,
	type PaymentHoldRow,
	pendingOrgSetups,
	user,
} from "@/lib/db/schema";

/**
 * The single, coherent plan lifecycle state the billing card renders off — derived from the
 * live subscription so the badge, period wording, "next charge" line, and CTA can never
 * disagree. `canceling` = live but set to cancel at period end (show "Cancels …" + "Resume");
 * the rest map straight from `BillingStatus`.
 */
export type PlanState =
	| "none"
	| "trialing"
	| "active"
	| "canceling"
	| "past_due"
	| "canceled";

/** Collapses status + the cancel-at-period-end flag into one coherent lifecycle state. */
function derivePlanState(
	status: BillingStatus,
	cancelAtPeriodEnd: boolean,
): PlanState {
	if (cancelAtPeriodEnd && (status === "active" || status === "trialing")) {
		return "canceling";
	}
	return status;
}

/** Read-only billing state for the active org, for the /settings/billing page. */
export interface BillingSummary {
	/** Stripe is wired on this deployment (hosted). Self-managed → no upgrade UI. */
	hosted: boolean;
	/** The actor has a real workspace (org), not just their personal scope. */
	hasOrg: boolean;
	plan: BillingPlan;
	status: BillingStatus;
	/** The one coherent lifecycle state that drives every label + CTA on the plan card. */
	state: PlanState;
	/** ISO timestamp the current paid period ends, if subscribed. */
	currentPeriodEnd: string | null;
	/** A Stripe customer exists → cards/invoices are available. */
	canManage: boolean;
	/** The subscription is set to cancel at period end (show "resume"). */
	cancelAtPeriodEnd: boolean;
	/** Subscribed seat count (Team's per-seat quantity), or null for flat plans. */
	seats: number | null;
	/** Current members in the org — the "used" side of the seats meter. */
	memberCount: number;
	/**
	 * The actual per-seat (or flat) monthly amount the org is billed, in MINOR units WITH ITS
	 * CURRENCY — read live from the subscription's Stripe price (so a grandfathered sub shows its
	 * real amount), or the live plan price when there's no sub. null = custom/unknown. Stripe is
	 * authoritative; never compute the displayed amount from the catalog.
	 *
	 * THIS WAS `unitAmountUsd: number` PLUS A SEPARATE `currency: string` (#4176 part b). The name
	 * was false from the day the live-subscription branch read the price's own currency — a EUR
	 * subscription put euros in a field called `Usd` — and the separate `currency` was a second
	 * field a renderer had to remember to read. It is one value now, because the two halves were
	 * only ever meaningful together.
	 *
	 * IT ALSO DROPPED A `/ 100`. The old field held MAJOR units, divided out of Stripe's
	 * `unit_amount` by a hardcoded 100 right here and multiplied back up by a hardcoded 100 three
	 * renders later in `billing-panel.tsx`. The two cancelled for a two-decimal currency and
	 * nothing else: a ¥124,000 subscription would have travelled as 1240 and rendered as ¥124,000
	 * only because the second 100 undid the first. Minor units all the way through means the
	 * conversion has no halves to keep in step.
	 */
	unitAmount: Money | null;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;

	// Member count seeds the seats meter; only meaningful in a real org.
	let memberCount = 0;
	if (hasOrg) {
		const [c] = await getServiceDb()
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, actor.orgId));
		memberCount = c?.n ?? 0;
	}

	const plan = billing?.plan ?? "community";
	// Default to the DB row, then let a readable live subscription override the fields the
	// card renders (status / period / cancel flag) — so a stale or half-synced DB row can
	// never produce a self-contradictory card (e.g. "Canceled" next to "Renews …").
	let status: BillingStatus = billing?.status ?? "none";
	let cancelAtPeriodEnd = false;
	let currentPeriodEnd: string | null =
		billing?.currentPeriodEnd?.toISOString() ?? null;
	// Authoritative price: the subscription's OWN flat (non-metered) Stripe price — this
	// reflects what the org is actually charged, including grandfathered amounts.
	let unitAmount: Money | null = null;
	if (billing?.stripeSubscriptionId && isStripeConfigured()) {
		try {
			const sub = await getStripe().subscriptions.retrieve(
				billing.stripeSubscriptionId,
			);
			status = mapStatus(sub.status);
			cancelAtPeriodEnd = sub.cancel_at_period_end;
			const flat = sub.items.data.find(
				(i) => i.price.recurring?.usage_type !== "metered",
			);
			// Only a LIVE (active/trialing) sub reflects what the org is actually billed. A
			// canceled/past_due sub has reverted to Hobby, so its old price must NOT leak
			// through (otherwise a canceled org shows "Hobby · $20/mo"). Same gate applies to
			// the period end — a lapsed sub shows no renewal/cancellation date.
			const live = status === "active" || status === "trialing";
			if (live && typeof flat?.price.unit_amount === "number") {
				// Stripe's `unit_amount` is already minor units, and so is `Money.minor` — no
				// conversion, which is the point of #4176 part (b). The currency is the price's
				// own, whatever Stripe says it is; nothing here narrows it.
				unitAmount = money(flat.price.unit_amount, flat.price.currency);
			}
			currentPeriodEnd =
				live && flat?.current_period_end
					? new Date(flat.current_period_end * 1000).toISOString()
					: null;
		} catch {
			// Subscription unreadable (deleted upstream) — fall back to the DB row.
		}
	}
	// No live sub price (or no sub yet) → fall back to the plan's live Stripe price, in the
	// currency that price is denominated in. `amounts[currency]` rather than a `usd` field: the
	// fallback used to read `LivePlanPrice.unitAmountUsd` and label it `"usd"` by hand, which is
	// the same assumption one layer up. An org with no live sub sees the plan's base-currency
	// price; which currency it will actually be BILLED in is settled at checkout, not here.
	if (unitAmount === null && plan !== "community") {
		const price = await getPlanPrice(plan);
		unitAmount = price.amounts[price.currency] ?? null;
	}

	return {
		hosted: isStripeConfigured(),
		hasOrg,
		plan,
		status,
		state: derivePlanState(status, cancelAtPeriodEnd),
		currentPeriodEnd,
		canManage: Boolean(billing?.stripeCustomerId),
		cancelAtPeriodEnd,
		seats: billing?.seats ?? null,
		memberCount,
		unitAmount,
	};
}

/** Live prices for every plan (Stripe-authoritative, catalog fallback) — the buy-flow's
 *  single fetch, consumed client-side via useLivePlanPrice. Any SIGNED-IN caller: the prices are
 *  public, but each call is three Stripe price reads (react `cache` is per-request only), so an
 *  anonymous caller could spend the account's Stripe rate limit that checkout depends on (#5219).
 *  Every consumer renders inside the app, and the hook falls back to the catalog on a refusal. */
export async function getLivePlanPrices(): Promise<LivePlanPriceMap> {
	await currentActor();
	return getAllPlanPrices();
}

/** Live prices for every standalone AI tier (Stripe-authoritative, catalog fallback) —
 *  consumed client-side via useLiveAiPrice. Degrades to the placeholder catalog prices when
 *  the AI Stripe prices aren't configured (pre-cutover). Any signed-in caller. */
export async function getLiveAiPrices(): Promise<LiveAiPriceMap> {
	// Signed-in only, for the same Stripe-rate-limit reason as getLivePlanPrices.
	await currentActor();
	return getAllAiPrices();
}

/** Managed-runner usage for the active org's current period (read-only; any member). */
export interface UsageReport extends UsageSummary {
	periodStart: string;
	periodEnd: string;
	plan: BillingPlan;
	/** "Pause at the included allowance instead of billing overage" is enabled. */
	hardCap: boolean;
	/** Jobs currently in flight (CLAIMED/PROCESSING) — the concurrency gauge "used". */
	runningJobs: number;
	/** The plan's max concurrent jobs, or null when unlimited (Enterprise). */
	maxConcurrentJobs: number | null;
}

/**
 * Job-minutes consumed on managed runners this period vs the plan's included
 * allowance, with the overage estimate. The customer-facing usage meter
 * (lib/billing/usage). Self-hosted runners never count.
 */
export async function getOrgUsage(): Promise<UsageReport> {
	const actor = await currentActor();
	const billing = await getOrgBilling(actor.orgId).catch(() => null);
	const plan = billing?.plan ?? "community";
	const status = billing?.status ?? "none";
	const quotas = resolvePlanEntitlements(plan, status).quotas;
	const included = quotas.includedRunnerMinutes;

	const now = new Date();
	const from = effectiveBillingPeriodStart(
		billing?.currentPeriodStart,
		billing?.currentPeriodEnd,
		now,
	);

	const hasOrg = actor.orgId !== actor.userId;
	const [rows, runningJobs] = await Promise.all([
		queryJobMinutesByOrg(getServiceDb(), { from, to: now, orgId: actor.orgId }),
		hasOrg ? queryRunningJobs(actor.orgId) : Promise.resolve(0),
	]);
	const used = rows[0]?.job_minutes ?? 0;

	return {
		...computeUsage(used, included),
		periodStart: from.toISOString(),
		periodEnd: (billing?.currentPeriodEnd ?? now).toISOString(),
		plan,
		hardCap: billing?.usageHardCap ?? false,
		runningJobs,
		maxConcurrentJobs: quotas.maxConcurrentJobs,
	};
}

// ── Usage page: resource counts, over-time series, AI summary ───────────────

/** Point-in-time resource counts for the active org's Usage page (read-only; any member). */
export type ResourceCountsReport = ResourceCounts;

/** Projects / clusters counts + estimated spend under management for the active org. */
export async function getResourceCounts(): Promise<ResourceCountsReport> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) {
		return { projects: 0, clusters: 0, spendUnderManagement: 0 };
	}
	return queryResourceCounts(actor.orgId);
}

/** One day of cumulative usage for the over-time chart. */
export interface UsagePoint {
	/** ISO date (YYYY-MM-DD), the bucket's UTC day. */
	date: string;
	runnerMinutes: number;
	jobs: number;
	aiCredits: number;
}

/** Range-windowed cumulative usage (the picker-driven section of the Usage page). */
export interface UsageOverTime {
	series: UsagePoint[];
	totals: { runnerMinutes: number; jobs: number; aiCredits: number };
}

/** Inclusive list of UTC day keys (YYYY-MM-DD) spanning [from, to], to fill chart gaps. */
function utcDayKeys(from: Date, to: Date): string[] {
	const keys: string[] = [];
	const cursor = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
	);
	const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
	// Guard against an inverted range; cap at ~13 months so a 12-month preset is safe.
	for (let i = 0; cursor.getTime() <= end && i < 400; i++) {
		keys.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return keys;
}

/**
 * Cumulative usage over an arbitrary window for the active org — runner-minutes, jobs,
 * and AI credits, day-bucketed onto a continuous axis (empty days are zero-filled).
 * Read-only (any member); managed-runner basis only, matching getOrgUsage. The window
 * is supplied by the client's time-range picker as ISO timestamps.
 */
export async function getUsageOverTime(input: {
	from: string;
	to: string;
}): Promise<UsageOverTime> {
	const actor = await currentActor();
	const from = new Date(input.from);
	const to = new Date(input.to);
	if (
		Number.isNaN(from.getTime()) ||
		Number.isNaN(to.getTime()) ||
		from >= to ||
		actor.orgId === actor.userId
	) {
		return { series: [], totals: { runnerMinutes: 0, jobs: 0, aiCredits: 0 } };
	}

	const [minuteRows, aiRows] = await Promise.all([
		queryJobMinutesSeries(getServiceDb(), { from, to, orgId: actor.orgId }),
		aiCreditsSeries(actor.orgId, from, to),
	]);
	const minuteByDay = new Map(minuteRows.map((r) => [r.day, r]));
	const aiByDay = new Map(aiRows.map((r) => [r.day, r.credits]));

	const series: UsagePoint[] = utcDayKeys(from, to).map((date) => {
		const m = minuteByDay.get(date);
		return {
			date,
			runnerMinutes: Math.round(m?.job_minutes ?? 0),
			jobs: m?.job_count ?? 0,
			aiCredits: aiByDay.get(date) ?? 0,
		};
	});
	const totals = series.reduce(
		(acc, p) => ({
			runnerMinutes: acc.runnerMinutes + p.runnerMinutes,
			jobs: acc.jobs + p.jobs,
			aiCredits: acc.aiCredits + p.aiCredits,
		}),
		{ runnerMinutes: 0, jobs: 0, aiCredits: 0 },
	);
	return { series, totals };
}

/**
 * The active org's STANDALONE AI standing — rolling 5-hour session + fixed weekly included
 * spend vs the AI tier's caps (the % denominators), on the SAME windows the guard
 * (ai-guard.ts) enforces, plus the remaining purchased top-up balance and the tier.
 * Read-only; any member. The single canonical AI-usage action (drives the overview card,
 * the Usage panel, and the billing AI section).
 */
export interface AiUsageSummary {
	/** AI enabled for this org's tier (always true today; future-proofs a disabled tier). */
	enabled: boolean;
	/** The org's standalone AI tier (independent of the org plan). */
	tier: AiTier;
	/** Included credits used inside the rolling 5-hour session window. */
	sessionUsed: number;
	/** The tier's session included-credit cap (the session-% denominator). */
	sessionBudget: number;
	/**
	 * When the current session fully clears: oldest in-window usage + 5h (ISO). `null`
	 * when there is no usage in the window — no active session (the UI shows an idle
	 * state instead of a countdown).
	 */
	sessionResetAt: string | null;
	/** Included credits used in the current fixed week. */
	weeklyUsed: number;
	/** The tier's weekly included-credit cap (the weekly-% denominator). */
	weeklyBudget: number;
	/** When the weekly bucket resets (ISO). */
	weeklyResetAt: string;
	/** Remaining purchased top-up credits (Σ grants − Σ purchased usage). */
	purchasedBalance: number;
	/**
	 * Whether the paid AI tiers + credit packs are self-serve on this deployment (both
	 * Stripe AI prices configured). Drives the upgrade UI's "Coming soon" gate — the only
	 * config signal that crosses to the client (a plain boolean, never the price ids).
	 */
	paidTiersEnabled: boolean;
	/** Admin org-wide weekly spend limit in credits (null = tier default). Reflected in weeklyBudget. */
	orgWeeklyCapCredits: number | null;
	/** Admin per-seat weekly spend limit in credits (null = tier default). */
	perUserWeeklyCapCredits: number | null;
	/** Whether the current actor may edit these spend limits (manage_billing). */
	canManageCaps: boolean;
}

const AI_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getAiUsageSummary(): Promise<AiUsageSummary> {
	const actor = await currentActor();
	const plan = await resolveAiPlan(actor.orgId).catch((): AiPlanContext => ({
		tier: "ai_free",
		hardCap: false,
		orgWeeklyCapCredits: null,
		perUserWeeklyCapCredits: null,
	}));
	// Budgets shown reflect any admin spend limits (min(tier, cap)).
	const spec = effectiveAiTierSpec(aiTierSpec(plan.tier), plan);
	const paidTiersEnabled = aiPaidTiersEnabled();

	// Spend limits are an org-admin control — never offered in personal scope.
	let canManageCaps = false;
	if (actor.orgId !== actor.userId) {
		canManageCaps = await authorizeQuiet("manage_billing", { type: "billing" })
			.then(() => true)
			.catch(() => false);
	}
	const capFields = {
		orgWeeklyCapCredits: plan.orgWeeklyCapCredits,
		perUserWeeklyCapCredits: plan.perUserWeeklyCapCredits,
		canManageCaps,
	};

	const now = Date.now();
	const sessionSince = new Date(now - AI_SESSION_WINDOW_MS);
	const weekStart = new Date(Math.floor(now / AI_WEEK_MS) * AI_WEEK_MS);
	const weeklyResetAt = new Date(weekStart.getTime() + AI_WEEK_MS).toISOString();

	if (actor.orgId === actor.userId) {
		return {
			enabled: spec.enabled,
			tier: plan.tier,
			sessionUsed: 0,
			sessionBudget: spec.sessionCredits,
			sessionResetAt: null,
			weeklyUsed: 0,
			weeklyBudget: spec.weeklyCredits,
			weeklyResetAt,
			purchasedBalance: 0,
			paidTiersEnabled,
			...capFields,
		};
	}

	const [sessionUsed, weeklyUsed, purchased, oldestInWindow] =
		await Promise.all([
			sumCredits(actor.orgId, "included", sessionSince),
			sumCredits(actor.orgId, "included", weekStart),
			purchasedBalance(actor.orgId),
			oldestUsageSince(actor.orgId, "included", sessionSince),
		]);
	return {
		enabled: spec.enabled,
		tier: plan.tier,
		sessionUsed,
		sessionBudget: spec.sessionCredits,
		sessionResetAt: oldestInWindow
			? new Date(oldestInWindow.getTime() + AI_SESSION_WINDOW_MS).toISOString()
			: null,
		weeklyUsed,
		weeklyBudget: spec.weeklyCredits,
		weeklyResetAt,
		purchasedBalance: purchased,
		paidTiersEnabled,
		...capFields,
	};
}

/**
 * Toggle the active org's "pause at included instead of overage" policy
 * (owner-gated). A pure usage-policy flag — independent of Stripe.
 */
export async function setUsageHardCap(enabled: boolean): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	await getServiceDb()
		.update(organizationBilling)
		.set({ usageHardCap: enabled, updatedAt: new Date() })
		.where(eq(organizationBilling.organizationId, actor.orgId));
}

/**
 * Set the org's admin AI-spend limits (credits/week) — Claude-Enterprise-style ceilings that
 * only ever TIGHTEN the tier's caps (min(tier, limit)): an org-wide weekly cap and a per-seat
 * weekly cap. Pass `null` to clear a limit (back to the tier default). Owner-gated. A no-op
 * for an org with no billing row (implicitly free — its caps are already the floor).
 */
export async function setAiSpendCaps(
	orgWeeklyCapCredits: number | null,
	perUserWeeklyCapCredits: number | null,
): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const norm = (v: number | null): number | null =>
		v == null || !Number.isFinite(v) || v < 0 ? null : Math.floor(v);
	await getServiceDb()
		.update(organizationBilling)
		.set({
			aiOrgWeeklyCapCredits: norm(orgWeeklyCapCredits),
			aiPerUserWeeklyCapCredits: norm(perUserWeeklyCapCredits),
			updatedAt: new Date(),
		})
		.where(eq(organizationBilling.organizationId, actor.orgId));
}

/** Guards that billing is actually wired (hosted control plane) before any Stripe call. */
function requireHostedBilling(): void {
	if (!isStripeConfigured()) {
		throw new Error(
			`Billing is not enabled on this deployment (${deploymentMode()} mode).`,
		);
	}
}

/** New-subscription items: the flat plan item + (if configured) the graduated metered
 *  runner-minutes item. Metered items carry no quantity. */
function planCreateItems(
	plan: PaidPlan,
	quantity: number,
): Stripe.SubscriptionCreateParams.Item[] {
	const items: Stripe.SubscriptionCreateParams.Item[] = [
		{ price: priceIdForPlan(plan), quantity },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** Checkout line items: flat plan + (if configured) metered runner-minutes. */
function planCheckoutLineItems(
	plan: PaidPlan,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
	const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
		{ price: priceIdForPlan(plan), quantity: 1 },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** All configured metered price IDs — to recognize an existing metered sub item. */
function configuredMeterPriceIds(): Set<string> {
	const ids = new Set<string>();
	for (const p of ["team", "enterprise"] as const) {
		const id = meterPriceIdForPlan(p);
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * Returns the org's Stripe customer id, creating + persisting one on first use. The
 * customer carries organization_id metadata so webhook events resolve back to the org.
 */
async function ensureCustomer(
	orgId: string,
	userId: string,
	billingEmail?: string,
): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (billing?.stripeCustomerId) {
		if (billingEmail) {
			await getStripe().customers.update(billing.stripeCustomerId, {
				email: billingEmail,
			});
		}
		return billing.stripeCustomerId;
	}

	const db = getServiceDb();
	const [u] = await db
		.select({ email: user.email, name: user.name })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const [org] = await db
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);

	const customer = await getStripe().customers.create({
		email: billingEmail || u?.email,
		name: org?.name,
		metadata: { organization_id: orgId, created_by: userId },
	});

	// Persist the customer id without disturbing any existing plan/status.
	await upsertOrgBilling({
		organizationId: orgId,
		plan: billing?.plan ?? "community",
		status: billing?.status ?? "none",
		stripeCustomerId: customer.id,
		stripeSubscriptionId: billing?.stripeSubscriptionId ?? null,
		seats: billing?.seats ?? null,
		currentPeriodEnd: billing?.currentPeriodEnd ?? null,
	});
	return customer.id;
}

/**
 * What the org-plan purchase's sweep found about one earlier subscription, as the answer to "may a new
 * one be minted beside it?" (#5463, #5489). NOTHING HERE IS REMEMBERED BETWEEN REQUESTS: the org-plan
 * purchase opens no payment hold (ADR 0002 §7), so each outcome is only what THIS request saw. The
 * create-a-team purchase does not use these: it closes its subscriptions under payment holds, which
 * remember (ADR 0002 S8).
 *   - `settled` — no money is moving: none was taken and the latest invoice can no longer be paid
 *     (voided, already void, or none), or what was taken is already refunded. Only this one mints;
 *   - `processing` — an `incomplete` subscription the sweep KEPT because its first payment is not proven
 *     unpaid. It was not cancelled, so the next purchase's sweep finds it again;
 *   - `refunded` — money was taken after the cancel, and this request refunded it in full;
 *   - `unsettled` / `unsettled_alerted` — nothing proves the subscription is closed and unpaid: a payment
 *     still processing or awaiting capture after the cancel, payments that could not be read (twice), an
 *     open invoice that could not be voided, or a cancel that could not be confirmed;
 *   - `needs_support` — money was taken after the cancel and the refund failed;
 *   - `unconfirmed` / `unconfirmed_alerted` — what was taken cannot be read: payments that are not
 *     PaymentIntents (or more than one page of them), or an invoice that reads `paid` although no
 *     PaymentIntent on it took the money.
 * Every outcome but `settled` and `processing` raises an operator alert (`alertPaymentNeedsSupport`);
 * the `_alerted` forms mean it reached a channel, which is the only case the customer is told so.
 */
type PaymentOutcome =
	| "settled"
	| "processing"
	| "refunded"
	| "unsettled"
	| "unsettled_alerted"
	| "needs_support"
	| "unconfirmed"
	| "unconfirmed_alerted";

/** `unsettled`, split by whether the operator alert it raised reached a channel. */
function unsettled(alerted: boolean): "unsettled" | "unsettled_alerted" {
	return alerted ? "unsettled_alerted" : "unsettled";
}

/** `unconfirmed`, split by whether the operator alert it raised reached a channel. */
function unconfirmed(alerted: boolean): "unconfirmed" | "unconfirmed_alerted" {
	return alerted ? "unconfirmed_alerted" : "unconfirmed";
}

/**
 * What `cancelIncompleteSubscriptions` did: the subscriptions it cancelled as provably unpaid (each
 * with the `readFirstPayment` verdict that allowed it); the `incomplete` ones it KEPT because their
 * first payment is not provably unpaid — in flight, taken, or unreadable; for each one it tried to
 * cancel that did not end `cancelled` — a payment found afterwards, or a cancel that could not be
 * proven (#5489) — what became of it. Anything in `kept` or `unsettled` refuses the purchase. `overCap`
 * means the customer has more `incomplete` subscriptions than the sweep reads (`SWEEP_SUBSCRIPTION_CAP`):
 * nothing was cancelled, every list is empty, and the purchase refuses.
 */
interface IncompleteSweep {
	cancelled: { sub: Stripe.Subscription; firstPayment: FirstPayment }[];
	kept: Stripe.Subscription[];
	unsettled: PaymentOutcome[];
	overCap: boolean;
}

/**
 * What a caller tells the customer when an `incomplete` subscription's first payment is not proven
 * unpaid (`processing`): it was kept, not cancelled, so the next purchase's sweep reads it again and
 * refuses again until it settles.
 *
 * It does not promise "a minute" (#5463), and it names no deadline: a bank debit (SEPA, ACH) can take
 * several business days to settle. An unreadable payment clears on a retry once Stripe answers.
 */
const PAYMENT_MAY_BE_UNDER_WAY =
	"An earlier payment on this checkout is still being processed, or could not be checked. Nothing new was started, and you won't be charged twice. If Stripe could not be reached, try again in a few minutes. A bank debit can take several business days to settle, and a new purchase stays blocked until it does.";

/** What a caller tells the customer when this request refunded a payment taken for a cancelled checkout. */
const EARLIER_PAYMENT_REFUNDED =
	"An earlier payment on this checkout went through after that checkout had been cancelled, so it has been refunded in full. A refund can take 5–10 business days to reach your account. Nothing new was started — start the purchase again to continue.";

/** Where the customer reaches support from a billing refusal: the operator's published support inbox. */
const SUPPORT_EMAIL = LEGAL_ENTITY.supportEmail;

/**
 * What a caller tells the customer when an earlier subscription is not proven closed and unpaid
 * (`unsettled`). It does NOT say a later purchase stays blocked, or that they won't be charged twice:
 * nothing records this refusal, and a subscription cancelled while its payment was processing (or
 * whose invoice could not be voided) is invisible to the next purchase's sweep, which lists only
 * `incomplete` ones. So it tells the customer the two things that are true — wait and retry, or ask
 * support first — and it claims no alert (`EARLIER_PAYMENT_UNSETTLED_ALERTED` does, when one reached a
 * channel).
 */
const EARLIER_PAYMENT_UNSETTLED = `We could not confirm that an earlier checkout was closed without taking a payment — its payment may still be processing, or Stripe could not be reached — so nothing new was started. Try again later: a bank debit can take several business days to settle. If you are not sure whether that payment went through, contact support at ${SUPPORT_EMAIL} with the time of the payment before you try again.`;

/** `EARLIER_PAYMENT_UNSETTLED` when the operator alert DID reach a channel (`unsettled_alerted`). */
const EARLIER_PAYMENT_UNSETTLED_ALERTED = `We could not confirm that an earlier checkout was closed without taking a payment — its payment may still be processing, or Stripe could not be reached — so nothing new was started. We have raised an alert with our team. Try again later: a bank debit can take several business days to settle. If you are not sure whether that payment went through, contact support at ${SUPPORT_EMAIL} with the time of the payment before you try again.`;

/**
 * What a caller tells the customer when a payment taken for a cancelled checkout could not be refunded
 * (`needs_support`). It does not say a later purchase is blocked (nothing records it), and it does not
 * say anyone was alerted: the customer is sent to support before trying again.
 */
const EARLIER_PAYMENT_NEEDS_SUPPORT = `An earlier payment on this checkout went through after that checkout had been cancelled, and it could not be refunded automatically. Nothing new was started. Contact support at ${SUPPORT_EMAIL} with the time of the payment before you try again.`;

/**
 * What a caller tells the customer when nothing proves what an earlier payment took (`unconfirmed`):
 * a payment that is not a PaymentIntent, or an invoice paid by something other than a PaymentIntent.
 * It claims neither that money moved nor that a later purchase is blocked, nor that anyone was alerted
 * (#5489): the alert did not reach a channel, so the customer is the one who has to tell support.
 */
const EARLIER_PAYMENT_UNCONFIRMED = `We could not confirm what happened to an earlier payment on this checkout, so nothing new was started. Contact support at ${SUPPORT_EMAIL} with the time of the payment before you try again.`;

/**
 * `EARLIER_PAYMENT_UNCONFIRMED` when the operator alert DID reach a channel (`unconfirmed_alerted`):
 * an alert delivery was queued to a channel bound to an enabled rule for the event, so saying it was
 * raised is true.
 */
const EARLIER_PAYMENT_UNCONFIRMED_ALERTED = `We could not confirm what happened to an earlier payment on this checkout, so nothing new was started. We have raised an alert with our team. Contact support at ${SUPPORT_EMAIL} with the time of the payment before you try again.`;

/**
 * What a caller tells the customer when there are more earlier checkouts than the purchase reads before
 * it refuses (ADR 0002 §4.5): more `incomplete` subscriptions on one customer than
 * `SWEEP_SUBSCRIPTION_CAP`, or more unfinished create-a-team setups than `UNLINKED_SETUP_CUSTOMER_CAP`
 * customers. It claims no alert: whether one reached a channel is not threaded through to this copy.
 */
const TOO_MANY_EARLIER_CHECKOUTS = `This account has more unfinished checkouts than we can check automatically, so nothing new was started. Contact support at ${SUPPORT_EMAIL} and we will clear them.`;

/** What the org-plan purchase tells the customer when the org already has a live plan: the row's, or one Stripe lists (#5977). */
const LIVE_PLAN_REFUSAL = "This organization already has an active subscription — change the plan instead.";

/**
 * What the org-plan purchase tells the customer when its live check (`liveOrgPlanCheck`) met more
 * subscriptions on the org's customer than `SWEEP_SUBSCRIPTION_CAP`, so it read none of them as clear.
 * It claims no alert: whether one reached a channel is not threaded through to this copy.
 */
const TOO_MANY_SUBSCRIPTIONS_TO_CHECK = `This organization has more subscriptions than we can check automatically, so nothing new was started. Contact support at ${SUPPORT_EMAIL}.`;

/** The event the platform operator's alert rules route; the one `alertPaymentNeedsSupport` raises. */
const OPERATOR_ALERT_EVENT = "system.platform.payment_needs_support";

/**
 * Logs, and alerts the platform operator about, a purchase finding — of the create-a-team purchase or the
 * org-plan one — whose wording is NOT `alertPaymentNeedsSupport`'s: that one always says the subscription
 * is one "which the purchase flow cancelled or was replacing", which is false for these (ADR 0002 §4.2 (1)). `subject` is the alert's
 * resource, so a rule's throttle collapses repeats for the same one. Raised on the platform operator's
 * org (`ALETHIA_PLATFORM_ALERT_ORG_ID`); with it unset only the log line is written. Resolves true only
 * when a delivery was queued to a channel. Never throws.
 */
async function alertOperator(input: {
	title: string;
	subject: { type: "stripe_subscription" | "stripe_customer" | "user"; id: string };
	summary: string;
}): Promise<boolean> {
	console.error(`[billing] operator alert — ${input.summary}`);
	const orgId = process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	if (!orgId) return false;
	try {
		const queued = await emitAlertEvent(orgId, OPERATOR_ALERT_EVENT, {
			title: input.title,
			summary: input.summary,
			severity: "critical",
			resource_type: input.subject.type,
			resource_id: input.subject.id,
		});
		return queued > 0;
	} catch (err) {
		console.error(`[alerts] emit failed (${OPERATOR_ALERT_EVENT}):`, err);
		return false;
	}
}

/**
 * ADR 0002 §4.2 (1): the create-a-team sweep met an `incomplete` subscription on one of the user's
 * customers that is not the user's create-a-team subscription — an org's plan or AI checkout on a shared
 * customer, or another user's. It was left alone, and the purchase is NOT refused for it (it cannot
 * double-charge this purchase); this alert is the trace a person acts on.
 */
async function alertForeignSubscription(sub: Stripe.Subscription, customerId: string, userId: string): Promise<void> {
	await alertOperator({
		title: "A create-a-team purchase left another payer's checkout alone",
		subject: { type: "stripe_subscription", id: sub.id },
		summary: `Subscription ${sub.id} (customer ${customerId}) is incomplete on a customer the create-a-team purchase of user ${userId} sweeps, but it is not that user's create-a-team subscription (created_by ${sub.metadata?.created_by ?? "none"}, organization_id ${sub.metadata?.organization_id ?? "none"}). It was not cancelled. Check why the customer is shared.`,
	});
}

/** ADR 0002 §4.5: a customer has more `incomplete` subscriptions than the sweep reads, so the purchase refused. */
async function alertSweepOverCap(customerId: string): Promise<void> {
	await alertOperator({
		title: "A purchase refused: too many incomplete subscriptions to sweep",
		subject: { type: "stripe_customer", id: customerId },
		summary: `Customer ${customerId} has more than ${SWEEP_SUBSCRIPTION_CAP} incomplete subscriptions, so the purchase sweep read none of them and refused. Clear them by hand.`,
	});
}

/** What a caller tells the customer when another purchase for the same payer holds the lock or lease past the wait. */
const PURCHASE_IN_PROGRESS =
	"Another purchase on this account is being started right now, so nothing new was started. Wait a moment and try again.";

/**
 * What the create-a-team purchase tells the customer when it lost its lease mid-request (a fence threw
 * `PurchaseLeaseLostError`): another request took it over, OR it simply lapsed while this one was waiting
 * on Stripe and nobody took it. Either way this request stopped before its next Stripe write.
 */
const PURCHASE_STOPPED =
	"This purchase took too long and was stopped, or another one on this account took over, so nothing new was started. Wait a moment and try again.";

/** Where the open-setup guard sends the setup's creator (ADR 0002 §5.5). */
const OPEN_SETUP_CREATOR_NEXT = `Open Create a team to see where it stands, or contact support at ${SUPPORT_EMAIL}.`;

/**
 * The open-setup guard's refusal, to the setup's creator (ADR 0002 §5.5). When an open payment hold
 * names the setup's subscription, that hold's clause replaces the first sentence (`holdClause`).
 */
const OPEN_SETUP_CREATOR_FIRST =
	"Your paid setup for this team has not finished, so a plan cannot be started here yet.";
const OPEN_SETUP_CREATOR = `${OPEN_SETUP_CREATOR_FIRST} ${OPEN_SETUP_CREATOR_NEXT}`;

/**
 * The open-setup guard's refusal, to anyone but the creator (ADR 0002 §5.5): it names who started the
 * setup and offers support. It never says "finish" or "finished", in any form — the setup is the
 * creator's to complete, and this member can do nothing with that word but misread it as an action.
 */
function openSetupOtherMember(creator: string): string {
	return `${creator} started paying for this team's plan and it is still being set up, so a plan cannot be started here yet. Ask them, or contact support at ${SUPPORT_EMAIL}.`;
}

/** The open-setup guard's refusal when its Stripe read failed — it fails closed (ADR 0002 §5.7). */
const OPEN_SETUP_UNCHECKED =
	"We could not check this team's earlier paid setup just now, so a plan cannot be started yet. Try again in a few minutes.";

/**
 * THE OPEN-SETUP GUARD (ADR 0002 §5.7, #5714). An org is created before its paid create-a-team
 * subscription X is linked to it, so its billing row cannot show X yet; a plan, a Checkout or a trial
 * started there in that window minted a second subscription Y beside X, and X then renewed unseen.
 * `createSubscriptionIntent`, `createCheckoutSession` and `startProTrial` call this before any Stripe
 * write and refuse with what it returns; null lets the purchase proceed.
 *
 * It reads every OPEN setup naming the org (service role: the buyer may be a co-owner, whom RLS shows
 * nothing of the creator's row) and runs the setup closer on each first, so an ended X, or one already
 * linked in Stripe, never blocks the org. A setup still open after that refuses — the creator is sent to
 * Create a team or support, anyone else is told who started it. Only the creator's display name, from
 * the org's own member list, leaves the creator's row. A closer that THROWS refuses the purchase with
 * the try-again clause: a failed read never passes it (fail closed).
 */
async function openSetupRefusal(actor: { userId: string; orgId: string }): Promise<string | null> {
	const rows = await openPendingOrgSetupsForOrg(actor.orgId);
	for (const row of rows) {
		let verdict: Awaited<ReturnType<typeof settleOpenSetup>>;
		try {
			verdict = await settleOpenSetup(row, { orgId: actor.orgId });
		} catch (e) {
			console.error(`[billing] open-setup guard could not check ${row.subscription_id}:`, e);
			return OPEN_SETUP_UNCHECKED;
		}
		if (verdict !== "open") continue;
		// Message selection, not access control: the purchase is refused either way, and `actor` was
		// authorized by the PDP for this org upstream. This only picks which sentence the refusal reads.
		if (row.user_id === actor.userId) return creatorRefusal(row.subscription_id); // authz-scope-ok: picks the refusal's wording (creator vs co-owner); the refusal itself is unconditional and the caller is PDP-authorized upstream
		return openSetupOtherMember(await setupCreatorName(actor.orgId, row.user_id));
	}
	return null;
}

/**
 * The guard's refusal to the setup's creator: the clause of the open payment hold on the setup's
 * subscription in place of the first sentence, then where to go — else `OPEN_SETUP_CREATOR`. A
 * `refund_pending` hold does not block (Q10), so its clause cannot say why the plan is refused: the
 * refusal keeps its own first sentence, and the clause says only that the refund was issued.
 */
async function creatorRefusal(subscriptionId: string): Promise<string> {
	const hold = await openPaymentHoldOn(subscriptionId);
	const clause = hold ? holdClause(hold, { refusing: true }) : null;
	if (!hold || !clause) return OPEN_SETUP_CREATOR;
	return hold.state === "refund_pending"
		? `${OPEN_SETUP_CREATOR_FIRST} ${clause} ${OPEN_SETUP_CREATOR_NEXT}`
		: `${clause} ${OPEN_SETUP_CREATOR_NEXT}`;
}

/**
 * The setup creator's name as the org's member list shows it, or "Another member of this team" when
 * the creator is no longer a member of the org.
 */
async function setupCreatorName(orgId: string, userId: string): Promise<string> {
	const [creator] = await getServiceDb()
		.select({ name: user.name, email: user.email, username: user.username })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1);
	return creator ? displayName(creator) : "Another member of this team";
}

/**
 * The refusal for a set of `PaymentOutcome`s — the most serious one wins — or null when none refuses.
 * A form whose alert reached nobody outranks the one whose alert did, so the copy never says "we have
 * raised an alert" while any of the payments it covers was not alerted on.
 */
function refusalFor(outcomes: readonly PaymentOutcome[]): string | null {
	if (outcomes.includes("needs_support")) return EARLIER_PAYMENT_NEEDS_SUPPORT;
	if (outcomes.includes("unconfirmed")) return EARLIER_PAYMENT_UNCONFIRMED;
	if (outcomes.includes("unconfirmed_alerted")) return EARLIER_PAYMENT_UNCONFIRMED_ALERTED;
	if (outcomes.includes("unsettled")) return EARLIER_PAYMENT_UNSETTLED;
	if (outcomes.includes("unsettled_alerted")) return EARLIER_PAYMENT_UNSETTLED_ALERTED;
	if (outcomes.includes("processing")) return PAYMENT_MAY_BE_UNDER_WAY;
	if (outcomes.includes("refunded")) return EARLIER_PAYMENT_REFUNDED;
	return null;
}

/**
 * Refunds a PaymentIntent in full under an idempotency key derived from it. Within Stripe's 24-hour
 * idempotency window a repeated request with the same key replays the FIRST request's saved result: a
 * successful refund is replayed instead of a second one being made, and a refund that failed once
 * Stripe began executing it is replayed as that same failure — a repeat inside the window cannot
 * succeed where the first attempt failed. A charge Stripe says is already refunded is
 * `already_refunded`; any other failure is `failed`, with the error.
 */
async function refundTakenPayment(
	paymentIntentId: string,
	fence: StripeWriteFence,
): Promise<{ result: "refunded" | "already_refunded" } | { result: "failed"; error: unknown }> {
	await fence();
	try {
		await getStripe().refunds.create(
			{ payment_intent: paymentIntentId },
			{ idempotencyKey: `refund-cancelled-first-payment-${paymentIntentId}` },
		);
		return { result: "refunded" };
	} catch (e) {
		if (typeof e === "object" && e !== null && Reflect.get(e, "code") === "charge_already_refunded") {
			return { result: "already_refunded" };
		}
		return { result: "failed", error: e };
	}
}

/**
 * Runs a Stripe read, and runs it ONCE more if it fails (#5489): a single 429, 5xx or dropped
 * connection is not allowed to decide a purchase. The second failure is thrown to the caller, which
 * must treat it as "not proven".
 */
async function readTwice<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch {
		return read();
	}
}

/**
 * Proves a cancelled subscription's latest invoice can no longer be paid (#5489). Cancelling a
 * subscription does not void its open invoice — Stripe only stops collecting it automatically — so a
 * PaymentIntent awaiting the customer (`requires_payment_method`, `requires_confirmation`,
 * `requires_action`) stays confirmable from any page that still holds its client secret. A voided
 * invoice is not payable (docs.stripe.com/invoicing/overview, "Void invoices"), and Stripe voids only an
 * `open` or `uncollectible` invoice, so a void that succeeds also proves the invoice was not paid by
 * then.
 *   - `open` / `uncollectible`: voided — `voided`. A void that fails is followed by ONE re-read of the
 *     invoice: `void` by then (a void whose response was lost) is `voided`, anything else `failed`;
 *   - `void`, or no invoice at all: `nothing_payable`;
 *   - `paid`: `paid` — the caller decides what money it did not see means;
 *   - `draft`, or any status not listed here: `failed` — nothing proves it can never be paid. (An
 *     `incomplete` subscription's latest invoice is already finalized, so a draft is not expected.)
 * A read that fails twice (`readTwice`) is `failed`.
 */
async function voidPayableInvoice(
	sub: Pick<Stripe.Subscription, "latest_invoice">,
	fence: StripeWriteFence,
): Promise<{ result: "voided" | "nothing_payable" | "paid" } | { result: "failed"; error: unknown }> {
	const invoiceId =
		typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
	if (!invoiceId) return { result: "nothing_payable" };
	const stripe = getStripe();
	let status: string | null;
	try {
		status = (await readTwice(() => stripe.invoices.retrieve(invoiceId))).status;
	} catch (e) {
		return { result: "failed", error: e };
	}
	if (status === "void") return { result: "nothing_payable" };
	if (status === "paid") return { result: "paid" };
	if (status !== "open" && status !== "uncollectible") {
		return {
			result: "failed",
			error: new Error(`invoice ${invoiceId} is ${status ?? "of no status"}; nothing proves it can never be paid`),
		};
	}
	await fence();
	try {
		await stripe.invoices.voidInvoice(invoiceId);
		return { result: "voided" };
	} catch (voidError) {
		try {
			const reread = await stripe.invoices.retrieve(invoiceId);
			if (reread.status === "void") return { result: "voided" };
		} catch {
			// The re-read failed too: nothing proves the void.
		}
		return { result: "failed", error: voidError };
	}
}

/** The Stripe customer id a subscription hangs off, whether or not `customer` was expanded. */
function subscriptionCustomerId(sub: Pick<Stripe.Subscription, "customer">): string {
	return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

/**
 * Reads a subscription's payments right after the purchase flow cancelled it, and acts on them (#5463).
 * `customerId` is the Stripe customer it belongs to, named in any operator alert.
 * `settled` is returned ONLY when the subscription is cancelled (the caller proved that) AND its latest
 * invoice is voided, already void, or paid and refunded in full (#5489):
 *   - no money (none taken, or every PaymentIntent failed or was cancelled): its invoice is voided if it
 *     can still be paid (`voidPayableInvoice`) — `settled`. A void that fails is alerted on —
 *     `unsettled`. An invoice that reads `paid` although no PaymentIntent took money (a customer
 *     balance, an out-of-band payment) is alerted on — `unconfirmed`;
 *   - a PaymentIntent `processing` or awaiting capture: alerted on — `unsettled`;
 *   - payments that cannot be read, twice (`readTwice`): alerted on — `unsettled`;
 *   - money taken: each succeeded PaymentIntent is refunded in full (`refundTakenPayment`) — `refunded`,
 *     or `settled` when Stripe says they were refunded already. A refund that fails is alerted on —
 *     `needs_support`;
 *   - payments that are not PaymentIntents, or more than one page of them: alerted on — `unconfirmed`.
 * Nothing is recorded: the alert is the only trace a person can act on, because the next purchase's
 * sweep cannot see a cancelled subscription. The refund is issued only here, for a subscription this
 * request itself cancelled.
 */
async function settleCancelledSubscription(
	sub: Pick<Stripe.Subscription, "id" | "latest_invoice">,
	customerId: string,
	fence: StripeWriteFence,
): Promise<PaymentOutcome> {
	try {
		return await settleCancelledSubscriptionUnderFence(sub, customerId, fence);
	} catch (e) {
		if (!(e instanceof PurchaseLeaseLostError)) throw e;
		// The purchase lost its lease between the cancel and the writes that settle it (ADR 0002 §4.4
		// rule 1): it stops, so the invoice may still be open, or a payment unrefunded. Nothing records
		// this subscription, so the alert is the trace a person acts on. Then the stop is thrown on.
		await alertPaymentNeedsSupport({
			subscriptionId: sub.id,
			customerId,
			paymentIntentId: null,
			detail: "the purchase that ended it lost its lease before it could void its latest invoice or refund its payment, so that invoice may still be payable, or a payment unrefunded.",
			error: e,
		});
		throw e;
	}
}

/**
 * The body of `settleCancelledSubscription`: every Stripe write in it runs behind `fence`, which throws
 * `PurchaseLeaseLostError` when the purchase's lease is lost.
 */
async function settleCancelledSubscriptionUnderFence(
	sub: Pick<Stripe.Subscription, "id" | "latest_invoice">,
	customerId: string,
	fence: StripeWriteFence,
): Promise<PaymentOutcome> {
	let read: PaymentAfterCancel;
	try {
		read = await readTwice(() => readPaymentAfterCancel(sub));
	} catch (e) {
		const alerted = await alertPaymentNeedsSupport({
			subscriptionId: sub.id,
			customerId,
			paymentIntentId: null,
			detail: "its payments could not be read, twice, after the cancel, so nothing proves it took no money.",
			error: e,
		});
		return unsettled(alerted);
	}
	switch (read.kind) {
		case "no_money": {
			// No money now — but an open invoice can still be paid from a stale page. It is voided before
			// this subscription is called settled (#5489).
			const voided = await voidPayableInvoice(sub, fence);
			if (voided.result === "failed") {
				const alerted = await alertPaymentNeedsSupport({
					subscriptionId: sub.id,
					customerId,
					paymentIntentId: null,
					detail: "its latest invoice could not be voided, so its payment may still be completed from a page that holds it.",
					error: voided.error,
				});
				return unsettled(alerted);
			}
			if (voided.result === "paid") {
				const alerted = await alertPaymentNeedsSupport({
					subscriptionId: sub.id,
					customerId,
					paymentIntentId: null,
					detail: "its latest invoice reads paid, but no PaymentIntent on it took the money, so what was taken cannot be refunded automatically.",
				});
				return unconfirmed(alerted);
			}
			return "settled";
		}
		case "processing": {
			const alerted = await alertPaymentNeedsSupport({
				subscriptionId: sub.id,
				customerId,
				paymentIntentId: read.paymentIntentId,
				detail: "it was cancelled while this payment is processing. Nothing records it: if the payment succeeds, it must be refunded by hand.",
			});
			return unsettled(alerted);
		}
		case "unrecognised": {
			const alerted = await alertPaymentNeedsSupport({
				subscriptionId: sub.id,
				customerId,
				paymentIntentId: null,
				detail: "its invoice carries a payment that is not a PaymentIntent (or more than 100), so what was taken cannot be read or refunded automatically.",
			});
			return unconfirmed(alerted);
		}
		case "took_money": {
			let refunded = false;
			for (const paymentIntentId of read.succeeded) {
				const refund = await refundTakenPayment(paymentIntentId, fence);
				if (refund.result === "failed") {
					await alertPaymentNeedsSupport({
						subscriptionId: sub.id,
						customerId,
						paymentIntentId,
						detail: "its payment succeeded after the cancel, and the refund failed.",
						error: refund.error,
					});
					return "needs_support";
				}
				if (refund.result === "refunded") refunded = true;
			}
			return refunded ? "refunded" : "settled";
		}
	}
}

/** Subscription statuses under which Stripe will never collect a payment for it again. */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/**
 * Cancels a subscription that `readFirstPayment` just read as `never_paid`, then reads its payments
 * again (#5463). Stripe offers no "cancel only while unpaid", so a customer who completes the payment
 * between the read and the cancel pays for a subscription that is cancelled. That race is detected here,
 * not prevented, and acted on by `settleCancelledSubscription`: money taken is refunded; a payment still
 * processing, unreadable or unrefundable refuses THIS purchase and alerts an operator.
 *
 * A cancel that FAILS — a refusal, a 429, a 5xx, a dropped connection — proves nothing (#5489): the
 * subscription may still be `incomplete` with a PaymentIntent a stale page can confirm. The subscription
 * is read again once. Only `canceled` or `incomplete_expired` count as gone, and then it is settled like
 * any cancelled one (its invoice voided). Anything else, or a read that fails, is alerted on —
 * `unsettled` — and the caller must not mint beside it. It is still `incomplete`, so the next
 * purchase's sweep finds it and tries again.
 *
 * `customerId` is the Stripe customer it belongs to, named in any operator alert. `cancelled` means
 * gone, provably unpaid or refunded already, and its open invoice voided so no page
 * holding its client secret can pay it. Every other answer refuses.
 */
async function cancelNeverPaid(
	sub: Stripe.Subscription,
	customerId: string,
	fence: StripeWriteFence,
): Promise<"cancelled" | Exclude<PaymentOutcome, "settled">> {
	const stripe = getStripe();
	await fence();
	try {
		await stripe.subscriptions.cancel(sub.id);
	} catch (cancelError) {
		let status: string | null = null;
		try {
			status = (await stripe.subscriptions.retrieve(sub.id)).status;
		} catch {
			status = null;
		}
		if (status === null || !ENDED_SUBSCRIPTION_STATUSES.has(status)) {
			const alerted = await alertPaymentNeedsSupport({
				subscriptionId: sub.id,
				customerId,
				paymentIntentId: null,
				detail: `the cancel failed and the subscription reads ${status ?? "unreadable"}, so it may still be paid; nothing new is started beside it.`,
				error: cancelError,
			});
			return unsettled(alerted);
		}
	}
	const outcome = await settleCancelledSubscription(sub, customerId, fence);
	return outcome === "settled" ? "cancelled" : outcome;
}

/**
 * The most subscriptions `listCustomerSubscriptions` reads on one customer, in the status it lists
 * (`incomplete` for a sweep; every status, canceled ones included, for the create-a-team and org-plan live
 * checks), before it answers `over_cap` and the caller refuses (ADR 0002 §4.5).
 */
const SWEEP_SUBSCRIPTION_CAP = 1000;

/** One page of the sweep's `subscriptions.list` — Stripe's maximum. */
const SWEEP_PAGE = 100;

/**
 * Every subscription of `customerId` in `status` (`incomplete` for a sweep, `all` for the create-a-team
 * and org-plan live checks), paged to the end with `starting_after` (ADR 0002 §4.5, C20) — or `over_cap` when there are
 * more than `SWEEP_SUBSCRIPTION_CAP`. Never a list it stopped reading early: one more page beyond the cap
 * is what `over_cap` means, and the caller refuses on it. A page that fails is thrown.
 */
async function listCustomerSubscriptions(
	stripe: Stripe,
	customerId: string,
	status: "incomplete" | "all",
): Promise<{ kind: "all"; subs: Stripe.Subscription[] } | { kind: "over_cap" }> {
	const subs: Stripe.Subscription[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			status,
			limit: SWEEP_PAGE,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		subs.push(...page.data);
		const last = page.data.at(-1);
		if (!page.has_more || !last) return { kind: "all", subs };
		if (subs.length >= SWEEP_SUBSCRIPTION_CAP) return { kind: "over_cap" };
		startingAfter = last.id;
	}
}

/**
 * CLASSIFICATION (ADR 0002 §2, §4.2): a subscription is user `userId`'s create-a-team subscription when
 * ITS OWN metadata has `created_by = userId` and no `organization_id`. The customer it hangs off is never
 * evidence — a customer can be shared with an org whose org-plan or AI checkout sits beside it.
 */
function isCreateATeamSubscriptionOf(sub: Pick<Stripe.Subscription, "metadata">, userId: string): boolean {
	return sub.metadata?.created_by === userId && !sub.metadata?.organization_id;
}

/**
 * THE ORG-PLAN SWEEP: cancels the org customer's dangling `incomplete` subscriptions — the never-paid
 * first-invoice subs that a re-opened upgrade sheet would otherwise pile up (each one Stripe
 * auto-generates a draft invoice for). Stateless: it lists Stripe directly rather than the DB, so it
 * cleans up even the subs that were never persisted to organization_billing — the exact leak the old
 * DB-only guard missed. A list that fails is thrown, so nothing is minted. It touches every one on the
 * customer, which is the org's own. (The create-a-team purchase has its own sweep, under payment holds:
 * `closeOrKeep`.)
 *
 * Every page is read (`listCustomerSubscriptions`); a customer with more than `SWEEP_SUBSCRIPTION_CAP`
 * of them is not swept at all and answers `overCap`, which refuses.
 *
 * WHICH CLIENT (ADR 0002 S2 hand-off, decided in S3). This sweep and its helpers — `cancelNeverPaid`,
 * `voidPayableInvoice`, `refundTakenPayment` — stay on the shared client (`getStripe()`, the SDK's
 * 80s / 2 retries), not the purchase client: `lib/billing/stripe.ts` keeps the org-plan purchase on the
 * shared client's defaults, and the first-payment reads they depend on (`lib/billing/first-payment.ts`)
 * are on the shared client anyway.
 *
 * `incomplete` is not "never paid": Stripe keeps a subscription `incomplete` while its first payment
 * is `processing`, and until its invoice settles after the payment succeeded. So each one is cancelled
 * only when `readFirstPayment` proves it unpaid (read twice, `readTwice`); any other — or one whose
 * payment cannot be read — is KEPT and returned, and the caller must not start a second purchase beside
 * it. Every one it tried to cancel that did not end `cancelled` (`cancelNeverPaid`) — a payment that
 * completed between the read and the cancel, or a cancel that could not be proven — is reported in
 * `unsettled` with what became of it.
 */
async function cancelIncompleteSubscriptions(customerId: string, fence: StripeWriteFence): Promise<IncompleteSweep> {
	const sweep: IncompleteSweep = { cancelled: [], kept: [], unsettled: [], overCap: false };
	const listed = await listCustomerSubscriptions(getStripe(), customerId, "incomplete");
	if (listed.kind === "over_cap") return { ...sweep, overCap: true };
	for (const s of listed.subs) {
		let firstPayment: FirstPayment;
		try {
			firstPayment = await readTwice(() => readFirstPayment(s));
		} catch {
			firstPayment = "not_proven_unpaid";
		}
		if (firstPayment !== "never_paid") {
			sweep.kept.push(s);
			continue;
		}
		const outcome = await cancelNeverPaid(s, customerId, fence);
		if (outcome === "cancelled") sweep.cancelled.push({ sub: s, firstPayment });
		else sweep.unsettled.push(outcome);
	}
	return sweep;
}

/**
 * THE ORG-PLAN LIVE CHECK (ADR 0002 §10.2 F3, #5977): every subscription on the org's customer, of every
 * status, paged to the end (`listCustomerSubscriptions`). A live (`active`, `trialing`, `past_due`)
 * org-plan one refuses with "change the plan instead" — the row alone cannot see one whose webhook has
 * not been written yet, nor a `past_due` one. An AI subscription on the same customer is not a plan.
 * Over the cap it refuses and alerts the operator; a page that fails is thrown, so nothing is minted.
 * Answers the refusal's copy, or null when the purchase may go ahead.
 */
async function liveOrgPlanCheck(customerId: string): Promise<string | null> {
	const listed = await listCustomerSubscriptions(getStripe(), customerId, "all");
	if (listed.kind === "over_cap") {
		await alertOperator({
			title: "An org-plan purchase refused: too many subscriptions to check",
			subject: { type: "stripe_customer", id: customerId },
			summary: `Customer ${customerId} has more than ${SWEEP_SUBSCRIPTION_CAP} subscriptions, so the org-plan purchase's live check read none of them as clear and refused. Canceled subscriptions count toward the cap (the check lists every status) and Stripe keeps them, so cancelling more does not clear it. The fix is a new Stripe customer for the org: once no live subscription remains on this one, point the org's organization_billing stripe_customer_id at a customer with no subscription history.`,
		});
		return TOO_MANY_SUBSCRIPTIONS_TO_CHECK;
	}
	const live = listed.subs.some((s) => PAID_SUBSCRIPTION_STATUSES.has(s.status) && isOrgPlanSubscription(s));
	return live ? LIVE_PLAN_REFUSAL : null;
}

/** A sweep as `PaymentOutcome`s: a kept subscription may be under way; an unsettled one says what became of it. */
function sweepOutcomes(sweep: IncompleteSweep): PaymentOutcome[] {
	return [...sweep.unsettled, ...sweep.kept.map((): PaymentOutcome => "processing")];
}

/**
 * Starts a Stripe Checkout to subscribe the active org to a paid plan. Requires a real
 * org (not the personal scope — create a workspace first). Returns the redirect URL.
 */
/**
 * THE gate. Every action below that can take money calls this before it touches Stripe.
 *
 * It is a thin wrapper on purpose: the RULE lives in lib/billing/eligibility.ts, and this only
 * supplies the org's declared payer facts. Six conversion entry points each carrying their own
 * version of the rule is how a compliance requirement becomes decorative — the seventh will not
 * have one — so `tests/billing/eligibility-coverage.test.ts` reds when an exported action in this
 * file reaches Stripe's subscription/payment APIs without passing through here.
 */
async function gatePaidConversion(actor: {
	userId: string;
	orgId: string;
}): Promise<void> {
	await assertOrgPaidConversionAllowed(actor.userId, actor.orgId);
}

export async function createCheckoutSession(
	plan: PaidPlan,
): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before subscribing to a plan.");
	}
	// Before any Stripe write (#5714): the org's unlinked paid setup must not get a plan beside it.
	const openSetup = await openSetupRefusal(actor);
	if (openSetup) throw new Error(openSetup);
	await gatePaidConversion(actor);

	const cfg = getStripeConfig();
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	// The row alone misses a live plan whose webhook has not been written yet (#5977).
	const livePlan = await liveOrgPlanCheck(customerId);
	if (livePlan) throw new Error(livePlan);
	// Stripe Tax: compute VAT/sales tax + collect the customer's Tax/VAT id (EU B2B
	// reverse-charge). Gated until the account's Tax settings are configured.
	const tax: Partial<Stripe.Checkout.SessionCreateParams> = isStripeTaxEnabled()
		? {
				automatic_tax: { enabled: true },
				tax_id_collection: { enabled: true },
				customer_update: { name: "auto", address: "auto" },
			}
		: {};
	const session = await getStripe().checkout.sessions.create({
		mode: "subscription",
		customer: customerId,
		line_items: planCheckoutLineItems(plan),
		subscription_data: {
			metadata: { organization_id: actor.orgId },
			// Team gets a one-month free trial (the public "Start free trial" CTA).
			// Flat tiers subscribe immediately.
			...(plan === "team" ? { trial_period_days: 30 } : {}),
		},
		allow_promotion_codes: true,
		...tax,
		success_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=success`,
		cancel_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=cancelled`,
	});
	if (!session.url) throw new Error("Stripe did not return a checkout URL.");
	return { url: session.url };
}

/** A subscription awaiting its first payment, for the embedded Payment Element. */
export interface SubscriptionIntent {
	clientSecret: string;
	subscriptionId: string;
	/** The currency the subscription was created in (Stripe locks it) — drives the UI toggle. */
	currency: SupportedCurrency;
}

/**
 * Creates an incomplete subscription for the active org and returns the client secret
 * of its first invoice's payment — the embedded (in-app) alternative to hosted
 * Checkout. The <PaymentForm> confirms it (card + 3-D Secure inline); the webhook then
 * activates the org. Owner-gated; org-scoped; refuses if a live subscription already
 * exists (use changeSubscriptionPlan instead).
 */
export async function createSubscriptionIntent(
	plan: PaidPlan,
	opts?: { billingEmail?: string; currency?: SupportedCurrency },
): Promise<SubscriptionIntent | { error: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		return { error: "Create an organization before subscribing to a plan." };
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.stripeSubscriptionId &&
		(existing.status === "active" || existing.status === "trialing")
	) {
		return { error: LIVE_PLAN_REFUSAL };
	}
	// After the live-plan check (so a live plan still reads "change the plan instead"), before any
	// Stripe write (#5714): the org's unlinked paid setup must not get a second plan beside it.
	const openSetup = await openSetupRefusal(actor);
	if (openSetup) return { error: openSetup };
	await gatePaidConversion(actor);
	// One purchase per org at a time (#5489): two tabs that each read "nothing in flight" before either
	// minted would otherwise each mint a payable subscription.
	const locked = await withPurchaseLock(`org-plan:${actor.orgId}`, () =>
		startOrgSubscription(actor, plan, opts),
	);
	return locked.acquired ? locked.value : { error: PURCHASE_IN_PROGRESS };
}

/**
 * The body of `createSubscriptionIntent`, run under the org's purchase lock: resolves the customer,
 * sweeps its `incomplete` subscriptions, runs the live check (`liveOrgPlanCheck`), and mints the new one.
 */
async function startOrgSubscription(
	actor: { orgId: string; userId: string },
	plan: PaidPlan,
	opts: { billingEmail?: string; currency?: SupportedCurrency } | undefined,
): Promise<SubscriptionIntent | { error: string }> {
	const customerId = await ensureCustomer(
		actor.orgId,
		actor.userId,
		opts?.billingEmail,
	);
	// Void every dangling incomplete sub for this customer before minting a fresh intent, so
	// re-opening the upgrade sheet can never pile up never-paid subs (and their draft
	// invoices). Stateless — works even though an incomplete sub is never persisted to the DB,
	// which is why the old organization_billing-only guard leaked.
	const swept = await cancelIncompleteSubscriptions(customerId, UNFENCED);
	if (swept.overCap) {
		await alertSweepOverCap(customerId);
		return { error: TOO_MANY_EARLIER_CHECKOUTS };
	}
	const sweptRefusal = refusalFor(sweepOutcomes(swept));
	if (sweptRefusal) return { error: sweptRefusal };
	// After the sweep, under the lock: a live plan the row does not show yet — its webhook unwritten, or
	// `past_due` — refuses rather than get a second plan minted beside it (#5977).
	const livePlan = await liveOrgPlanCheck(customerId);
	if (livePlan) return { error: livePlan };
	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Pro is per-seat: seed the quantity from the org's current billable members so an
	// org that already has a team is billed for them at subscribe time. Enterprise is flat.
	const quantity =
		plan === "team" ? Math.max(1, await countBillableSeats(actor.orgId)) : 1;
	// Resolve the billing currency BEFORE creating the subscription (Stripe locks it): an
	// explicit checkout selection wins, else the request's geo (Cloudflare CF-IPCountry).
	// The Price must carry this currency's option (scripts/stripe-setup.ts).
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems(plan, quantity),
		currency,
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		metadata: { organization_id: actor.orgId },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id, currency };
}

/**
 * Creates an incomplete STANDALONE AI subscription (ai_plus/ai_max) for the active org and
 * returns the client secret for its first payment — the embedded Payment Element flow. This
 * is a SEPARATE Stripe subscription from the org plan (its own price IDs), so an org can be
 * e.g. community plan + AI Plus. The webhook (sync.ts → aiTierForPriceId) routes its events
 * to the org's AI columns only. Owner-gated; org-scoped; refuses if a live AI subscription
 * already exists. Mirrors createSubscriptionIntent.
 */
export async function createAiSubscriptionIntent(
	tier: PaidAiTier,
	opts?: { billingEmail?: string; currency?: SupportedCurrency },
): Promise<SubscriptionIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before subscribing to an AI plan.");
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.aiStripeSubscriptionId &&
		(existing.aiSubscriptionStatus === "active" ||
			existing.aiSubscriptionStatus === "trialing")
	) {
		throw new Error(
			"This organization already has an active AI subscription — change it instead.",
		);
	}
	await gatePaidConversion(actor);
	const customerId = await ensureCustomer(
		actor.orgId,
		actor.userId,
		opts?.billingEmail,
	);
	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Resolve the billing currency before creating the sub (Stripe locks it): an explicit
	// selection wins, else the request's geo. The AI Price must carry this currency's option
	// (scripts/stripe-setup.ts provisions USD + EUR).
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: [{ price: aiPriceIdForTier(tier), quantity: 1 }],
		currency,
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		// product_type lets the webhook recognise an AI sub even before it inspects the
		// price; organization_id resolves the tenant (same as the org-plan sub).
		metadata: { organization_id: actor.orgId, product_type: "ai_subscription" },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the AI subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id, currency };
}

/**
 * Starts a 30-day Pro trial for the active org WITHOUT collecting a payment method —
 * zero-friction onboarding. The subscription begins in `trialing` immediately (no
 * invoice, no card); at trial end Stripe CANCELS it if no card was added by then
 * (`missing_payment_method: "cancel"` → the org reverts to community/free; the user can
 * add a card from billing before then to continue). "cancel" is also the only end
 * behavior Stripe allows on a card-less trial that includes a metered item (the
 * runner-minutes meter). Syncs the billing row synchronously so the `organizations`
 * entitlement is live for the whole trial. Owner-gated; hosted-only; refuses if a
 * live/trialing subscription already exists. No automatic_tax here — there's no
 * address/invoice yet; tax is computed when the customer later adds payment.
 */
export async function startProTrial(opts?: {
	currency?: SupportedCurrency;
	/**
	 * The org to start the trial ON, when it is not the ambient one.
	 *
	 * NAMED, not ambient, for the same reason `linkSubscriptionToNewOrg` takes one (#4133). The
	 * create-org sheet runs from a page inside the CURRENT org, creates a new org, and then starts
	 * the trial on it — so under URL-wins the ambient org is the page the sheet is open on, i.e.
	 * the OLD one. Left ambient, the Stripe trial and the `organization_billing` row landed on the
	 * old org, the account's ONE trial was burned, and the new org stayed on `community`. Worse, if
	 * the old org already had a live subscription this threw, and the sheet's rollback then DELETED
	 * the org it had just created.
	 *
	 * Optional because the other caller is `onboarding-form`, which runs on a `(public)` route with
	 * no `[org]` segment — nothing for the URL to name, so the session is the only answer and the
	 * ambient path is correct there.
	 */
	orgId?: string;
}): Promise<void> {
	const actor = opts?.orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, opts.orgId)
		: await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before starting a trial.");
	}
	// One trial per ACCOUNT (not per org) — so spinning up extra orgs grants no extra
	// trials. The ledger lives on the user row; getProOffer reads the same flag.
	const [u] = await getServiceDb()
		.select({ proTrialConsumedAt: user.proTrialConsumedAt })
		.from(user)
		.where(eq(user.id, actor.userId))
		.limit(1);
	if (u?.proTrialConsumedAt) {
		throw new Error("Your account has already used its free Pro trial.");
	}
	// Robust to a never-stamped flag: refuse if the account already owns a live org.
	if (await accountHasLiveSubscription(actor.userId)) {
		throw new Error("Your account has already used its free Pro trial.");
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.stripeSubscriptionId &&
		(existing.status === "active" || existing.status === "trialing")
	) {
		throw new Error("This organization already has an active subscription.");
	}
	// Before any Stripe write (#5714): no trial beside the org's unlinked paid setup.
	const openSetup = await openSetupRefusal(actor);
	if (openSetup) throw new Error(openSetup);

	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	// Pin the currency now so the trial's eventual paid invoice bills correctly (Stripe
	// locks it at creation); explicit selection wins, else the request geo.
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems("team", 1),
		currency,
		trial_period_days: 30,
		trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
		metadata: { organization_id: actor.orgId },
	});

	// Activate the entitlement deterministically (don't wait for the webhook).
	await syncSubscriptionToBilling(sub);

	// Burn the account's one trial only after Stripe accepted it.
	await getServiceDb()
		.update(user)
		.set({ proTrialConsumedAt: new Date(), updatedAt: new Date() })
		.where(eq(user.id, actor.userId));
}

/**
 * Whether the account already owns an org on a live (active/trialing) subscription. The
 * Pro trial is one-per-account, so this is the authoritative "already used a trial/seat"
 * signal — robust to a `pro_trial_consumed_at` that was never stamped (legacy data).
 */
async function accountHasLiveSubscription(userId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.select({ status: organizationBilling.status })
		.from(member)
		.innerJoin(
			organizationBilling,
			eq(organizationBilling.organizationId, member.organizationId),
		)
		.where(and(eq(member.userId, userId), eq(member.role, "owner")));
	return rows.some((r) => r.status === "active" || r.status === "trialing");
}

/** What the account is eligible for on Pro: a one-time trial, or nothing (already
 *  used / billing not wired). A single seam for future targeted offers (discount, …). */
export interface ProOffer {
	kind: "trial" | "none";
	/** Length of the trial in days, when `kind === "trial"`. */
	trialDays?: number;
}

/**
 * The Pro offer for the current account — the basis for showing a "Start trial" CTA
 * vs requiring payment. `trial` only while the account hasn't consumed its single
 * account-wide trial and hosted billing is configured; otherwise `none`. Read by both
 * /onboarding and the create-org sheet so the trial is offered wherever the user first
 * reaches for Pro, but only ever once.
 */
export async function getProOffer(): Promise<ProOffer> {
	if (!isStripeConfigured()) return { kind: "none" };
	const actor = await currentActor();
	const [u] = await getServiceDb()
		.select({ proTrialConsumedAt: user.proTrialConsumedAt })
		.from(user)
		.where(eq(user.id, actor.userId))
		.limit(1);
	if (u?.proTrialConsumedAt) return { kind: "none" };
	// Belt-and-suspenders over the flag: if the account already owns a live (active/
	// trialing) org, the one-per-account trial is effectively spent — don't re-offer it
	// (guards against a flag that was never stamped on a legacy trial).
	if (await accountHasLiveSubscription(actor.userId)) return { kind: "none" };
	return { kind: "trial", trialDays: 30 };
}

/**
 * Whether the active org may invite teammates (the pay-to-collaborate gate): true on a
 * paid subscription or a card-backed trial, false for a card-less trial / personal
 * scope. The UI signal behind the "Add payment to invite your team" upsell; the actual
 * invite is also enforced server-side in the org plugin (canOrgInvite). Any member.
 */
export async function getCollaborationAccess(): Promise<{ canInvite: boolean }> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return { canInvite: false };
	return { canInvite: await canOrgInvite(actor.orgId) };
}

/**
 * Whether an org slug is still free. Used by the create-org sheet to validate the slug
 * BEFORE taking payment (the org itself isn't created until the charge succeeds), so a
 * collision surfaces inline instead of after the customer has paid. Authenticated only.
 */
export async function isOrgSlugAvailable(slug: string): Promise<boolean> {
	await currentActor();
	const normalized = slug.trim().toLowerCase();
	if (!normalized) return false;
	// Reserved slugs shadow console routes or are owned by the marketing zone /
	// sibling apps (see RESERVED_SLUGS) — never available even if unused in the DB.
	if (RESERVED_SLUGS.has(normalized)) return false;
	const [row] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, normalized))
		.limit(1);
	return !row;
}

/** A new-org subscription intent: the awaiting-payment sub plus the bare customer it
 *  hangs off, both carried back to the client so the org can be linked post-payment. */
export interface NewOrgSubscriptionIntent extends SubscriptionIntent {
	customerId: string;
}

/** What `createNewOrgSubscriptionIntent` takes from the browser. */
interface NewOrgSubscriptionOpts {
	orgName: string;
	/** The slug the customer chose, recorded with the subscription so any tab can finish setup. */
	slug?: string;
	priorSubscriptionId?: string;
	customerId?: string;
	currency?: SupportedCurrency;
	/**
	 * The payer facts, PASSED IN rather than read from the database — this is the one conversion
	 * path where no organization exists yet, so there is no organization_billing row to declare
	 * them on. Omitting them refuses the sale exactly as an undeclared org would: the gate's
	 * inputs are optional here, its verdict is not.
	 */
	payer?: { capacity: PayerCapacity | null; billingCountry: string | null };
}

/**
 * What `createNewOrgSubscriptionIntent` hands back: a new intent to pay, with an optional `notice` (ADR
 * 0002 §5.5: an earlier refund, or one on its way back — the clauses that do not block a purchase). The
 * sheet shows `notice` above the payment form.
 * Or — when an earlier attempt turns out to be PAID already — that setup to finish, with nothing new to
 * pay; or a refusal to start anything, with the reason to show.
 */
export type NewOrgSubscriptionStart =
	| ({ kind: "intent"; notice?: string } & NewOrgSubscriptionIntent)
	| { kind: "resume"; setup: NewOrgSetupState }
	| { kind: "refused"; message: string };

/**
 * Creates an incomplete subscription for an org that doesn't exist yet — the deferred
 * create-org flow: take payment first, then create + link the org (linkSubscriptionToNewOrg).
 * The customer/sub carry `created_by` (not `organization_id`) so they can't be claimed by
 * another user, and the webhook ignores them until the link step stamps the org id.
 *
 * Idempotent across retries: pass the prior `customerId` to reuse it and `priorSubscriptionId`
 * to replace the previous attempt (e.g. after "← Back" or a currency switch), so a Stripe
 * customer is never duplicated and incomplete subscriptions don't pile up. When the browser lost the
 * `customerId` (#5463), the customer of the caller's newest unfinished, unlinked setup record is
 * reused instead, and the sweep covers the customers of all of them.
 *
 * ON PAYMENT HOLDS (ADR 0002 S8). It mints only through I1, in this order, under the user's lease:
 *   (a) every open payment hold of the user — found by the session user, never from the browser (C7) —
 *       is advanced once (`advanceHold`), and any that still blocks refuses;
 *   (b) the prior and the sweep: a subscription of the user's own create-a-team flow (§4.2) is closed
 *       ONLY under a hold written first (I4, `closeUnderHold`), and only when `readFirstPayment` proves
 *       it never paid; the machine then voids its invoice and cancels only after a proven void (§3.4).
 *       One not proven unpaid is KEPT, untouched, and refuses. A `canceled` prior is closed under a hold
 *       only while its invoice can still be paid; a paid one is a finished purchase and is left alone
 *       (only a hold may refund, I3);
 *   (c) the live check (`liveCreateATeamSubscription`), read last: a live create-a-team subscription of
 *       the user's on any customer their records or holds name is resumed, never minted beside.
 * Every refusal is one message for everything seen (`composeNewOrgHoldCopy`). A paid prior is resumed
 * first (`kind: "resume"`), or refused when it is linked to a team the user is not an owner of.
 *
 * The whole of it runs under the user's purchase lease (`withUserPurchaseLease`, ADR 0002 §4.4), so a
 * second request from another tab or another instance waits for this one and then sees what it
 * minted. Every Stripe write renews the lease first (§4.4 rule 1), and one that finds it lost stops and
 * refuses — except the writes of the close-out (rule 4), which run after a lost lease by design and
 * touch only the subscription this request minted and never handed out.
 */
export async function createNewOrgSubscriptionIntent(
	plan: PaidPlan,
	opts: NewOrgSubscriptionOpts,
): Promise<NewOrgSubscriptionStart> {
	const actor = await currentActor();
	requireHostedBilling();
	// The org does not exist yet, so the context is assembled from what the caller declared. Note
	// `organizationId: actor.userId` — the personal scope — because there is genuinely no org to
	// name, and inventing an id would put a false one in a record that is meant to be evidence.
	const newOrgContext: PaidConversionContext = {
		userId: actor.userId,
		organizationId: actor.userId,
		capacity: opts.payer?.capacity ?? null,
		billingCountry: opts.payer?.billingCountry ?? null,
	};
	await assertPaidConversionAllowed(newOrgContext);

	// One create-a-team purchase per user at a time (#5489): two tabs that each read "nothing in flight"
	// before either minted would otherwise each mint a payable subscription.
	const leased = await withUserPurchaseLease(actor.userId, (lease) =>
		startNewOrgSubscription(actor, plan, opts, lease),
	);
	if (leased.ran) return leased.value;
	return { kind: "refused", message: leased.lost ? PURCHASE_STOPPED : PURCHASE_IN_PROGRESS };
}

/**
 * Runs `fn` under the user's purchase lease, `user:<userId>` (ADR 0002 §4.4), taken by the
 * create-a-team purchase and its link. `{ ran: false }` when another request holds it past the wait, or
 * `{ ran: false, lost: true }` when `fn` lost it (a fence threw `PurchaseLeaseLostError`: the lease was
 * taken over, or lapsed). Anything else `fn` throws is thrown.
 *
 * The lease is the only exclusion. S2's build also took the older advisory key, `new-org:<userId>`
 * (`withPurchaseLock`), for one release so that its pods and the pods before it excluded each other
 * during a rolling deploy (ADR 0002 §8 step 1). This build takes the lease alone, and so excludes S2's
 * pods (which take the lease too) but NOT the pods before S2 (which take only the advisory key): it
 * must deploy only after S2's rollout has completed.
 */
async function withUserPurchaseLease<T>(
	userId: string,
	fn: (lease: PurchaseLease) => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false; lost?: true }> {
	try {
		const leased = await withPurchaseLease(`user:${userId}`, fn);
		if (!leased.acquired) return { ran: false };
		return { ran: true, value: leased.value };
	} catch (e) {
		if (e instanceof PurchaseLeaseLostError) return { ran: false, lost: true };
		throw e;
	}
}

/** What the renewal before the mint must leave on the lease beyond the mint's worst case (§4.4 rule 2). */
const MINT_DEADLINE_MARGIN_MS = 10_000;

/**
 * What the renewal before the mint must leave on the lease (§4.4 rule 2): one silent window of the
 * purchase client's timeout per attempt (lib/billing/stripe.ts) plus `MINT_DEADLINE_MARGIN_MS`.
 *
 * This is NOT the longest `subscriptions.create` can take. On Node the timeout is socket inactivity that
 * resets at each stage, so a response that trickles in runs past it, and a closed connection is retried
 * beyond the retry count. And a renewal always sets the full lease lifetime (120s), so the check is met
 * by construction; it bites only if the lifetime is ever lowered below this. A slow mint is made safe by
 * the artifact gate (rule 3), not by this number.
 */
function mintDeadlineMs(): number {
	return (1 + STRIPE_MAX_NETWORK_RETRIES) * STRIPE_REQUEST_TIMEOUT_MS + MINT_DEADLINE_MARGIN_MS;
}

/** The `cancellation_details.comment` that marks a close-out's cancel (ADR 0002 §4.4 rule 4, S12). */
const CLOSEOUT_STAMP = "alethia:closeout";

/**
 * The customer a just-minted create-a-team subscription hangs off, and where it came from — which
 * decides whether any later sweep can find that subscription: `reused` — passed by the browser or named
 * by an unfinished setup record, so the user's next purchase sweeps it while a record still names it or
 * the browser passes it again; `created` — minted by this request, and named nowhere else until this
 * request records the setup.
 */
interface MintedCustomer {
	customerId: string;
	origin: "reused" | "created";
}

/**
 * THE CLOSE-OUT (ADR 0002 §4.4 rule 4). The subscription `sub` this request minted must be closed with
 * its client secret never leaving the server: the artifact gate failed after `subscriptions.create`
 * (this request lost its lease, so another may already have minted), or Stripe's answer carried no
 * invoice or no client secret, or the setup record could not be written after a lost lease. Exactly the
 * writes that close `sub` follow, and nothing else — no renewal, no hold row: no payment can land on a
 * subscription whose secret was never handed out.
 *
 * VOID FIRST, AND CANCEL ONLY AFTER A PROVEN VOID. Stripe voids only an unpaid invoice, so a void that
 * succeeded — or a re-read that shows `void` — proves the first invoice was not paid, and only then is
 * the subscription cancelled, stamped `alethia:closeout`. When the void cannot be proven, nothing is
 * cancelled: a subscription whose first invoice may be paid is never cancelled here. A cancel that fails
 * is logged and left the same way.
 *
 * A close-out that did not cancel (`cancelled=false` on the log event) leaves `sub` `incomplete` with no
 * secret anywhere, and raises an operator alert. What finds it afterwards depends on `mintedOn.origin`:
 * on a `reused` customer the user's next purchase sweeps it (after `readFirstPayment` proves it unpaid)
 * while an unfinished record names that customer or the browser passes it again; on a customer this
 * request `created`, NO sweep can find it — nothing names that customer — so the
 * alert is its only trace, and Stripe expires it after about 23h.
 */
async function closeOutMintedSubscription(sub: Stripe.Subscription, mintedOn: MintedCustomer): Promise<void> {
	const stripe = getPurchaseStripe();
	const invoiceId =
		typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
	let voided = false;
	if (invoiceId) {
		try {
			voided = (await stripe.invoices.voidInvoice(invoiceId)).status === "void";
		} catch {
			voided = false;
		}
		if (!voided) {
			try {
				voided = (await stripe.invoices.retrieve(invoiceId)).status === "void";
			} catch {
				voided = false;
			}
		}
	}
	let cancelled = false;
	if (voided) {
		try {
			await stripe.subscriptions.cancel(sub.id, { cancellation_details: { comment: CLOSEOUT_STAMP } });
			cancelled = true;
		} catch (e) {
			console.error(`[billing] close-out could not cancel ${sub.id}; it stays incomplete:`, e);
		}
	}
	logBillingEvent("billing.purchase_lease.closeout", {
		subscription_id: sub.id,
		invoice_id: invoiceId,
		voided: voided ? "true" : "false",
		cancelled: cancelled ? "true" : "false",
	});
	if (cancelled) return;
	const { customerId } = mintedOn;
	await alertOperator({
		title: "A create-a-team close-out could not cancel the subscription it minted",
		subject: { type: "stripe_subscription", id: sub.id },
		summary: `Subscription ${sub.id} (customer ${customerId}) was minted by a create-a-team purchase that then had to close it out without handing out its client secret, but the close-out ${voided ? "could not cancel it after voiding its first invoice" : `could not prove its first invoice ${invoiceId ?? "(none)"} void, so it was not cancelled`}. It stays incomplete. ${mintedOn.origin === "created" ? "Its customer was created by that request and is named nowhere else, so no purchase sweep will find it; Stripe expires it after about 23h unless it is closed by hand." : "Its customer was reused: the user's next purchase sweeps it only while an unfinished setup record names that customer or the browser passes it again; otherwise nothing does, and Stripe expires it after about 23h unless it is closed by hand."}`,
	});
}

/**
 * What the create-a-team purchase has seen of its user's earlier checkouts in this request (ADR 0002
 * §5.5): every hold it read or opened, as its last write left it, by id; and what the payment showed on
 * every subscription its sweep KEPT. The composer turns the whole set into one message.
 */
interface CheckoutsSeen {
	holds: Map<string, PaymentHoldRow>;
	kept: KeptPayment[];
}

/** The subscriptions an OPEN hold in `seen` names: the purchase never opens a second hold on one (T0h). */
function heldSubscriptions(seen: CheckoutsSeen): Set<string> {
	const open = [...seen.holds.values()].filter((h) => h.state !== "released");
	return new Set(open.map((h) => h.subscription_id));
}

/** One message for everything `seen` (§5.5): the refusal when anything blocks, else the mint's notice. */
function copyOf(seen: CheckoutsSeen): { refusal: string | null; notice: string | null } {
	return composeNewOrgHoldCopy({ holds: [...seen.holds.values()], kept: seen.kept, now: new Date() });
}

/** The id of a subscription's latest invoice, expanded or not; null when it has none. */
function latestInvoiceId(sub: Pick<Stripe.Subscription, "latest_invoice">): string | null {
	return typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
}

/**
 * E1 for one hold under this request's lease (§3.2 E1 (a)): `advanceHold`, the only code that moves a
 * hold, with the sweeper's own dependencies. Returns the hold as its last write left it. A lost lease, or
 * a state write that matched no row, stops the purchase (§4.4 rule 1). Under this lease nothing else
 * writes this payer's holds, so a write matches no row only when the store's lease fence failed: the
 * lease was taken over, or it LAPSED (`expires_at` passed) while this request was reading Stripe.
 */
async function advanceUnderLease(hold: PaymentHoldRow, lease: PurchaseLease): Promise<PaymentHoldRow> {
	return (await advanceResultUnderLease(hold, lease)).hold;
}

/** `advanceUnderLease`, returning the whole `AdvanceResult` (the rows it matched, its observation). */
async function advanceResultUnderLease(hold: PaymentHoldRow, lease: PurchaseLease): Promise<AdvanceResult> {
	const result = await advanceHold(hold, machineDepsFor(lease, liveSweepDeps()));
	if (result.outcome === "lease_lost" || result.outcome === "stale") {
		throw new PurchaseLeaseLostError(lease.key);
	}
	return result;
}

/**
 * §5.6 "When a hold ends", in the create-a-team purchase: when `before` was open and this request's
 * advance left it released `adopted` (`after`), the setup that names it is re-linked under this lease
 * (`relinkAdoptedSetup`) when it has an org. Returns the `needs_operator` hold a refused re-link opened,
 * which the caller adds to what it has seen, so it blocks this purchase as it blocks the next one (I1
 * (a)); else null. A lost lease is thrown. Any other failure is logged and the purchase goes on: the
 * setup stays open, and the live check after this still sees X while X is unlinked.
 */
async function relinkIfAdopted(
	before: PaymentHoldRow,
	after: PaymentHoldRow,
	lease: PurchaseLease,
): Promise<PaymentHoldRow | null> {
	if (before.state === "released" || after.state !== "released" || after.release_reason !== "adopted") return null;
	try {
		const relinked = await relinkAdoptedSetup(lease, after, liveSweepDeps().alert);
		return relinked.kind === "refused" ? relinked.hold : null;
	} catch (e) {
		if (e instanceof PurchaseLeaseLostError) throw e;
		console.error(`[billing] could not re-link the setup of adopted hold ${after.id}:`, e);
		return null;
	}
}

/**
 * I4, THE WRITE-AHEAD: closes `sub` (whose held invoice is `invoiceId`) only under a hold. E0 opens the
 * hold in `closing` under the lease BEFORE anything is voided or cancelled; then the machine advances
 * it — voiding first, cancelling only after a proven void (§3.4). Returns the hold as E0 opened it
 * (`opened`) and as the machine left it (`hold`), or a refusal that ends the purchase with nothing touched: T0f, the hold could not be written (no
 * block is promised); T0h, an open hold already names `sub` (its clause, when it is this payer's).
 */
async function closeUnderHold(
	sub: Stripe.Subscription,
	invoiceId: string,
	userId: string,
	lease: PurchaseLease,
): Promise<{ kind: "held"; opened: PaymentHoldRow; hold: PaymentHoldRow } | { kind: "refused"; message: string }> {
	let opened: OpenHoldResult;
	try {
		opened = await openHold(lease, {
			subscriptionId: sub.id,
			customerId: subscriptionCustomerId(sub),
			payerKey: userId,
			invoiceId,
			state: "closing",
			nextCheckAt: new Date(Date.now() + 5 * 60_000),
			openedBy: "purchase",
			openedByUserId: userId,
		});
	} catch (e) {
		console.error(`[billing] could not open a payment hold on ${sub.id}; nothing was closed:`, e);
		return { kind: "refused", message: HOLD_NOT_RECORDED };
	}
	if (opened.kind === "lease_lost") throw new PurchaseLeaseLostError(lease.key);
	const decision = decideOpen(opened, userId);
	if (decision.kind === "proceed") {
		return { kind: "held", opened: decision.hold, hold: await advanceUnderLease(decision.hold, lease) };
	}
	const own = decision.kind === "refuse_held" ? decision.hold : null;
	return { kind: "refused", message: (own ? holdClause(own) : null) ?? NOT_CONFIRMED_CLOSED };
}

/**
 * What a KEPT subscription's payment shows, for the copy (§5.5): its latest invoice's payments, read
 * the way a hold reads them (`observeHold`, with the subscription answered from the one in hand) — but
 * no hold is opened and nothing is written, because nothing is being closed. A read that fails is
 * `unproven`.
 */
async function keptPaymentOf(sub: Stripe.Subscription): Promise<KeptPayment> {
	const invoiceId = latestInvoiceId(sub);
	if (!invoiceId) return "unproven";
	const stripe = getPurchaseStripe();
	const reader: HoldStripeReader = {
		subscriptions: { retrieve: async () => ({ status: sub.status }) },
		invoices: stripe.invoices,
		invoicePayments: stripe.invoicePayments,
		paymentIntents: stripe.paymentIntents,
		refunds: stripe.refunds,
	};
	try {
		const { pay } = await observeHold({ id: "", subscription_id: sub.id, invoice_id: invoiceId }, reader);
		const shown = pay.kind;
		return shown === "in_flight" || shown === "capturable" || shown === "succeeded" ? shown : "unproven";
	} catch {
		return "unproven";
	}
}

/**
 * The create-a-team close of one of the user's own `incomplete` / `incomplete_expired` subscriptions
 * (the prior, or one the sweep found). Closed — under a hold (`closeUnderHold`) — only when
 * `readFirstPayment` proves its first payment never happened; its record is dropped only once the hold
 * is released as never payable (§8), never after a bare cancel. Any other is KEPT, untouched, and what
 * its payment shows goes to `seen`. Returns a refusal that ends the purchase now (T0f, T0h), or null.
 */
async function closeOrKeep(
	sub: Stripe.Subscription,
	userId: string,
	lease: PurchaseLease,
	seen: CheckoutsSeen,
): Promise<string | null> {
	let firstPayment: FirstPayment;
	try {
		firstPayment = await readTwice(() => readFirstPayment(sub));
	} catch {
		firstPayment = "not_proven_unpaid";
	}
	if (firstPayment !== "never_paid") {
		seen.kept.push(await keptPaymentOf(sub));
		return null;
	}
	const invoiceId = latestInvoiceId(sub);
	// An expired subscription with no invoice: nothing can be paid, voided or cancelled.
	if (!invoiceId) {
		await forgetPendingOrgSetup(userId, sub, firstPayment);
		return null;
	}
	const closed = await closeUnderHold(sub, invoiceId, userId, lease);
	if (closed.kind === "refused") return closed.message;
	seen.holds.set(closed.hold.id, closed.hold);
	const opened = await relinkIfAdopted(closed.opened, closed.hold, lease);
	if (opened) seen.holds.set(opened.id, opened);
	const reason = closed.hold.release_reason;
	if (closed.hold.state === "released" && reason && FORGETTABLE_RELEASES.has(reason)) {
		await forgetPendingOrgSetup(userId, sub, firstPayment);
	}
	return null;
}

/** Statuses under which a subscription still exists and may bill (ADR 0002 §2, "Live subscription"). */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
	"active",
	"trialing",
	"past_due",
	"unpaid",
	"paused",
]);

/**
 * I1 (c), THE LIVE CHECK (ADR 0002 §4.3, C24, C94): every subscription, of every status, on each of
 * `customers` — the customers of the user's unlinked records (`liveCheckSetupCustomers`, whether or not
 * the team exists or the record is closed), of the holds this request saw, and the one it would reuse —
 * fully paged. A customer the purchase has yet to mint is not among them: it is minted after this check
 * (#5989), with nothing on it to read. ORDER: it runs AFTER the hold pass and the sweep, so a subscription either one adopted is
 * still seen, and it reads the record set AGAIN here (`liveCheckCustomers`) rather than reuse the copy
 * the sweep read: a resume lookup can add a record outside this user's lease (`setupRecordFor`'s
 * backfill), so only a fresh read makes this the last read. A LIVE create-a-team subscription of the user's — one whose webhook has not been seen yet,
 * or one that went straight to `active` — is returned. A list that fails, or one over its cap, refuses
 * (§5.1): the purchase never mints on a read it did not make.
 */
async function liveCreateATeamSubscription(
	userId: string,
	alsoOn: Iterable<string>,
): Promise<{ kind: "none" } | { kind: "live"; sub: Stripe.Subscription } | { kind: "refused"; message: string }> {
	const recorded = await liveCheckCustomers(userId);
	if (recorded.kind === "refused") return recorded;
	for (const customer of new Set([...recorded.customers, ...alsoOn])) {
		let listed: Awaited<ReturnType<typeof listCustomerSubscriptions>>;
		try {
			listed = await listCustomerSubscriptions(getPurchaseStripe(), customer, "all");
		} catch (e) {
			console.error(`[billing] the create-a-team live check could not list ${customer}:`, e);
			return { kind: "refused", message: LIVE_CHECK_FAILED };
		}
		if (listed.kind === "over_cap") return { kind: "refused", message: TOO_MANY_EARLIER_CHECKOUTS };
		const live = listed.subs.find(
			(s) => isCreateATeamSubscriptionOf(s, userId) && LIVE_SUBSCRIPTION_STATUSES.has(s.status),
		);
		if (live) return { kind: "live", sub: live };
	}
	return { kind: "none" };
}

/**
 * The customers of the live check's record set (`liveCheckSetupCustomers`), or the refusal over its cap.
 * Closed records are never deleted, so over the cap is lasting: the refusal also alerts the operator,
 * once per cap state (`alertSetupCapOnce`), with what clears it.
 */
async function liveCheckCustomers(
	userId: string,
): Promise<{ kind: "all"; customers: string[] } | { kind: "refused"; message: string }> {
	const recorded = await liveCheckSetupCustomers(userId);
	if (recorded.kind === "all") return recorded;
	await alertSetupCapOnce(userId, {
		title: "A create-a-team purchase refused: too many setup records to check",
		summary: `User ${userId} has unlinked create-a-team setup records (closed ones included) on more than ${UNLINKED_SETUP_CUSTOMER_CAP} Stripe customers, so the purchase could not check them all for a live or settling subscription and refused.`,
	});
	return { kind: "refused", message: TOO_MANY_EARLIER_CHECKOUTS };
}

/**
 * What clears either over-cap refusal of the create-a-team purchase, appended to its alert. It names the
 * live check's record set (`liveCheckSetupCustomers`), because the reuse set the other refusal reads is a
 * subset of it: bringing the larger one under the cap clears both. It also says what else the sweep and
 * the live check read, so an operator does not take a record's customer for unread once no record names it.
 */
const SETUP_CAP_FIX = `To fix it: the user's pending_org_setups rows with linked_at IS NULL (closed ones included — closing a record does not take it out of the count) must name at most ${UNLINKED_SETUP_CUSTOMER_CAP} distinct Stripe customers. No operator command removes a record from that set, so this is a change by hand. Before taking a record's customer out of the set, check that the customer has no live or incomplete create-a-team subscription of this user's: once no record names it, the sweep and the live check read that customer only when the browser passes it as the purchase's customer, and the live check also when an open payment hold of the user's names it.`;

/**
 * Raises an over-cap alert of the create-a-team purchase (ADR 0002 §4.3, §4.5) — the subject is the user,
 * and `SETUP_CAP_FIX` is appended to `summary` — once per user per CAP STATE (#5989). The state is marked
 * by the user's newest unlinked record (`newestUnlinkedSetupAt`): the alert is skipped while an operator
 * alert about this user has reached a channel at or after that record (`alertedAboutSince`), and a newer
 * record starts a new state, which alerts again.
 *
 * The purchase itself writes no record while the user is over the cap (it refuses before the mint). One
 * writer does: `setupRecordFor`'s BACKFILL, reached through `newOrgSetupStateFor` — the paid-prior resume
 * (which runs before the live check's cap is read) and the resume and link lookups outside the purchase —
 * records a subscription that has no record yet. Each such record starts a new state, so the next
 * over-cap refusal alerts again. That is bounded: the backfill writes through `recordPendingOrgSetup`,
 * which inserts with `onConflictDoNothing` on `subscription_id`, so it adds at most one record, and so at
 * most one more alert, per subscription.
 *
 * An alert that reached no channel writes no delivery row, so it silences nothing. The refusal is the
 * caller's either way; a skipped alert is still logged.
 */
async function alertSetupCapOnce(userId: string, alert: { title: string; summary: string }): Promise<void> {
	const since = await newestUnlinkedSetupAt(userId);
	if (await alertedAboutSince(userId, since)) {
		console.error(`[billing] ${alert.summary} (already alerted for this cap state; not raised again)`);
		return;
	}
	await alertOperator({
		title: alert.title,
		subject: { type: "user", id: userId },
		summary: `${alert.summary} ${SETUP_CAP_FIX}`,
	});
}

/** The setup of a paid create-a-team subscription to resume, or the refusal when the user cannot finish it here. */
async function resumeOrRefuse(sub: Stripe.Subscription, userId: string): Promise<NewOrgSubscriptionStart> {
	const setup = await newOrgSetupStateFor(sub, userId);
	return setup ? { kind: "resume", setup } : { kind: "refused", message: PAID_SETUP_ELSEWHERE };
}

/**
 * The body of `createNewOrgSubscriptionIntent`, run under the user's purchase lease: resumes a paid
 * prior, advances the user's holds (I1 (a)), closes the prior and sweeps under holds (I1 (b)), runs the
 * live check (I1 (c)), then mints and records the setup. Every Stripe write renews `lease` first
 * (`fence`, §4.4 rule 1) and a lost lease is thrown as `PurchaseLeaseLostError`; the mint and its
 * artifact gate follow rules 2–4. The one exception is the close-out (rule 4): its writes run after the
 * lease is lost, and close only the subscription this request minted.
 */
async function startNewOrgSubscription(
	actor: { userId: string },
	plan: PaidPlan,
	opts: NewOrgSubscriptionOpts,
	lease: PurchaseLease,
): Promise<NewOrgSubscriptionStart> {
	const fence = fenceFor(lease);
	// The Stripe customers of the caller's own unfinished setup records (server-written, keyed on the
	// session user): reused when the browser lost its `customerId`, and swept below (#5463).
	// Every one of them, or a refusal: a partial list would sweep fewer customers than exist (ADR 0002 §4.5).
	const recorded = await unlinkedPendingOrgSetupCustomers(actor.userId);
	if (recorded.kind === "over_cap") {
		await alertSetupCapOnce(actor.userId, {
			title: "A create-a-team purchase refused: too many unfinished setups",
			summary: `User ${actor.userId} has unfinished create-a-team setups (no team, not linked, not declared) on more than ${UNLINKED_SETUP_CUSTOMER_CAP} Stripe customers, so the purchase could not sweep them all and refused.`,
		});
		return { kind: "refused", message: TOO_MANY_EARLIER_CHECKOUTS };
	}
	const recordedCustomers = recorded.customers;

	// The prior is READ from Stripe (#5445): the browser's id is a hint. A paid one is resumed; one this
	// user did not mint, or one a link already gave an `organization_id` (§4.2), is left alone.
	const prior = opts.priorSubscriptionId
		? await ownNewOrgSubscription(opts.priorSubscriptionId, actor.userId)
		: null;
	if (prior && PAID_SUBSCRIPTION_STATUSES.has(prior.status)) return resumeOrRefuse(prior, actor.userId);

	// I1 (a): every open hold of the user, advanced once. Released ones are kept for their notice.
	const seen: CheckoutsSeen = { holds: new Map(), kept: [] };
	for (const hold of await paymentHoldsOfPayer(actor.userId)) {
		const advanced = hold.state === "released" ? hold : await advanceUnderLease(hold, lease);
		seen.holds.set(advanced.id, advanced);
		const opened = await relinkIfAdopted(hold, advanced, lease);
		if (opened) seen.holds.set(opened.id, opened);
	}
	const held = copyOf(seen).refusal;
	if (held) return { kind: "refused", message: held };

	// I1 (b), the prior: closed under a hold, or kept. A `canceled` one is closed under a hold only while
	// its invoice can still be paid (the machine voids it, T8, or deletes a draft, T8d); a paid one is a
	// finished purchase cancelled later, and is left alone (C6, C34).
	if (prior && isCreateATeamSubscriptionOf(prior, actor.userId) && !heldSubscriptions(seen).has(prior.id)) {
		if (REPLACEABLE_SUBSCRIPTION_STATUSES.has(prior.status)) {
			const refusal = await closeOrKeep(prior, actor.userId, lease, seen);
			if (refusal) return { kind: "refused", message: refusal };
		} else if (prior.status === "canceled") {
			const invoiceId = latestInvoiceId(prior);
			let status: string | null = null;
			if (invoiceId) {
				try {
					status = (await readTwice(() => getPurchaseStripe().invoices.retrieve(invoiceId))).status;
				} catch (e) {
					// A deleted draft was never payable; any other failure proves nothing, and refuses.
					if (!isStripeResourceMissing(e)) return { kind: "refused", message: NOT_CONFIRMED_CLOSED };
				}
			}
			if (invoiceId && (status === "open" || status === "uncollectible" || status === "draft")) {
				const closed = await closeUnderHold(prior, invoiceId, actor.userId, lease);
				if (closed.kind === "refused") return { kind: "refused", message: closed.message };
				seen.holds.set(closed.hold.id, closed.hold);
			}
		}
	}

	// The live check's own record set (§4.3, C94): every unlinked record, INCLUDING closed ones and ones
	// whose team exists, which the reuse set above leaves out. Read only now — after the paid-prior resume
	// and the hold pass, so a user over its cap can still resume a paid setup — and before a customer is
	// minted. Closed records are never deleted, so over the cap is lasting: it refuses AND alerts. The
	// sweep reads this set too, so an `incomplete` subscription still settling on such a customer is KEPT
	// and refuses, where the live check alone would read it "not live" and mint beside it.
	const liveRecorded = await liveCheckCustomers(actor.userId);
	if (liveRecorded.kind === "refused") return liveRecorded;

	// Reuse the customer from a prior attempt only if this user owns it and no org does (ADR 0002 §4.2
	// (2), `isReusableCreateATeamCustomer`): the one the browser passed, else the one on the caller's
	// newest unfinished setup record (the browser can lose its copy, #5463). With none, a fresh bare
	// customer is minted — but only after the sweep and the live check below (#5989): every refusal
	// comes before it, so a refused purchase, and each refused retry, leaves no customer behind. A
	// customer minted by this request has no subscription yet, so neither check has anything to read on it.
	let reusedCustomer: string | null = null;
	if (opts.customerId) {
		const existing = await getPurchaseStripe().customers.retrieve(opts.customerId);
		if (isReusableCreateATeamCustomer(existing, actor.userId)) reusedCustomer = existing.id;
	}
	if (!reusedCustomer && recordedCustomers[0]) {
		reusedCustomer = await ownedCustomer(recordedCustomers[0], actor.userId);
	}
	const reused = reusedCustomer ? [reusedCustomer] : [];

	// I1 (b), the sweep: every `incomplete` subscription on the customer this purchase reuses and on every
	// customer the caller's unlinked records name — closed records and records whose team exists
	// included — so a purchase still settling on any of them blocks a second one. Only this user's
	// create-a-team subscriptions are touched (ADR 0002 §4.2): one of theirs that never paid is closed
	// under a hold even when its team exists (a failed bank debit, say), and anything else on these
	// customers — a team's own plan or AI checkout included — is left alone, alerted on, and does not refuse. Each of the user's own is closed
	// under a hold or kept (`closeOrKeep`). A customer with more than the sweep reads refuses, and so does
	// a list that fails (§5.1).
	for (const sweepCustomer of new Set([...reused, ...recordedCustomers, ...liveRecorded.customers])) {
		let listed: Awaited<ReturnType<typeof listCustomerSubscriptions>>;
		try {
			listed = await listCustomerSubscriptions(getStripe(), sweepCustomer, "incomplete");
		} catch (e) {
			console.error(`[billing] the create-a-team sweep could not list ${sweepCustomer}:`, e);
			return { kind: "refused", message: LIVE_CHECK_FAILED };
		}
		if (listed.kind === "over_cap") {
			await alertSweepOverCap(sweepCustomer);
			return { kind: "refused", message: TOO_MANY_EARLIER_CHECKOUTS };
		}
		for (const s of listed.subs) {
			if (!isCreateATeamSubscriptionOf(s, actor.userId)) {
				await alertForeignSubscription(s, sweepCustomer, actor.userId);
				continue;
			}
			if (heldSubscriptions(seen).has(s.id)) continue;
			const refusal = await closeOrKeep(s, actor.userId, lease, seen);
			if (refusal) return { kind: "refused", message: refusal };
		}
	}
	const copy = copyOf(seen);
	if (copy.refusal) return { kind: "refused", message: copy.refusal };

	// I1 (c), read last.
	const holdCustomers = [...seen.holds.values()].map((h) => h.customer_id);
	const live = await liveCreateATeamSubscription(actor.userId, [...holdCustomers, ...reused]);
	if (live.kind === "refused") return { kind: "refused", message: live.message };
	if (live.kind === "live") return resumeOrRefuse(live.sub, actor.userId);

	// Every check has passed: only now is a customer minted, when none could be reused (no organization_id
	// until the org exists and is linked). The renewal before it is §4.4 rule 1's; the mint deadline's own
	// renewal below still comes after it, right before `subscriptions.create` (rule 2).
	let customerId = reusedCustomer;
	if (!customerId) {
		const [u] = await getServiceDb()
			.select({ email: user.email, name: user.name })
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		await fence();
		const customer = await getPurchaseStripe().customers.create({
			email: u?.email,
			name: opts.orgName,
			metadata: { created_by: actor.userId },
		});
		customerId = customer.id;
	}
	const mintedOn: MintedCustomer = { customerId, origin: reusedCustomer ? "reused" : "created" };

	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Resolve the billing currency before creating the sub (Stripe locks it): explicit
	// selection wins, else the request geo.
	const currency = opts.currency ?? (await currencyFromRequest());
	// THE MINT DEADLINE (§4.4 rule 2): the renewal right before the mint must leave the lease more than
	// `mintDeadlineMs()`. It does not stop the lease lapsing while Stripe is still answering — the timeout
	// is per-stage inactivity, not a total cap — so a mint that outlives the lease is caught by the
	// artifact gate below (rule 3), which is what keeps a second secret from leaving.
	await fenceFor(lease, mintDeadlineMs())();
	// The org doesn't exist yet (owner only) — start at 1 seat; per-seat sync grows the
	// quantity as invited members accept (lib/billing/seats syncOrgSeats via org hooks).
	// The idempotency key names this HOLDER, on purpose: a key shared between holders would replay A's
	// subscription to B after B's sweep had cancelled it.
	const sub = await getPurchaseStripe().subscriptions.create(
		{
			customer: customerId,
			items: planCreateItems(plan, 1),
			currency,
			payment_behavior: "default_incomplete",
			payment_settings: { save_default_payment_method: "on_subscription" },
			expand: ["latest_invoice.confirmation_secret"],
			metadata: { created_by: actor.userId },
			...taxParam,
		},
		{ idempotencyKey: `mint-${lease.key}-${lease.holder}` },
	);

	// THE ARTIFACT GATE (§4.4 rule 3, I9). The secret leaves the server only after a renewal made AFTER
	// the create returned still finds this holder. A request that stalled past its lease may have been
	// taken over, and the new holder may have minted already: then this subscription is closed out
	// (rule 4) and nothing is handed out. A renewal that throws proves nothing, and is treated the same.
	let gateHeld = false;
	try {
		gateHeld = await renewPurchaseLease(lease);
	} catch (e) {
		console.error(`[billing] the artifact gate could not renew ${lease.key}:`, e);
	}
	if (!gateHeld) {
		await closeOutMintedSubscription(sub, mintedOn);
		return { kind: "refused", message: PURCHASE_IN_PROGRESS };
	}

	// No invoice, or no client secret: nothing can be handed out to pay `sub`, so it is closed out before
	// the error is thrown (§4.4 rule 4) — it used to be left minted, `incomplete` and uncancelled.
	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		await closeOutMintedSubscription(sub, mintedOn);
		throw new Error("Stripe did not return an invoice for the subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		await closeOutMintedSubscription(sub, mintedOn);
		throw new Error("Stripe did not return a payment client secret.");
	}
	// The server-side record of this setup (#5445), written BEFORE the client holds anything it could
	// pay. From here on a charge is findable by the payer's own id with no browser record and no search
	// index. If it cannot be written, the subscription is cancelled and nothing is offered for payment:
	// a charge the server cannot find again is the one outcome this record exists to prevent.
	const parsedSlug = pendingOrgSetupSlugSchema.safeParse(opts.slug ?? "");
	try {
		await recordPendingOrgSetup({
			userId: actor.userId,
			subscriptionId: sub.id,
			customerId,
			name: opts.orgName,
			slug: (parsedSlug.success && parsedSlug.data) || slugifyOrEmpty(opts.orgName),
		});
	} catch (e) {
		// §5.2: closed out, as after a failed gate — void, then cancel stamped `alethia:closeout`, no hold
		// row (its secret never left the server, so no payment can land on it).
		await closeOutMintedSubscription(sub, mintedOn);
		throw new Error("Couldn't start the purchase — try again.", { cause: e });
	}
	return {
		kind: "intent",
		clientSecret,
		subscriptionId: sub.id,
		customerId,
		currency,
		...(copy.notice ? { notice: copy.notice } : {}),
	};
}

/**
 * NO NEW SHARING (ADR 0002 §4.2 (2), C55): a customer the create-a-team purchase may reuse — not deleted,
 * minted by `userId`, and naming NO organization. An org's customer (`ensureCustomer` stamps both
 * `organization_id` and `created_by`), including one a previous link rewrote, is never reused: its own
 * org-plan or AI checkout would then sit on the customer this purchase sweeps.
 */
function isReusableCreateATeamCustomer(
	customer: Stripe.Customer | Stripe.DeletedCustomer,
	userId: string,
): customer is Stripe.Customer {
	return !customer.deleted && customer.metadata?.created_by === userId && !customer.metadata?.organization_id;
}

/**
 * `customerId` when Stripe has it and the create-a-team purchase of `userId` may reuse it
 * (`isReusableCreateATeamCustomer`); else null. A missing customer is null; any other failure is thrown.
 */
async function ownedCustomer(customerId: string, userId: string): Promise<string | null> {
	let existing: Stripe.Customer | Stripe.DeletedCustomer;
	try {
		existing = await getPurchaseStripe().customers.retrieve(customerId);
	} catch (e) {
		if (isStripeResourceMissing(e)) return null;
		throw e;
	}
	return isReusableCreateATeamCustomer(existing, userId) ? existing.id : null;
}

/**
 * A new-org subscription read from Stripe by id, with its customer expanded — or null when it does
 * not exist or this user did not mint it. Any other failure is thrown: an outage must not read as "no
 * prior subscription", or a paid one would be replaced by a second purchase.
 */
async function ownNewOrgSubscription(
	subscriptionId: string,
	userId: string,
): Promise<Stripe.Subscription | null> {
	let sub: Stripe.Subscription;
	try {
		sub = await getPurchaseStripe().subscriptions.retrieve(subscriptionId, { expand: ["customer"] });
	} catch (e) {
		if (isStripeResourceMissing(e)) return null;
		throw e;
	}
	return sub.metadata?.created_by === userId ? sub : null;
}

/** One field `saveNewOrgSetupDetails` did not keep, and why — the form shows it under that field. */
export interface RefusedSetupField {
	/** `slug`, or a billing field name (`line1`, `taxValue`, …). */
	field: string;
	message: string;
}

/**
 * Saves the slug and the checkout billing details on the caller's record of an unfinished paid setup
 * (#5445), so a setup finished from another tab — or after this one is gone — still creates the team at
 * the chosen URL, still sends the tax id, and still honours "use as the team's address". The sheet calls
 * it BEFORE it confirms the card, so a crash after the charge cannot lose them. Validated here: the
 * browser's copy is input. A record that is not the caller's is not touched.
 *
 * The slug and the billing details are validated SEPARATELY: one that fails never stops the other from
 * being kept. What was not kept is RETURNED, field by field, never thrown away in silence — the forms
 * apply the same caps (lib/billing/billing-field-caps.ts), so a refusal here is a form that let through
 * what it should not have, and the caller shows it.
 */
export async function saveNewOrgSetupDetails(input: {
	subscriptionId: string;
	slug: string;
	billing: unknown;
}): Promise<{ ok: true } | { ok: false; refused: RefusedSetupField[] }> {
	const actor = await currentActor();
	requireHostedBilling();
	const refused: RefusedSetupField[] = [];
	const slug = pendingOrgSetupSlugSchema.safeParse(input.slug);
	if (!slug.success) {
		refused.push({ field: "slug", message: slug.error.issues[0]?.message ?? "Invalid URL." });
	}
	let billing: PendingOrgSetupBilling | null = null;
	if (input.billing !== null) {
		const parsed = pendingOrgSetupBillingSchema.safeParse(input.billing);
		if (parsed.success) {
			billing = parsed.data;
		} else {
			for (const issue of parsed.error.issues) {
				refused.push({ field: String(issue.path[0] ?? "billing"), message: issue.message });
			}
		}
	}
	if (slug.success || billing) {
		await savePendingOrgSetupDetails(actor.userId, input.subscriptionId, {
			slug: slug.success ? slug.data : null,
			billing,
		});
	}
	return refused.length > 0 ? { ok: false, refused } : { ok: true };
}

/**
 * Links a just-paid subscription (from createNewOrgSubscriptionIntent) to the org the
 * client created after payment, then writes the billing record synchronously so the
 * org's entitlements are live immediately (no webhook race). Owner-gated on the new org;
 * verifies the sub/customer were minted by this actor and aren't linked to a DIFFERENT org — a
 * second call for the org already linked completes the sync and payer steps (see below).
 */
export async function linkSubscriptionToNewOrg(input: {
	orgId: string;
	subscriptionId: string;
	customerId: string;
	/**
	 * The payer facts declared at the intent step, PERSISTED here.
	 *
	 * This is the moment the organization first exists, and therefore the first moment there is a
	 * row to record them on. Without it a brand-new org would carry a live subscription and NO
	 * declared payer — so the next conversion it attempted (a plan change, an AI subscription) would
	 * be refused by a gate that has no way to know the facts were already given. The eligibility
	 * coverage test found exactly that gap.
	 */
	payer?: { capacity: PayerCapacity | null; billingCountry: string | null };
}): Promise<NewOrgLinkResult> {
	// NAMED, not ambient (#4133). This runs from a sheet on the CURRENT org's page, against the org
	// just created — so the address and the target genuinely differ, and always did. It used to work
	// by asking for the verb in the ambient scope and then asserting that scope WAS the new org,
	// which held only because `setActiveOrganization` had already landed. Asking in the named org
	// says the same thing without depending on that write, or on the order it happened in.
	const actor = await authorizeInOrg("manage_billing", { type: "billing" }, input.orgId);
	requireHostedBilling();

	// Under the user's purchase lease (ADR 0002 §4.4), like the purchase it finishes: a busy or lost
	// lease is THROWN, not refused — a refusal is final for the setup, and this is only "not now", so
	// the sheet's retry is the right answer.
	const leased = await withUserPurchaseLease(actor.userId, (lease) =>
		linkSubscriptionToNewOrgUnderLease(actor, input, lease),
	);
	if (!leased.ran) throw new Error(leased.lost ? PURCHASE_STOPPED : PURCHASE_IN_PROGRESS);
	return leased.value;
}

/**
 * The body of `linkSubscriptionToNewOrg`, under the user's purchase lease (ADR 0002 §5.6). After the
 * retrieve and the ownership checks, and BEFORE any Stripe write, it consults the payment hold that
 * names X:
 *   - `closing` / `cancel_unproven`, this user's: advanced once (`advanceHold`, under this lease).
 *     Released: X is read again, and is linked when the release adopted it, refused as ended when it
 *     closed it. Still open with T4 as its last row (a payment in flight on an `incomplete` X): link and
 *     defer. Still open otherwise: refused, as below.
 *   - any other open state: refused (`refuseHeldLink`) with the hold's clause; the setup stays open
 *     (I16), and the hold decides it when it ends.
 * With no open hold, an ENDED X is refused (`refuseEndedLink`). Otherwise the setup closer runs, and
 * then the link's core (`linkSetupToOrg`), which refuses beside the org's other live plan under a
 * `needs_operator` hold. While an open hold names X the report carries no payment link (C84).
 */
async function linkSubscriptionToNewOrgUnderLease(
	actor: { userId: string },
	input: Parameters<typeof linkSubscriptionToNewOrg>[0],
	lease: PurchaseLease,
): Promise<NewOrgLinkResult> {
	let sub = await getPurchaseStripe().subscriptions.retrieve(input.subscriptionId);
	const subCustomerId =
		typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	if (subCustomerId !== input.customerId) {
		throw new Error("Subscription does not match the expected customer.");
	}
	const customer = await getPurchaseStripe().customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to link this subscription.");
	}
	// IDEMPOTENT FOR THE SAME ORG (#5445). The Stripe writes land before the billing sync and the payer
	// write, so a failure in either — or a response the browser never received — leaves a subscription
	// that already names this org. Such a one, stamped by THIS user, is linked again: the core skips the
	// Stripe writes and re-runs the rest. A subscription naming a DIFFERENT org is refused.
	const linkedTo = sub.metadata?.organization_id;
	if (linkedTo && (linkedTo !== input.orgId || sub.metadata?.created_by !== actor.userId)) {
		throw new Error("Subscription is already linked to an organization.");
	}

	// THE HOLDS (§5.6), read only once X is known to be this user's. A hold is opened only for its payer
	// (I12), so one naming another payer is not this user's to read: it refuses with no clause of its own.
	let hold = await openPaymentHoldOn(sub.id);
	if (hold && hold.payer_key === actor.userId && (hold.state === "closing" || hold.state === "cancel_unproven")) {
		const advanced = await advanceResultUnderLease(hold, lease);
		hold = advanced.hold;
		const lastRow = advanced.rows[advanced.rows.length - 1];
		if (hold.state === "released") {
			// Read again: the advance just adopted X (linked below) or closed it (refused below as ended).
			sub = await getPurchaseStripe().subscriptions.retrieve(sub.id);
			hold = null;
		} else if (lastRow !== "T4") {
			return refuseHeldLink(actor.userId, sub.id, hold);
		}
	} else if (hold) {
		return refuseHeldLink(actor.userId, sub.id, hold);
	}

	if (!hold && ENDED_SUBSCRIPTION_STATUSES.has(sub.status)) {
		return refuseEndedLink(actor.userId, sub, input.orgId);
	}

	// The setup closer runs before the link answers (ADR 0002 §5.7): one a lost response left linked in
	// Stripe is adopted. Beside the org's other live plan it writes nothing (`linkRefuses`): the core
	// below refuses that X under a hold, and an X refused there must not be closed (I16).
	const setup = await pendingOrgSetupFor(actor.userId, sub.id);
	if (setup) await settleOpenSetup(setup, { sub, orgId: input.orgId, linkRefuses: true });

	const linked = await linkSetupToOrg({
		userId: actor.userId,
		orgId: input.orgId,
		sub,
		customerId: input.customerId,
		lease,
		payer: input.payer,
	});
	if (linked.kind === "refused") return { kind: "refused", clause: linked.clause };

	// What the sheet may say about the plan (#5522): read from the subscription just linked, never
	// assumed. Stripe keeps it `incomplete` while the first invoice settles, so "active" here would often
	// be false. Linked and deferred under an open hold: no payment link (C84).
	const report = await readNewOrgPlanState(linked.sub);
	return { kind: "linked", ...report, ...(hold ? { paymentUrl: null } : {}) };
}

/**
 * The link's refusal while an open payment hold names X (§5.6): the hold's clause (§5.5) when it is this
 * user's, else the generic one. A hold an earlier refusal of this link opened beside the team's other
 * live plan (`open_note = link_refused`) keeps that refusal's clause and reason: the live plan, not the
 * payment, is what holds X. Otherwise `refused_reason = 'held'`. The setup stays open either way (I16):
 * the hold's release closes it, or its adoption re-links it.
 */
async function refuseHeldLink(userId: string, subscriptionId: string, hold: PaymentHoldRow): Promise<NewOrgLinkResult> {
	if (hold.payer_key === userId && hold.open_note === LINK_REFUSED_NOTE) {
		await recordSetupRefusal({ userId, subscriptionId, refused: "org_has_plan", close: false });
		const alerted = hold.alerted_at !== null && hold.alerted_at >= hold.state_since;
		return { kind: "refused", clause: `${LINK_REFUSED_ORG_HAS_PLAN}${alerted ? LINK_REFUSED_ALERTED : ""}` };
	}
	await recordSetupRefusal({ userId, subscriptionId, refused: "held", close: false });
	return { kind: "refused", clause: heldNotice(hold, userId) };
}

/**
 * The link's refusal of an ENDED X with no open hold (§5.6, the first two rows; C86). The setup is
 * closed with `refused_reason = 'ended'` (`recordSetupRefusal`, which closes only while no hold is open).
 * The sentence is chosen by `endedSetupRead` and worded by `endedSetupClause` (lib/billing/new-org-setup.ts),
 * which the resume lookup also uses, with the team stated as existing: the link runs only once it does.
 *   - A hold already RELEASED as `refunded` or `already_refunded` names X (the newest released hold on
 *     X): the §5.5 refund clause, and no alert. That release read every covering refund `succeeded`.
 *   - Otherwise the payments are read as `readNewOrgPlanState` reads them: `not_charged` (no money moved)
 *     is the "not charged" clause and no alert; anything else — money may have moved, or the read failed
 *     — is the "contact support" clause and `alertEndedUnconfirmed`'s alert.
 * It refunds nothing: only a hold may refund (I3).
 */
async function refuseEndedLink(userId: string, sub: Stripe.Subscription, orgId: string): Promise<NewOrgLinkResult> {
	const released = await latestReleasedHoldOn(sub.id);
	const releasedReason = released?.release_reason ?? null;
	const { planState } = await readNewOrgPlanState(sub);
	const read = endedSetupRead(releasedReason, planState);
	const closed = await recordSetupRefusal({ userId, subscriptionId: sub.id, refused: "ended", close: true });
	logBillingEvent("billing.new_org_link.refused", {
		subscription_id: sub.id,
		customer_id: subscriptionCustomerId(sub),
		org_id: orgId,
		x_read: sub.status,
		plan_state: read === "refunded" ? "refunded" : planState,
		setup_closed_now: closed ? "true" : "false",
	});
	const alerted =
		read === "unconfirmed" &&
		(await alertEndedUnconfirmed(sub, closed ?? (await pendingOrgSetupFor(userId, sub.id)), { link: orgId }));
	return { kind: "refused", clause: endedSetupClause(read, { alerted, teamExists: true }) };
}

/**
 * The alert for an ended X with no open hold whose money is NOT proven unmoved (§5.6 "The alert: the
 * link's, under the link's rule"), for the link (`{ link: orgId }`) and for the resume lookup
 * (`"resume"`), which stops the sheet before the link and so carries the same watch. Call it only for an
 * `unconfirmed` read. `record` is X's setup record as it stands now, or null when there is none.
 * `closedSince` replaces `record.closed_at` as the dedupe's start when the caller knows a database-clock
 * instant at or before the close (the lookup, when its own closer just closed the record).
 *
 * It raises nothing, and answers true, when an alert about X has already reached a channel since its
 * setup closed, or since X ended when the record is not closed (`alertedAboutSince`). An earlier close is
 * no reason by itself to stay quiet: the closer reads the payments at ITS moment, money can move on a
 * cancelled X's open invoice later (a stale tab), and the webhook opens no hold for it. So a close that
 * alerted nothing is followed by this alert, and a retry after a delivered alert is not — whatever the
 * alert rule's throttle is (its default is none). An alert the closer did deliver also silences this one,
 * even when money moved after it: nothing records what the closer's read saw, so that change cannot be
 * told from a repeat. Otherwise it alerts with X as the subject and answers whether the alert reached a
 * channel — so a clause built on the answer claims an alert only when one did (I8).
 */
async function alertEndedUnconfirmed(
	sub: Stripe.Subscription,
	record: PendingOrgSetupRow | null,
	trigger: { link: string } | "resume",
	closedSince: Date | null = null,
): Promise<boolean> {
	const endedAt = typeof sub.ended_at === "number" ? new Date(sub.ended_at * 1000) : null;
	if (await alertedAboutSince(sub.id, closedSince ?? record?.closed_at ?? endedAt)) return true;
	const who =
		trigger === "resume"
			? "a resume lookup of the setup reported it ended"
			: `the link to team ${trigger.link} was refused`;
	return alertPaymentNeedsSupport({
		subscriptionId: sub.id,
		customerId: subscriptionCustomerId(sub),
		paymentIntentId: null,
		context: "setup_closed",
		detail: `${who} because the subscription reads ${sub.status}, and its first payment is not proven unmoved. ${setupRecordLine(record)} No hold has refunded it; check the payment and refund it by hand if it was taken.`,
	});
}

/**
 * Whether an operator alert about `resourceId` — a subscription X, or a user for the create-a-team
 * over-cap alert (`system.platform.payment_needs_support`, `resource_id` = it) — has reached a channel at
 * or after `since`, or ever, when `since` is null: a delivery row exists, not dead. A delivery row is
 * written only for an alert routed to a channel, so an alert that reached none never silences a later one.
 */
async function alertedAboutSince(resourceId: string, since: Date | null): Promise<boolean> {
	const [hit] = await getServiceDb()
		.select({ id: alertDeliveries.id })
		.from(alertDeliveries)
		.where(
			and(
				eq(alertDeliveries.event_key, OPERATOR_ALERT_EVENT),
				sql`${alertDeliveries.context}->>'resource_id' = ${resourceId}`,
				ne(alertDeliveries.status, "dead"),
				since ? gte(alertDeliveries.created_at, since) : undefined,
			),
		)
		.limit(1);
	return hit !== undefined;
}

/**
 * What the ended-X alert says of the setup record, because its context's summary speaks of a closed
 * setup: true only when the record is closed, so every other case says what it is.
 */
function setupRecordLine(record: PendingOrgSetupRow | null): string {
	if (!record) return "No setup record names this subscription, so no setup was closed.";
	if (record.closed_at) return `Its setup record is closed (${record.closed_reason ?? "no reason"}).`;
	return record.linked_at ? "Its setup record is linked, not closed." : "Its setup record is still open.";
}

/**
 * What `linkSubscriptionToNewOrg` did (ADR 0002 §5.6): linked, with the plan state it read (#5539's
 * report, unchanged), or refused, with the sentence the sheet shows. The sheet treats a refusal as final
 * and offers no retry; the setup itself is closed only when X is ended and unheld, and otherwise stays
 * open for the hold that names X, whose release closes it or whose adoption re-links it (I16).
 */
export type NewOrgLinkResult =
	| ({ kind: "linked" } & NewOrgPlanReport)
	| { kind: "refused"; clause: string };

/**
 * The plan state of a create-a-team subscription (#5522): its status, plus — for `incomplete`,
 * `canceled` and `incomplete_expired` — what its first invoice's payments show. A failed payments
 * read is not an error here (the link and the resume must not fail over what they SAY): the state
 * is then decided without it (`unconfirmed` for an `incomplete` one), which claims least.
 *
 * For `action_needed` it also returns Stripe's hosted page for the open first invoice, where the
 * customer can complete the payment — Billing has no control that finishes a first payment, so the
 * sheet must not send them there.
 */
async function readNewOrgPlanState(sub: Stripe.Subscription): Promise<NewOrgPlanReport> {
	if (!PAYMENT_DEPENDENT_STATUSES.has(sub.status)) {
		return { planState: newOrgPlanState(sub.status, null), paymentUrl: null };
	}
	let payment: FirstPaymentRead | null = null;
	try {
		const read = await readPaymentAfterCancel(sub);
		payment =
			read.kind === "processing"
				? "in_flight"
				: read.kind === "took_money"
					? "succeeded"
					: read.kind === "no_money"
						? "none"
						: "unrecognised";
	} catch {
		payment = null;
	}
	const planState = newOrgPlanState(sub.status, payment);
	return {
		planState,
		paymentUrl: planState === "action_needed" ? await openInvoicePaymentUrl(sub) : null,
	};
}

/** True only for a parseable `https:` URL whose host is exactly `invoice.stripe.com`. */
function isStripeInvoiceUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.host === "invoice.stripe.com";
	} catch {
		return false;
	}
}

/**
 * Stripe's hosted page for a subscription's first invoice while that invoice is still `open` (so it
 * can be paid or its bank confirmation completed there), or null — when it is not open, has no page,
 * the read fails, or the URL is not `https://invoice.stripe.com/…` exactly (parsed, not prefix-matched):
 * the sheet renders it as a link, so nothing but Stripe's own invoice host may reach it.
 */
async function openInvoicePaymentUrl(sub: Stripe.Subscription): Promise<string | null> {
	const invoiceId =
		typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
	if (!invoiceId) return null;
	try {
		const invoice = await getStripe().invoices.retrieve(invoiceId);
		const url = invoice.hosted_invoice_url;
		return invoice.status === "open" && url && isStripeInvoiceUrl(url) ? url : null;
	} catch {
		return null;
	}
}

/**
 * The caller's record of a new-org subscription, BACKFILLED for one minted before the record existed
 * (#5445) — those have only Stripe's `created_by` to say whose they are. Null for a subscription that
 * was not minted for `userId`.
 */
async function setupRecordFor(
	sub: Stripe.Subscription,
	userId: string,
): Promise<PendingOrgSetupRow | null> {
	if (sub.metadata?.created_by !== userId) return null;
	const existing = await pendingOrgSetupFor(userId, sub.id);
	if (existing) return existing;
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	const customer = typeof sub.customer === "string" ? null : sub.customer;
	const name = customer && !customer.deleted ? (customer.name ?? "") : "";
	await recordPendingOrgSetup({
		userId,
		subscriptionId: sub.id,
		customerId,
		name,
		slug: slugifyOrEmpty(name),
	});
	return pendingOrgSetupFor(userId, sub.id);
}

/**
 * The server's own answer to "how far has this paid create-a-team setup got?" (#5445), from the
 * subscription (Stripe) and the caller's setup record. Null when the subscription was not minted for
 * `userId`, or is linked to an organization `userId` is not an owner of — nothing of theirs to resume.
 *
 * The organization is the one the record names or the one carrying the server-stamped marker
 * (`findSetupOrg`, which does not depend on the owner member row and repairs a missing one), or the
 * one the subscription is already linked to.
 */
async function newOrgSetupStateFor(
	sub: Stripe.Subscription,
	userId: string,
): Promise<NewOrgSetupState | null> {
	const row = await setupRecordFor(sub, userId);
	if (!row) return null;
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	const db = getServiceDb();

	const linkedTo = sub.metadata?.organization_id ?? null;
	let org = await findSetupOrg(row, userId);
	if (linkedTo && org?.id !== linkedTo) {
		const [owned] = await db
			.select({ id: organization.id, slug: organization.slug })
			.from(member)
			.innerJoin(organization, eq(member.organizationId, organization.id))
			.where(
				and(
					eq(member.organizationId, linkedTo),
					eq(member.userId, userId),
					eq(member.role, "owner"),
				),
			)
			.limit(1);
		if (!owned) return null;
		org = { id: owned.id, slug: owned.slug ?? "" };
	}

	// The setup closer runs before the lookup answers (ADR 0002 §5.6, §5.7): an open setup whose X
	// reads ended is closed, and one a lost response left linked in Stripe is adopted. The answer
	// below is about X and does not depend on it, so a closer that cannot read is logged, not thrown —
	// the setup stays open and the next reader tries again. When the closer may close it here, the
	// database's clock is read first: an alert the closer raises is dated by that clock, and the ended
	// report below must see that alert (`endedSetupFor`).
	const beforeClose =
		!row.closed_at && !row.linked_at && ENDED_SUBSCRIPTION_STATUSES.has(sub.status) ? await databaseNow(row.id) : null;
	await settleOpenSetupQuietly(row, sub, org?.id ?? null);

	let declared = false;
	if (org) {
		const [billing] = await db
			.select({
				payerCapacity: organizationBilling.payerCapacity,
				authorityAttestation: organizationBilling.authorityAttestation,
			})
			.from(organizationBilling)
			.where(eq(organizationBilling.organizationId, org.id))
			.limit(1);
		declared =
			!!billing?.payerCapacity &&
			(billing.payerCapacity !== "organization" || !!billing.authorityAttestation);
		// A declaration that landed but whose stamp did not (a lost response) is recorded now, so the
		// setup stops being reported as unfinished.
		if (declared && !row.declared_at && linkedTo === org.id) {
			await markPendingOrgSetupDeclared(userId, org.id, sub.id);
		}
	}
	// A setup an open payment hold names is reported WITH that hold, and with no payment link (§5.6,
	// C84): the hold may be voiding that invoice, or refunding a payment of it.
	const hold = await openPaymentHoldOn(sub.id);
	const report = await readNewOrgPlanState(sub);
	return {
		subscriptionId: sub.id,
		customerId,
		paid: PAID_SUBSCRIPTION_STATUSES.has(sub.status),
		...report,
		...(hold ? { paymentUrl: null } : {}),
		hold: hold && hold.state !== "released" ? { state: hold.state, notice: heldNotice(hold, userId) } : null,
		ended:
			hold && hold.state !== "released"
				? null
				: await endedSetupFor({ sub, userId, row, linked: !!linkedTo, beforeClose, planState: report.planState, teamExists: org !== null }),
		org,
		linked: !!linkedTo,
		declared,
		name: row.intended_name,
		slug: org?.slug || row.intended_slug,
		billing: row.billing ?? null,
		currency: sub.currency,
	};
}

/**
 * What a resume lookup reports about an ENDED X with no open hold (§5.6 "The lookup reports an ended
 * setup"): exactly the sentence the link would refuse it with (`refuseEndedLink`), so the sheet can stop
 * before the link. Call it only when no open hold names X: the link reads holds first, and so does the
 * lookup. Null:
 *   - for an X that has not ended. A `paused` one, or one of a status Stripe may add, is linked by the
 *     link, so the test is the link's own (`ENDED_SUBSCRIPTION_STATUSES`), never `planState`;
 *   - for a setup already LINKED: X's metadata names an organization (`linked`), or the setup record
 *     carries `linked_at`. The sheet does not call the link for a setup the server reports linked to its
 *     org, so it must not stop there either; a linked X that ended later is a plan that ran, not a
 *     checkout that was closed.
 *
 * For an `unconfirmed` read it raises the link's alert through `alertEndedUnconfirmed`, under the link's
 * dedupe. The setup record is read again for it, because the closer the lookup ran just before may have
 * closed it. When it did, the dedupe counts from `beforeClose`, the database's clock read before the
 * closer ran, rather than from `closed_at`, which the closer stamps with this server's clock: an alert
 * the closer raised is dated by the database, and must silence this one whatever the two clocks say.
 * It writes nothing else.
 */
async function endedSetupFor(input: {
	sub: Stripe.Subscription;
	userId: string;
	/** The setup record as the lookup read it, before the closer ran. */
	row: PendingOrgSetupRow;
	linked: boolean;
	beforeClose: Date | null;
	planState: NewOrgPlanState;
	teamExists: boolean;
}): Promise<{ clause: string } | null> {
	const { sub } = input;
	if (!ENDED_SUBSCRIPTION_STATUSES.has(sub.status)) return null;
	const record = await pendingOrgSetupFor(input.userId, sub.id);
	if (input.linked || input.row.linked_at || record?.linked_at) return null;
	const released = await latestReleasedHoldOn(sub.id);
	const read = endedSetupRead(released?.release_reason ?? null, input.planState);
	const closedNow = !input.row.closed_at && !!record?.closed_at;
	const alerted =
		read === "unconfirmed" &&
		(await alertEndedUnconfirmed(sub, record, "resume", closedNow ? input.beforeClose : null));
	return { clause: endedSetupClause(read, { alerted, teamExists: input.teamExists }) };
}

/**
 * The database's clock now, read through the setup record `setupId` (a row that exists), or null when
 * the row is gone. What `alert_deliveries.created_at` is stamped by.
 */
async function databaseNow(setupId: string): Promise<Date | null> {
	const [hit] = await getServiceDb()
		.select({ now: sql<Date>`now()`.mapWith((v: string | Date) => new Date(v)) })
		.from(pendingOrgSetups)
		.where(eq(pendingOrgSetups.id, setupId))
		.limit(1);
	return hit?.now ?? null;
}

/**
 * What a resume lookup tells `userId` about the open hold on their setup: the hold's clause (§5.5) when
 * the hold is theirs, else the generic one — another payer's hold is never described (S4's warning).
 */
function heldNotice(hold: PaymentHoldRow, userId: string): string {
	return (hold.payer_key === userId ? holdClause(hold, { refusing: true }) : null) ?? NOT_CONFIRMED_CLOSED;
}

/**
 * Runs the setup closer for a lookup, which must answer whether or not it could: a failure is logged
 * and the setup stays open for the next reader (the guard, which does fail closed, or another lookup).
 */
async function settleOpenSetupQuietly(
	row: PendingOrgSetupRow,
	sub: Stripe.Subscription,
	orgId: string | null,
): Promise<void> {
	if (row.closed_at || row.linked_at) return;
	try {
		await settleOpenSetup(row, { sub, orgId });
	} catch (e) {
		console.error(`[billing] setup closer could not check ${row.subscription_id}:`, e);
	}
}

/**
 * Where a paid create-a-team setup stands, read from Stripe and the caller's setup record (#5445). The
 * sheet asks this before every run of the post-payment steps, so the browser's copy of the setup is
 * only a hint: an organization created by a request whose response was lost is FOUND here and reused,
 * never created a second time.
 *
 * Returns null — never throws — when the subscription is not the caller's, so a stale or tampered
 * browser record cannot learn anything about someone else's subscription.
 */
export async function resolveNewOrgSetup(input: {
	subscriptionId: string;
	customerId: string;
}): Promise<NewOrgSetupState | null> {
	const actor = await currentActor();
	requireHostedBilling();
	let sub: Stripe.Subscription;
	try {
		sub = await getStripe().subscriptions.retrieve(input.subscriptionId, {
			expand: ["customer"],
		});
	} catch (e) {
		// A missing subscription is an answer ("not yours"); anything else is an outage the caller
		// must see as a failure, not as "there is nothing to resume".
		if (isStripeResourceMissing(e)) return null;
		throw e;
	}
	if (sub.metadata?.created_by !== actor.userId) return null;
	const subCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	if (subCustomerId !== input.customerId) return null;
	return newOrgSetupStateFor(sub, actor.userId);
}

/** How many setup records `findUnfinishedNewOrgSetup` reads per page. */
const UNFINISHED_PAGE = 10;

/**
 * The caller's paid create-a-team setup that never finished, found WITHOUT any browser record (#5445):
 * a closed tab, cleared site data, a crash a second after the charge. Without this the sheet offered a
 * new purchase to a customer already charged.
 *
 * Read from the caller's setup records (`declared_at IS NULL`, newest first, page by page), each checked
 * against Stripe by id — a direct read, so a subscription paid a second ago is found. A record is dropped
 * on the way only when Stripe says its subscription expired and its first payment never happened
 * (`forgetPendingOrgSetup`'s guard, on `readFirstPayment`'s verdict); one that
 * was cancelled, or that Stripe cannot find, is skipped and KEPT — a cancelled subscription may have
 * been paid first, and a missing one is not proof of anything. An expired one whose payments cannot be
 * read is skipped and kept as well (#5463): that one record could not be checked, which is no reason to
 * fail the whole lookup.
 *
 * The pages are KEYSET pages (after the last row's `created_at`, `id`), not OFFSET pages (#5463):
 * dropping a record shifted every later row back by one, so an OFFSET window skipped the row that
 * moved into the part already read.
 *
 * Subscriptions minted before the record existed have none. For those this falls back to Stripe's
 * search API (which indexes with a delay, irrelevant for a subscription that old) and backfills a
 * record for the newest PAID one that is linked to no organization. That covers a legacy charge whose
 * organization was never created or never linked. It does NOT cover a legacy organization that was
 * created but not linked: nothing marks it, so recovery creates a new one — the old organization is
 * left as it was, and when the derived slug collides with it the sheet asks for a new URL.
 */
export async function findUnfinishedNewOrgSetup(): Promise<NewOrgSetupState | null> {
	const actor = await currentActor();
	// A deployment without Stripe never took a payment, so there is nothing to finish — an answer,
	// not a failure (the sheet reports a failure as "couldn't check").
	if (!isStripeConfigured()) return null;
	const stripe = getStripe();
	// Read page by page until a live one is found or the records run out, so records that are dead for
	// good (a subscription cancelled after payment, or one Stripe cannot find — both kept) never fill
	// the window and hide an older unfinished paid one behind them.
	const seen = new Set<string>();
	let after: UnfinishedSetupCursor | undefined;
	for (;;) {
		const page = await unfinishedPendingOrgSetups(actor.userId, UNFINISHED_PAGE, after);
		for (const row of page.rows) {
			seen.add(row.subscription_id);
			let sub: Stripe.Subscription;
			try {
				sub = await stripe.subscriptions.retrieve(row.subscription_id, { expand: ["customer"] });
			} catch (e) {
				if (!isStripeResourceMissing(e)) throw e;
				continue;
			}
			if (!PAID_SUBSCRIPTION_STATUSES.has(sub.status)) {
				if (sub.status === "incomplete_expired") {
					let firstPayment: FirstPayment;
					try {
						firstPayment = await readFirstPayment(sub);
					} catch {
						continue;
					}
					await forgetPendingOrgSetup(actor.userId, sub, firstPayment);
				}
				// A record still there — it has an organization, or its payment is not proven unmoved, or it
				// was cancelled — is CLOSED once it reads ended (#5714), so it no longer blocks that
				// organization's plan purchases; it used to be skipped and kept open for good. One the line
				// above deleted matches nothing in the closer's compare-and-set, so nothing is logged twice.
				if (ENDED_SUBSCRIPTION_STATUSES.has(sub.status)) {
					await settleOpenSetupQuietly(row, sub, row.created_org_id);
				}
				continue;
			}
			const state = await newOrgSetupStateFor(sub, actor.userId);
			if (state && !(state.linked && state.declared)) return state;
		}
		if (!page.next) break;
		after = page.next;
	}
	const found = await stripe.subscriptions.search({
		query: `metadata['created_by']:'${actor.userId}'`,
		limit: 20,
		expand: ["data.customer"],
	});
	const newestFirst = [...found.data].sort((a, b) => b.created - a.created);
	for (const sub of newestFirst) {
		if (!PAID_SUBSCRIPTION_STATUSES.has(sub.status)) continue;
		if (sub.metadata?.organization_id || seen.has(sub.id)) continue;
		const state = await newOrgSetupStateFor(sub, actor.userId);
		if (state) return state;
	}
	return null;
}

/** True for Stripe's "No such subscription" error — the id names nothing. */
function isStripeResourceMissing(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		Reflect.get(e, "code") === "resource_missing"
	);
}

/**
 * Sets (or clears) a tax id on a standalone new-org customer — the create-org sheet's
 * inline "Tax ID (optional)" field, collected at the payment step before the org exists.
 * Verifies the customer was minted by this actor (created_by metadata, the same guard as
 * linkSubscriptionToNewOrg) so one user can't write tax ids onto another's customer.
 * Replaces any prior tax ids (one per customer in our UI).
 */
export async function attachTaxIdToCustomer(input: {
	customerId: string;
	type: TaxIdType;
	value: string;
}): Promise<{ ok: true }> {
	const actor = await currentActor();
	requireHostedBilling();

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to set a tax id on this customer.");
	}

	const existing = await stripe.customers.listTaxIds(input.customerId, {
		limit: 5,
	});
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(input.customerId, t.id);
	}
	const trimmed = input.value.trim();
	if (trimmed) {
		await stripe.customers.createTaxId(input.customerId, {
			type: input.type,
			value: trimmed,
		});
	}
	return { ok: true };
}

/**
 * Billing name + address on a standalone new-org customer (mirrors attachTaxIdToCustomer)
 * — the create-org sheet's Full Name / Country / Address line, collected before the org
 * exists. Guarded by the customer's `created_by` so it can't write onto another's
 * customer. Once the org is linked, updateBillingAddress is the org-scoped equivalent.
 */
export async function setCustomerBillingAddress(input: {
	customerId: string;
	address: BillingAddressInput;
}): Promise<{ ok: true }> {
	const actor = await currentActor();
	requireHostedBilling();

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to set an address on this customer.");
	}
	await stripe.customers.update(input.customerId, {
		name: input.address.name,
		address: {
			line1: input.address.line1,
			line2: input.address.line2,
			city: input.address.city,
			state: input.address.state,
			postal_code: input.address.postalCode,
			country: input.address.country,
		},
	});
	return { ok: true };
}

/** A one-time credit-pack payment awaiting confirmation, for the embedded Payment Element. */
export interface CreditPackIntent {
	clientSecret: string;
	/** The Stripe invoice raised for this purchase (yields a compliant PDF). */
	invoiceId: string;
}

/**
 * Raises a one-time **invoice** for an AI credit pack (a top-up beyond the plan's
 * included usage) so every purchase yields a compliant, numbered PDF. Flow: add an
 * invoice item → create + finalize a `charge_automatically` invoice → return its
 * PaymentIntent client secret. The embedded <PaymentForm mode="payment"> confirms it
 * inline (unchanged — confirmPayment works the same for an invoice's PI); the webhook's
 * `invoice.payment_succeeded` branch grants the credits (idempotent on the invoice id)
 * and emails the receipt with the PDF attached. Owner-gated; org-scoped; hosted only;
 * PAID-tier only — packs top up a plan, they don't replace one (the free tier upgrades
 * instead; mirrors the client's upgrade-first panel).
 */
export async function createCreditPackIntent(
	packId: string,
): Promise<CreditPackIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before buying AI credits.");
	}
	const tier = await resolveAiTier(actor.orgId);
	if (tier === "ai_free") {
		throw new Error(
			"Credit packs are available on paid AI plans — upgrade to AI Plus or AI Max first.",
		);
	}
	const pack = creditPack(packId);
	if (!pack) throw new Error("Unknown credit pack.");
	await gatePaidConversion(actor);

	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const stripe = getStripe();
	// Metadata identifies the purchase on the invoice.payment_succeeded event.
	const metadata = {
		organization_id: actor.orgId,
		user_id: actor.userId,
		product_type: "ai_credits",
		credits: String(pack.credits),
	};

	const description = `${pack.credits.toLocaleString("en-US")} AI credits`;
	// Create the draft first (pin USD — the account's default currency is EUR), then
	// attach the line item directly to it. In the current API version a manual invoice
	// no longer auto-pulls pending items, so `invoice: draft.id` is required.
	// auto_advance:false keeps the invoice `open` (no auto-charge even with a default
	// card) so the customer always confirms via the embedded form.
	const draft = await stripe.invoices.create({
		customer: customerId,
		currency: "usd",
		collection_method: "charge_automatically",
		auto_advance: false,
		description,
		metadata,
	});
	if (!draft.id) throw new Error("Stripe did not return an invoice id.");
	await stripe.invoiceItems.create({
		customer: customerId,
		invoice: draft.id,
		amount: pack.amountCents,
		currency: "usd",
		description,
		metadata,
	});
	const invoice = await stripe.invoices.finalizeInvoice(draft.id, {
		expand: ["confirmation_secret"],
	});
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret for the invoice.");
	}
	return { clientSecret, invoiceId: invoice.id ?? draft.id };
}

// ── Payment methods (embedded card management) ──────────────────────────────

/** A saved card for the active org's billing UI. */
export interface PaymentMethodInfo {
	id: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
	isDefault: boolean;
	/** Backup order (0-based) for dunning failover; null when this card isn't a backup. */
	backupRank: number | null;
}

/** Creates a SetupIntent to add/save a card via the embedded Payment Element. */
export async function createSetupIntent(): Promise<{ clientSecret: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before adding a card.");
	}
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const si = await getStripe().setupIntents.create({
		customer: customerId,
		usage: "off_session",
		payment_method_types: ["card"],
		// Require the billing address WITH the card, rather than hoping one is set elsewhere.
		//
		// A card saved with no address is not a usable default: Stripe Tax cannot determine the place
		// of supply, so the first invoice it backs either fails or is raised with the wrong tax — and
		// the customer discovers that at renewal, off-session, with nobody watching. Collecting it at
		// the moment the card is entered is also the only point where the user is present to type it.
		payment_method_options: {
			card: { request_three_d_secure: "automatic" },
		},
	});
	if (!si.client_secret) {
		throw new Error("Stripe did not return a setup client secret.");
	}
	return { clientSecret: si.client_secret };
}

/** Lists the active org's saved cards (with which one is the default). */
export async function listPaymentMethods(): Promise<PaymentMethodInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	const defaultRef =
		"deleted" in customer
			? null
			: customer.invoice_settings.default_payment_method;
	const defaultId =
		typeof defaultRef === "string" ? defaultRef : (defaultRef?.id ?? null);

	const pms = await stripe.paymentMethods.list({
		customer: billing.stripeCustomerId,
		type: "card",
	});
	return pms.data
		.map((pm) => ({
			id: pm.id,
			brand: pm.card?.brand ?? "card",
			last4: pm.card?.last4 ?? "••••",
			expMonth: pm.card?.exp_month ?? 0,
			expYear: pm.card?.exp_year ?? 0,
			isDefault: pm.id === defaultId,
			backupRank: backupRankOf(pm),
		}))
		// Default (primary) first, then ranked backups ascending, then any unranked cards.
		.sort((a, b) => {
			if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
			const ar = a.backupRank ?? Number.MAX_SAFE_INTEGER;
			const br = b.backupRank ?? Number.MAX_SAFE_INTEGER;
			return ar - br;
		});
}

/**
 * Sets the org's backup-card order (for dunning failover) — the given ids become the
 * ordered backups; every other card is cleared. Owner-gated; org-scoped.
 */
export async function setBackupCards(
	orderedPmIds: string[],
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");
	await setBackupOrder(billing.stripeCustomerId, orderedPmIds);
	return { ok: true };
}

/** Makes a saved card the default for invoices + the active subscription. */
export async function setDefaultPaymentMethod(
	pmId: string,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	// A default payment method is what future off-session charges run on, so promoting one is the
	// point at which the account's OWN preconditions must hold — not the moment a charge is later
	// attempted with nobody present to fix anything.
	//
	// Two, and both are about the same thing: a renewal that cannot be justified. Without current
	// acceptance there is no agreement covering the charge; without a billing address Stripe Tax has
	// no place of supply, so the invoice is raised with the wrong tax or not at all. Verified against
	// the card ITSELF, not only the customer record — a card carrying its own billing address is a
	// perfectly good source, and requiring the customer-level one as well would refuse a setup that
	// is actually complete.
	if (!(await hasAcceptedCurrentDocuments(actor.userId))) {
		throw new Error(
			"Accept the current Terms of Service before setting a default payment method — " +
				"renewals charged against it need an agreement that covers them.",
		);
	}
	const pmForDefault = await stripe.paymentMethods.retrieve(pmId);
	const pmOwner =
		typeof pmForDefault.customer === "string"
			? pmForDefault.customer
			: (pmForDefault.customer?.id ?? null);
	if (pmOwner !== billing.stripeCustomerId) {
		// Same check detachPaymentMethod makes, and for the same reason: without it one org could
		// promote another org's card by id.
		throw new Error("Payment method not found.");
	}
	const cardCountry = pmForDefault.billing_details?.address?.country ?? null;
	if (!cardCountry && !billing.billingCountry) {
		throw new Error(
			"Add a billing address before setting a default payment method — without one we cannot " +
				"determine the tax due on a renewal.",
		);
	}
	await stripe.customers.update(billing.stripeCustomerId, {
		invoice_settings: { default_payment_method: pmId },
	});
	if (billing.stripeSubscriptionId) {
		await stripe.subscriptions.update(billing.stripeSubscriptionId, {
			default_payment_method: pmId,
		});
	}
	return { ok: true };
}

/** Removes a saved card (after verifying it belongs to the active org's customer). */
export async function detachPaymentMethod(pmId: string): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const pm = await stripe.paymentMethods.retrieve(pmId);
	const ownerId =
		typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
	if (ownerId !== billing.stripeCustomerId) {
		throw new Error("Payment method not found.");
	}
	await stripe.paymentMethods.detach(pmId);
	return { ok: true };
}

// ── Subscription management (embedded — replaces the Customer Portal) ────────

/** Loads the active org's subscription, or throws if there isn't one. */
async function requireSubscriptionId(orgId: string): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (!billing?.stripeSubscriptionId) {
		throw new Error("No active subscription.");
	}
	return billing.stripeSubscriptionId;
}

/** Schedules cancellation at the end of the current paid period. */
export async function cancelSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
	return { ok: true };
}

/** Un-schedules a pending cancellation. */
export async function resumeSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: false });
	return { ok: true };
}

/** Switches the active subscription to a different paid plan, prorated. */
export async function changeSubscriptionPlan(
	plan: PaidPlan,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	// A plan change is a paid conversion: it raises a prorated charge, and it is the path a user
	// takes OUT of a trial. Exempting it because "they already pay" is how the gate would come to
	// cover only the first purchase.
	await gatePaidConversion(actor);
	const subId = await requireSubscriptionId(actor.orgId);
	const stripe = getStripe();
	const sub = await stripe.subscriptions.retrieve(subId);

	// Distinguish the flat plan item from the metered runner-minutes item so a plan
	// change swaps both (their graduated included tiers differ per plan).
	const meterIds = configuredMeterPriceIds();
	let flatItemId: string | undefined;
	let meterItemId: string | undefined;
	for (const it of sub.items.data) {
		if (meterIds.has(it.price.id)) meterItemId = it.id;
		else flatItemId = it.id;
	}
	if (!flatItemId) throw new Error("Subscription has no plan line item.");

	const items: Stripe.SubscriptionUpdateParams.Item[] = [
		{ id: flatItemId, price: priceIdForPlan(plan) },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter && meterItemId) items.push({ id: meterItemId, price: meter });
	else if (meter) items.push({ price: meter });
	else if (meterItemId) items.push({ id: meterItemId, deleted: true });

	await stripe.subscriptions.update(subId, {
		items,
		proration_behavior: "create_prorations",
	});
	return { ok: true };
}

// ── Invoices + billing details / VAT ────────────────────────────────────────

/** An invoice row for the billing UI — sourced from our locally-mirrored `invoice` table
 *  (only invoices for which money moved), never a live Stripe API call. */
export interface InvoiceInfo {
	/** Our invoice id (used for the preview + PDF-download route). */
	id: string;
	number: string | null;
	/** Total in the smallest currency unit (e.g. cents). */
	total: number;
	currency: string;
	status: InvoiceStatus;
	/** ISO instant the invoice was paid — the primary display/sort date. */
	paidAt: string;
	/** Billing period the invoice covers (ISO), if known. */
	periodStart: string | null;
	periodEnd: string | null;
	description: string | null;
	/** A self-hosted PDF is available at the download route. */
	hasPdf: boolean;
	/** Stripe's hosted invoice URL — a fallback link only. */
	hostedInvoiceUrl: string | null;
}

/** Maps a mirrored invoice row to the UI shape. */
function toInvoiceInfo(row: Invoice): InvoiceInfo {
	return {
		id: row.id,
		number: row.number,
		total: row.amountTotal,
		currency: row.currency,
		status: row.status,
		paidAt: (row.paidAt ?? row.createdAt).toISOString(),
		periodStart: row.periodStart?.toISOString() ?? null,
		periodEnd: row.periodEnd?.toISOString() ?? null,
		description: row.description,
		hasPdf: Boolean(row.pdfKey) || Boolean(row.hostedInvoiceUrl),
		hostedInvoiceUrl: row.hostedInvoiceUrl,
	};
}

/** Optional filters for the invoices list (period range + status). */
export interface InvoiceListParams {
	status?: InvoiceStatus[];
	paidFrom?: string;
	paidTo?: string;
	limit?: number;
}

// NO `requireHostedBilling()` on either read below, and its absence is the fix for the HTTP 500
// the UI conformance audit recorded on `~/settings/billing/invoices` (#3731).
//
// That guard's own contract is "before any Stripe call" — and these two make none: they read the
// MIRRORED `invoice` table this deployment already owns. It threw whenever STRIPE_SECRET_KEY is
// unset, which is every self-managed install and every sandbox env, turning a plain table read
// into an unhandled server-action rejection → 500. Both of the audit's two 500s per visit were
// `listInvoices` — the panel's filtered rows query and its unfiltered facet-count query.
//
// The main billing panel never showed it because it returns a "Self-managed deployment" card
// before it mounts anything that calls these; the dedicated invoices page has no such gate, so it
// called straight through. Refusing to READ mirrored history because Stripe is not wired is also
// wrong on its own terms — an org that once paid keeps its invoices, and an org that never did
// simply has none, which is an empty list, not an error.

/**
 * Lists the active org's mirrored invoices (newest paid first), from the local table — no
 * Stripe call, so it's fast and only ever shows real paid invoices. Filterable by period
 * range + status.
 */
export async function listInvoices(
	params: InvoiceListParams = {},
): Promise<InvoiceInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const rows = await listOrgInvoices(actor.orgId, params);
	return rows.map(toInvoiceInfo);
}

/**
 * Loads one invoice for the active org, or null if it isn't theirs.
 *
 * NO PRODUCTION CALLER TODAY — `git grep getInvoice` finds this definition and its tests, nothing
 * else. It used to say "(preview dialog)", which is wrong and was worth correcting rather than
 * inheriting: `InvoicePreviewDialog` is presentational and takes an `InvoiceInfo` PROP that both
 * its parents already hold from `listInvoices`, and the PDF route calls `getOrgInvoice` directly.
 * So this action contributed NONE of the 500s in #3731 — both were `listInvoices`. It is kept and
 * fixed alongside its sibling because it is the same read over the same table and an inconsistent
 * guard between the two is the next reader's trap; if it still has no caller when someone next
 * touches this file, delete it rather than re-explaining it.
 */
export async function getInvoice(id: string): Promise<InvoiceInfo | null> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const row = await getOrgInvoice(actor.orgId, id);
	return row ? toInvoiceInfo(row) : null;
}

// ── Transactions (Stripe charges) ───────────────────────────────────────────

/** A charge row for the transaction-history table. */
export interface TransactionInfo {
	id: string;
	/** What the charge was for (Stripe description, or a sensible fallback). */
	description: string;
	/** Normalized outcome driving the status badge. */
	status: "paid" | "pending" | "failed" | "refunded";
	/** Smallest-unit amount; negative for refunds. */
	amount: number;
	currency: string;
	created: string;
	/** "Visa ···· 4242", or null when the method isn't a card. */
	method: string | null;
}

/** Maps a Stripe charge to our normalized transaction shape. */
function toTransaction(charge: Stripe.Charge): TransactionInfo {
	const card = charge.payment_method_details?.card;
	const method = card
		? `${card.brand ?? "card"} ···· ${card.last4 ?? "••••"}`
		: null;
	const refunded = charge.refunded || charge.amount_refunded > 0;
	const status: TransactionInfo["status"] = refunded
		? "refunded"
		: charge.status === "succeeded"
			? "paid"
			: charge.status === "failed"
				? "failed"
				: "pending";
	return {
		id: charge.id,
		description: charge.description ?? "Subscription payment",
		status,
		amount: refunded ? -charge.amount_refunded : charge.amount,
		currency: charge.currency,
		created: new Date(charge.created * 1000).toISOString(),
		method,
	};
}

/** Lists the active org's recent charges (paid / failed / refunded) for the ledger. */
export async function listTransactions(): Promise<TransactionInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const charges = await getStripe().charges.list({
		customer: billing.stripeCustomerId,
		limit: 24,
	});
	return charges.data.map(toTransaction);
}

// ── Plan history (minimal — derived, no event log yet) ──────────────────────

/** A plan-history timeline entry. */
export interface PlanHistoryEntry {
	when: string;
	title: string;
	detail: string;
	/** The current (most recent) entry — rendered as the active node. */
	current: boolean;
}

/**
 * A best-effort plan-history timeline for the active org. We don't keep a billing
 * event log yet, so this is derived honestly from what we know: when the org was
 * created, and the plan it's on now. (A real ledger is future work.)
 */
export async function getPlanHistory(): Promise<PlanHistoryEntry[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) return [];

	const [org] = await getServiceDb()
		.select({ name: organization.name, createdAt: organization.createdAt })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	if (!org) return [];

	const billing = await getOrgBilling(actor.orgId);
	const entries: PlanHistoryEntry[] = [
		{
			when: org.createdAt.toISOString(),
			title: "Organization created",
			detail: `${org.name} started on the Free plan.`,
			current: false,
		},
	];
	const isLive =
		billing && (billing.status === "active" || billing.status === "trialing");
	if (isLive && billing.plan !== "community") {
		const meta = planMeta(billing.plan);
		const since =
			billing.currentPeriodEnd?.toISOString() ?? new Date().toISOString();
		entries.push({
			when: since,
			title: `On the ${meta.name} plan`,
			detail: meta.tagline,
			current: true,
		});
	} else {
		// No live paid plan → the "created" entry is the current state.
		entries[0].current = true;
	}
	return entries.reverse(); // newest first
}

/** The active org's billing contact + address + VAT id (for Stripe Tax). */
export interface BillingDetails {
	name: string;
	email: string;
	line1: string;
	line2: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	taxId: string | null;
}

/** Reads the active org's billing details, or null if there's no customer yet. */
export async function getBillingDetails(): Promise<BillingDetails | null> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return null;

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	if ("deleted" in customer) return null;
	const addr = customer.address;
	const taxIds = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 1,
	});
	return {
		name: customer.name ?? "",
		email: customer.email ?? "",
		line1: addr?.line1 ?? "",
		line2: addr?.line2 ?? "",
		city: addr?.city ?? "",
		state: addr?.state ?? "",
		postalCode: addr?.postal_code ?? "",
		country: addr?.country ?? "",
		taxId: taxIds.data[0]?.value ?? null,
	};
}

/** Billing contact + address (required for Stripe Tax to compute VAT). */
export interface BillingAddressInput {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	state?: string;
	postalCode: string;
	/** ISO 3166-1 alpha-2 (e.g. "DE", "EE"). */
	country: string;
}

/** Saves the active org's billing name + address on its Stripe customer. */
export async function updateBillingAddress(
	input: BillingAddressInput,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	await getStripe().customers.update(billing.stripeCustomerId, {
		name: input.name,
		address: {
			line1: input.line1,
			line2: input.line2,
			city: input.city,
			state: input.state,
			postal_code: input.postalCode,
			country: input.country,
		},
	});
	return { ok: true };
}

/** Sets (or clears) the active org's tax id — one per customer for our UI. */
export async function saveTaxId(
	type: TaxIdType,
	value: string,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const existing = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 5,
	});
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(billing.stripeCustomerId, t.id);
	}
	const trimmed = value.trim();
	if (trimmed) {
		await stripe.customers.createTaxId(billing.stripeCustomerId, {
			type,
			value: trimmed,
		});
	}
	return { ok: true };
}

/**
 * Opens the Stripe Customer Portal for the active org (manage/cancel the subscription,
 * update payment method). Requires an existing Stripe customer. Returns the URL.
 * Retained as a fallback alongside the embedded flow.
 */
export async function createBillingPortalSession(): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();

	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) {
		throw new Error("No billing account yet — subscribe to a plan first.");
	}
	const session = await getStripe().billingPortal.sessions.create({
		customer: billing.stripeCustomerId,
		return_url: `${getStripeConfig().appUrl}/dashboard/settings/billing`,
	});
	return { url: session.url };
}
