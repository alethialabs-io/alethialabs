// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle overage sweeper (L5): once per billing period, shortly before it ends, post the runner
// minutes a Paddle subscription used beyond its plan's allowance as ONE charge that rides the
// renewal (`effective_from: next_billing_period` — one payment, one invoice).
//
// ONE PASS (`runPaddleOverageSweep`):
//   1. NEW CHARGES. Every Paddle plan subscription whose period (or scheduled cancellation) ends
//      within `OVERAGE_LEAD_MS` and that has no `usage_charge` row for that period yet. Usage is
//      measured from our own ledger first, so a subscription inside its allowance costs no Paddle
//      call. Then the subscription is read from Paddle (its period must match ours — the mirror may
//      lag a renewal — its status must allow a charge, and its currency prices the minutes), a row
//      is CLAIMED, and only the claimant posts. The claim is an INSERT on the ledger's unique key
//      (provider, subscription, period start, sequence 0), so two instances sweeping at once post
//      once: the loser's insert does nothing.
//   2. FINAL CANCELLATION (O9). A subscription scheduled to cancel has no next renewal to ride, so
//      its overage is charged `immediately` when it is at least €5 (OVERAGE_IMMEDIATE_MINIMUM_MINOR)
//      and recorded `waived` when it is less.
//   3. UNCONFIRMED CLAIMS. Paddle has no idempotency key, so a claimed row whose call timed out, hit
//      a network error, a 5xx, or answered something unparseable stays `claimed`: the charge may or
//      may not exist. After `STALE_CLAIM_MS` the row is re-claimed (compare-and-set on `claimed_at`,
//      so one instance does it) and the charge is LOOKED FOR first — the next renewal's preview and
//      the subscription's recent transactions, matched on the row id the charge carries. Found →
//      `reconciled`. Not found → posted again. A lookup that fails re-posts nothing. A row still
//      unconfirmed `UNCONFIRMED_GIVE_UP_MS` after its first claim is marked `failed` and the
//      operator is paged to check Paddle by hand.
//
// A charge Paddle REFUSES (a 4xx) is `failed` and pages the operator, with Paddle's reason. Every
// write after the claim is conditional on the row's status, so a late pass never overwrites a
// settled row.
//
// What it does NOT charge, stated so nobody infers otherwise: minutes of jobs that complete after
// the claim (the last hours of a period — the next period's window starts at its own start, so they
// are never charged twice, and never charged at all); a period whose renewal our mirror missed for
// the whole lead window; a trialing or paused subscription; and the AI slot (it bills AI credits,
// not runner minutes).
//
// Gated by `ALETHIA_PADDLE_OVERAGE_SWEEP=1` (and Paddle being configured); booted from the
// reconcile loop (lib/reconcile/loop.ts) every 15 minutes on every instance. Server-only.

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { money } from "@repo/format";
import { getPaddleConfig, isPaddleConfigured } from "@/lib/billing/paddle/config";
import { paddleClient } from "@/lib/billing/paddle/api";
import {
	type ChargeableSubscription,
	type FoundCharge,
	findPostedCharge,
	getChargeableSubscription,
	isDefiniteRefusal,
	isFinalPeriod,
	measureOverage,
	OVERAGE_IMMEDIATE_MINIMUM_MINOR,
	postPaddleUsageCharge,
	subscriptionCurrency,
} from "@/lib/billing/paddle/overage";
import { entitlementStatus, resolvePlanEntitlements } from "@/lib/billing/plan";
import { alertOperator, type OperatorAlert } from "@/lib/billing/operator-alert";
import type { UsageChargeRequest } from "@/lib/billing/provider/types";
import { getServiceDb } from "@/lib/db";
import { organizationBilling, type UsageCharge, type UsageChargeStatus, usageCharge } from "@/lib/db/schema";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { log } from "@/lib/observability/log";
import { queryJobMinutesByOrg } from "@/lib/queries/runner-usage";

/** The env flag that turns the sweep on. Anything but `1`/`true` leaves it off. */
export const PADDLE_OVERAGE_SWEEP_ENV = "ALETHIA_PADDLE_OVERAGE_SWEEP";

/** How long before a period ends its overage is claimed and posted. */
export const OVERAGE_LEAD_MS = 6 * 60 * 60 * 1000;

/** A claim this old with no settled outcome is reconciled and, if not found, posted again. */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

/** A claim still unconfirmed this long after it was first made is failed and the operator paged. */
export const UNCONFIRMED_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** A past-due subscription is waited on until this close to its period end, then paged. */
export const PAST_DUE_PAGE_MS = 60 * 60 * 1000;

/** At most this many subscriptions, and this many stale claims, per pass. */
export const OVERAGE_SWEEP_BATCH = 100;

/** Whether the sweep is switched on for this instance. */
export function paddleOverageSweepEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	const v = env[PADDLE_OVERAGE_SWEEP_ENV]?.trim().toLowerCase();
	return (v === "1" || v === "true") && isPaddleConfigured(env);
}

/** A Paddle plan subscription whose period ends within the lead window and has no charge row yet. */
export interface OverageCandidate {
	organizationId: string;
	subscriptionId: string;
	plan: BillingPlan;
	status: BillingStatus;
	billingProvider: BillingProviderId | null;
	currentPeriodStart: Date;
	currentPeriodEnd: Date;
	cancelEffectiveAt: Date | null;
}

/** A new ledger row: claimed (to be posted), or settled at once (waived / failed, with a reason). */
export interface NewUsageCharge {
	organizationId: string;
	subscriptionId: string;
	periodStart: Date;
	periodEnd: Date;
	overageMinutes: number;
	amountMinor: number;
	currency: string;
	status: Extract<UsageChargeStatus, "claimed" | "waived" | "failed">;
	error: string | null;
}

/** The database side of the sweep, so a pass is testable without Postgres. */
export interface OverageStore {
	/** Subscriptions due for their period's charge at `now`, with no row for that period yet. */
	candidates(now: Date, leadMs: number, limit: number): Promise<OverageCandidate[]>;
	/** Managed-runner job-minutes the org used in [from, to). */
	usedMinutes(organizationId: string, from: Date, to: Date): Promise<number>;
	/** Inserts the period's row (sequence 0); null when a row for that period already exists. */
	insert(row: NewUsageCharge, now: Date): Promise<UsageCharge | null>;
	/** Claimed rows whose claim is older than `before`, oldest first. */
	staleClaims(before: Date, limit: number): Promise<UsageCharge[]>;
	/** Re-claims a stale row (claimed_at := now) only if it is still claimed and older than `before`. */
	reclaim(id: string, before: Date, now: Date): Promise<boolean>;
	/** Settles a CLAIMED row; false when it was no longer claimed. */
	settle(
		id: string,
		outcome: { status: "posted" | "reconciled" | "failed"; providerRef?: string | null; error?: string | null },
		now: Date,
	): Promise<boolean>;
	/** Marks a POSTED row reconciled once its charge is found. */
	markReconciled(id: string, providerRef: string, now: Date): Promise<void>;
}

/** The Paddle side of the sweep. */
export interface OveragePaddle {
	getSubscription(subscriptionId: string): Promise<ChargeableSubscription>;
	post(charge: UsageChargeRequest): Promise<unknown>;
	find(subscriptionId: string, usageChargeId: string): Promise<FoundCharge | null>;
}

/** Everything a pass reads from its surroundings. */
export interface OverageSweepDeps {
	store: OverageStore;
	paddle: OveragePaddle;
	alert: (alert: OperatorAlert) => Promise<unknown>;
	log: (message: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** What a pass did, for the log line and tests (a `type`, so the reconcile heartbeat can record it). */
export type OverageSweepResult = {
	postedCharges: number;
	reconciledCharges: number;
	waivedCharges: number;
	failedCharges: number;
	/** Claims left for a later pass (outcome unknown). */
	unconfirmedCharges: number;
	/** Candidates passed over this time (inside the allowance, period mismatch, not chargeable yet). */
	skippedSubscriptions: number;
};

/** A short reason from a thrown value — never a secret (PaddleApiError messages carry none). */
function reasonOf(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** The charge request for a row. */
function chargeRequest(row: UsageCharge, immediate: boolean): UsageChargeRequest {
	return {
		usageChargeId: row.id,
		organizationId: row.organizationId,
		subscriptionId: row.subscriptionId,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		overageMinutes: row.overageMinutes,
		amount: money(row.amountMinor, row.currency),
		immediate,
	};
}

/** Pages the operator about one row. */
async function page(deps: OverageSweepDeps, row: Pick<UsageCharge, "id" | "organizationId" | "subscriptionId" | "amountMinor" | "currency" | "overageMinutes">, title: string, reason: string): Promise<void> {
	await deps.alert({
		title,
		subject: { type: "paddle_subscription", id: row.subscriptionId },
		summary: `Usage charge ${row.id} for org ${row.organizationId} (${row.overageMinutes} overage minutes, ${row.amountMinor} ${row.currency.toUpperCase()} minor units): ${reason}`,
	});
}

/**
 * Posts a claimed row's charge and settles it: `posted` (then `reconciled` when the charge is
 * found), `failed` + operator page on a definite refusal, or left `claimed` when the outcome is
 * unknown. Returns which of those happened.
 */
async function postClaimed(
	row: UsageCharge,
	immediate: boolean,
	deps: OverageSweepDeps,
	now: Date,
): Promise<"posted" | "reconciled" | "failed" | "pending"> {
	try {
		await deps.paddle.post(chargeRequest(row, immediate));
	} catch (err) {
		if (isDefiniteRefusal(err)) {
			const reason = reasonOf(err);
			if (await deps.store.settle(row.id, { status: "failed", error: reason }, now)) {
				await page(deps, row, "Paddle refused an overage charge", reason);
			}
			return "failed";
		}
		deps.log("[paddle] overage charge outcome unknown; will reconcile", {
			usage_charge_id: row.id,
			subscription_id: row.subscriptionId,
			reason: reasonOf(err),
		});
		return "pending";
	}
	await deps.store.settle(row.id, { status: "posted" }, now);
	try {
		const found = await deps.paddle.find(row.subscriptionId, row.id);
		if (found) {
			await deps.store.markReconciled(row.id, found.providerRef, now);
			return "reconciled";
		}
	} catch (err) {
		deps.log("[paddle] overage charge posted; lookup failed", { usage_charge_id: row.id, reason: reasonOf(err) });
	}
	return "posted";
}

/** Bumps the tally for an outcome. */
function count(result: OverageSweepResult, outcome: "posted" | "reconciled" | "failed" | "pending"): void {
	if (outcome === "posted") result.postedCharges += 1;
	else if (outcome === "reconciled") result.reconciledCharges += 1;
	else if (outcome === "failed") result.failedCharges += 1;
	else result.unconfirmedCharges += 1;
}

/** Handles one candidate subscription: measure, read Paddle, claim, post. */
async function sweepCandidate(
	c: OverageCandidate,
	deps: OverageSweepDeps,
	now: Date,
	result: OverageSweepResult,
): Promise<void> {
	const end = c.cancelEffectiveAt && c.cancelEffectiveAt < c.currentPeriodEnd ? c.cancelEffectiveAt : c.currentPeriodEnd;
	const to = now < end ? now : end;
	const included = resolvePlanEntitlements(c.plan, entitlementStatus(c, now)).quotas.includedRunnerMinutes;
	const used = await deps.store.usedMinutes(c.organizationId, c.currentPeriodStart, to);
	// Priced in USD only to ask "is anything over?" — the real price waits for the subscription's currency.
	if (measureOverage(used, included, "usd").overageMinutes <= 0) {
		result.skippedSubscriptions += 1;
		return;
	}

	const sub = await deps.paddle.getSubscription(c.subscriptionId);
	const paddleStart = sub.current_billing_period?.starts_at;
	if (!paddleStart || Math.abs(paddleStart.getTime() - c.currentPeriodStart.getTime()) >= 1000) {
		deps.log("[paddle] overage: subscription period differs from the mirror; skipped", {
			subscription_id: c.subscriptionId,
			mirror_start: c.currentPeriodStart.toISOString(),
			paddle_start: paddleStart?.toISOString() ?? null,
		});
		result.skippedSubscriptions += 1;
		return;
	}

	const currency = subscriptionCurrency(sub);
	const base = {
		organizationId: c.organizationId,
		subscriptionId: c.subscriptionId,
		periodStart: c.currentPeriodStart,
		periodEnd: c.currentPeriodEnd,
	};
	if (!currency) {
		const row = await deps.store.insert(
			{ ...base, overageMinutes: measureOverage(used, included, "usd").overageMinutes, amountMinor: 0, currency: sub.currency_code.toLowerCase(), status: "failed", error: `no overage rate for currency ${sub.currency_code}` },
			now,
		);
		if (row) await page(deps, row, "Paddle overage not priced", row.error ?? "no rate");
		if (row) result.failedCharges += 1;
		return;
	}
	const { overageMinutes, amount } = measureOverage(used, included, currency);
	if (amount.minor <= 0) {
		result.skippedSubscriptions += 1;
		return;
	}
	const facts = { ...base, overageMinutes, amountMinor: amount.minor, currency };

	if (sub.status === "past_due") {
		if (end.getTime() - now.getTime() > PAST_DUE_PAGE_MS) {
			result.skippedSubscriptions += 1;
			return;
		}
		const row = await deps.store.insert(
			{ ...facts, status: "failed", error: "subscription past_due at period end: Paddle refuses one-time charges" },
			now,
		);
		if (row) {
			await page(deps, row, "Paddle overage not charged (past due)", row.error ?? "past due");
			result.failedCharges += 1;
		}
		return;
	}
	if (sub.status !== "active") {
		result.skippedSubscriptions += 1;
		return;
	}

	const final = isFinalPeriod(sub);
	if (final && amount.minor < OVERAGE_IMMEDIATE_MINIMUM_MINOR) {
		const row = await deps.store.insert(
			{ ...facts, status: "waived", error: `final cancellation: below the ${OVERAGE_IMMEDIATE_MINIMUM_MINOR} minor-unit minimum (O9)` },
			now,
		);
		if (row) result.waivedCharges += 1;
		return;
	}

	const claimed = await deps.store.insert({ ...facts, status: "claimed", error: null }, now);
	if (!claimed) return; // another instance claimed this period first
	count(result, await postClaimed(claimed, final, deps, now));
}

/** Reconciles one stale claim: find the charge, else post it again, else give up and page. */
async function sweepStaleClaim(row: UsageCharge, deps: OverageSweepDeps, now: Date, result: OverageSweepResult): Promise<void> {
	if (!(await deps.store.reclaim(row.id, new Date(now.getTime() - STALE_CLAIM_MS), now))) return;
	const found = await deps.paddle.find(row.subscriptionId, row.id);
	if (found) {
		if (await deps.store.settle(row.id, { status: "reconciled", providerRef: found.providerRef }, now)) result.reconciledCharges += 1;
		return;
	}
	if (now.getTime() - row.createdAt.getTime() > UNCONFIRMED_GIVE_UP_MS) {
		const reason = "unconfirmed for 24h and not found on the subscription; check Paddle before charging by hand";
		if (await deps.store.settle(row.id, { status: "failed", error: reason }, now)) {
			await page(deps, row, "Paddle overage charge unconfirmed", reason);
			result.failedCharges += 1;
		}
		return;
	}
	const sub = await deps.paddle.getSubscription(row.subscriptionId);
	if (sub.status !== "active") {
		const reason = `subscription is ${sub.status}; the charge was not found and cannot be posted`;
		if (await deps.store.settle(row.id, { status: "failed", error: reason }, now)) {
			await page(deps, row, "Paddle overage charge not posted", reason);
			result.failedCharges += 1;
		}
		return;
	}
	count(result, await postClaimed(row, isFinalPeriod(sub), deps, now));
}

/**
 * One sweep pass (see the header). Each subscription and each stale claim is isolated: a failure
 * on one is logged and the pass moves on; the pass throws at the end if any failed, so the reconcile
 * heartbeat shows it.
 */
export async function runPaddleOverageSweep(now: Date = new Date(), deps: OverageSweepDeps = defaultDeps()): Promise<OverageSweepResult> {
	const result: OverageSweepResult = {
		postedCharges: 0,
		reconciledCharges: 0,
		waivedCharges: 0,
		failedCharges: 0,
		unconfirmedCharges: 0,
		skippedSubscriptions: 0,
	};
	const errors: string[] = [];

	for (const row of await deps.store.staleClaims(new Date(now.getTime() - STALE_CLAIM_MS), OVERAGE_SWEEP_BATCH)) {
		try {
			await sweepStaleClaim(row, deps, now, result);
		} catch (err) {
			errors.push(`claim ${row.id}: ${reasonOf(err)}`);
		}
	}
	for (const c of await deps.store.candidates(now, OVERAGE_LEAD_MS, OVERAGE_SWEEP_BATCH)) {
		try {
			await sweepCandidate(c, deps, now, result);
		} catch (err) {
			errors.push(`subscription ${c.subscriptionId}: ${reasonOf(err)}`);
		}
	}
	if (errors.length > 0) {
		throw new Error(`paddle overage sweep: ${errors.length} failed — ${errors.slice(0, 5).join("; ")}`);
	}
	return result;
}

// ── Postgres store + default wiring ────────────────────────────────────────────────────────────

/** The Postgres store. Service role only — `usage_charge` is written by nothing else. */
export const postgresOverageStore: OverageStore = {
	async candidates(now, leadMs, limit) {
		const horizon = new Date(now.getTime() + leadMs);
		const ob = organizationBilling;
		const rows = await getServiceDb()
			.select({
				organizationId: ob.organizationId,
				subscriptionId: ob.paddleSubscriptionId,
				plan: ob.plan,
				status: ob.status,
				billingProvider: ob.billingProvider,
				currentPeriodStart: ob.currentPeriodStart,
				currentPeriodEnd: ob.currentPeriodEnd,
				cancelEffectiveAt: ob.cancelEffectiveAt,
			})
			.from(ob)
			.where(
				and(
					eq(ob.billingProvider, "paddle"),
					isNotNull(ob.paddleSubscriptionId),
					inArray(ob.status, ["active", "past_due"]),
					isNotNull(ob.currentPeriodStart),
					sql`${ob.currentPeriodEnd} > ${now.toISOString()}::timestamptz`,
					sql`least(${ob.currentPeriodEnd}, coalesce(${ob.cancelEffectiveAt}, ${ob.currentPeriodEnd})) <= ${horizon.toISOString()}::timestamptz`,
					sql`not exists (select 1 from ${usageCharge} uc where uc.provider = 'paddle' and uc.subscription_id = ${ob.paddleSubscriptionId} and uc.period_start = ${ob.currentPeriodStart} and uc.sequence = 0)`,
				),
			)
			.orderBy(ob.currentPeriodEnd)
			.limit(limit);
		const out: OverageCandidate[] = [];
		for (const r of rows) {
			if (!r.subscriptionId || !r.currentPeriodStart || !r.currentPeriodEnd) continue;
			out.push({
				organizationId: r.organizationId,
				subscriptionId: r.subscriptionId,
				plan: r.plan,
				status: r.status,
				billingProvider: r.billingProvider,
				currentPeriodStart: r.currentPeriodStart,
				currentPeriodEnd: r.currentPeriodEnd,
				cancelEffectiveAt: r.cancelEffectiveAt,
			});
		}
		return out;
	},

	async usedMinutes(organizationId, from, to) {
		const rows = await queryJobMinutesByOrg(getServiceDb(), { from, to, orgId: organizationId });
		return Number(rows[0]?.job_minutes ?? 0);
	},

	async insert(row, now) {
		const [inserted] = await getServiceDb()
			.insert(usageCharge)
			.values({
				organizationId: row.organizationId,
				provider: "paddle",
				subscriptionId: row.subscriptionId,
				periodStart: row.periodStart,
				periodEnd: row.periodEnd,
				sequence: 0,
				overageMinutes: row.overageMinutes,
				amountMinor: row.amountMinor,
				currency: row.currency,
				status: row.status,
				error: row.error,
				claimedAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing({
				target: [usageCharge.provider, usageCharge.subscriptionId, usageCharge.periodStart, usageCharge.sequence],
			})
			.returning();
		return inserted ?? null;
	},

	async staleClaims(before, limit) {
		return getServiceDb()
			.select()
			.from(usageCharge)
			.where(and(eq(usageCharge.provider, "paddle"), eq(usageCharge.status, "claimed"), lt(usageCharge.claimedAt, before)))
			.orderBy(usageCharge.claimedAt)
			.limit(limit);
	},

	async reclaim(id, before, now) {
		const rows = await getServiceDb()
			.update(usageCharge)
			.set({ claimedAt: now, updatedAt: now })
			.where(and(eq(usageCharge.id, id), eq(usageCharge.status, "claimed"), lt(usageCharge.claimedAt, before)))
			.returning({ id: usageCharge.id });
		return rows.length > 0;
	},

	async settle(id, outcome, now) {
		const rows = await getServiceDb()
			.update(usageCharge)
			.set({
				status: outcome.status,
				providerRef: outcome.providerRef ?? null,
				error: outcome.error ?? null,
				postedAt: outcome.status === "failed" ? null : now,
				updatedAt: now,
			})
			.where(and(eq(usageCharge.id, id), eq(usageCharge.status, "claimed")))
			.returning({ id: usageCharge.id });
		return rows.length > 0;
	},

	async markReconciled(id, providerRef, now) {
		await getServiceDb()
			.update(usageCharge)
			.set({ status: "reconciled", providerRef, updatedAt: now })
			.where(and(eq(usageCharge.id, id), eq(usageCharge.status, "posted")));
	},
};

/** The production wiring: the Postgres store, the configured Paddle client, the operator alert. */
function defaultDeps(): OverageSweepDeps {
	const config = getPaddleConfig();
	const productId = config.products.runnerMinutes;
	if (!productId) {
		throw new Error(`${PADDLE_OVERAGE_SWEEP_ENV} is on but PADDLE_PRODUCT_RUNNER_MINUTES is not set`);
	}
	const client = paddleClient();
	return {
		store: postgresOverageStore,
		paddle: {
			getSubscription: (id) => getChargeableSubscription(client, id),
			post: (charge) => postPaddleUsageCharge(client, productId, charge),
			find: (subscriptionId, usageChargeId) => findPostedCharge(client, subscriptionId, usageChargeId, productId),
		},
		alert: alertOperator,
		log: (message, fields) => log.warn(message, fields),
	};
}
