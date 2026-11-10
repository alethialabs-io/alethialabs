// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { count, desc, eq } from "drizzle-orm";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import {
	getAiUsageSummary,
	getCollaborationAccess,
	getOrgUsage,
} from "@/app/server/actions/billing";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { getServiceDb } from "@/lib/db";
import { alertDeliveries, member } from "@/lib/db/schema";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { toDeliveryDTO } from "@/lib/queries/alerts-lists";
import { query } from "@/lib/rpc/base";

/** How many deliveries the overview's Alerts card lists. */
export const OVERVIEW_ALERT_ROWS = 4;

/**
 * Everything the overview's Usage card shows, and the one plan capability the overview's Create
 * menu needs (`canInvite`). Only the fields the overview renders travel — not the billing
 * summary's Stripe price, seats or lifecycle state.
 */
export interface OverviewUsage {
	/** Stripe is wired on this deployment (hosted). Self-managed shows no plan CTA. */
	hosted: boolean;
	plan: BillingPlan;
	/** Members occupying a seat; 0 in the personal scope. */
	memberCount: number;
	/** Whether this org may invite members (the Create menu's "Org member" item). */
	canInvite: boolean;
	/** Runner minutes over the CURRENT BILLING PERIOD — `periodStart` is that window's start (ISO). */
	runner: { usedMinutes: number; includedMinutes: number; periodStart: string };
	/** Jobs in flight vs the plan's concurrency cap (`max` null = unlimited). */
	concurrency: { running: number; max: number | null };
	/** The AI windows: the rolling 5-hour session and the fixed week. */
	ai: {
		enabled: boolean;
		sessionUsed: number;
		sessionBudget: number;
		sessionResetAt: string | null;
		weeklyUsed: number;
		weeklyBudget: number;
		weeklyResetAt: string;
	};
}

/** Members occupying a seat in the actor's org; 0 in the personal scope, which has no members. */
async function readSeatCount(actor: Actor): Promise<number> {
	if (actor.orgId === actor.userId) return 0;
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(member)
		.where(eq(member.organizationId, actor.orgId));
	return row?.n ?? 0;
}

/**
 * The overview's usage read: the org's metered consumption, its plan, and its seat count.
 *
 * The three usage readers are the billing domain's, called IN-PROCESS — a plain function call, not
 * a server-action POST — as `workspace.*` does (#6114). Moving their bodies out of the billing
 * action module is #6127's (ADR 0005 stress test R10): that module is its scope, and the usage and
 * billing pages read the same functions. Each resolves its actor with `currentActor()`, which the
 * `query` base binds to the actor this procedure was given — resolved from the ADDRESS, never from
 * the session's org.
 *
 * THE PLAN IS READ HERE, FROM THE BILLING ROW, AND A FAILED READ FAILS THE CARD. `getOrgUsage`
 * reads the same row but swallows a failure into `null`, i.e. into the community plan, the
 * community allowance and a month-start window — an error rendered as data, showing a paid org an
 * Upgrade button (RUBRIC B4). So the plan does not come from there: `getOrgBilling` is read
 * without a catch, and if `getOrgUsage`'s own read of that row fell back (its plan disagrees with
 * the row's), the whole read fails rather than render the fallback's allowance and window.
 *
 * Not through `getBillingSummary`, which the card used to call: that reader retrieves the Stripe
 * subscription (and, on a paid plan, the plan's live price) for the billing page's plan card, and
 * the overview shows neither.
 */
export async function readOverviewUsage(actor: Actor): Promise<OverviewUsage> {
	const [billing, usage, ai, collaboration, memberCount] = await Promise.all([
		getOrgBilling(actor.orgId),
		getOrgUsage(),
		getAiUsageSummary(),
		getCollaborationAccess(),
		readSeatCount(actor),
	]);
	const plan = billing?.plan ?? "community";
	if (usage.plan !== plan) {
		throw new Error("The usage read fell back from the org's billing row; refusing to render the fallback.");
	}
	return {
		hosted: isStripeConfigured(),
		plan,
		memberCount,
		canInvite: collaboration.canInvite,
		runner: {
			usedMinutes: usage.usedMinutes,
			includedMinutes: usage.includedMinutes,
			periodStart: usage.periodStart,
		},
		concurrency: { running: usage.runningJobs, max: usage.maxConcurrentJobs },
		ai: {
			enabled: ai.enabled,
			sessionUsed: ai.sessionUsed,
			sessionBudget: ai.sessionBudget,
			sessionResetAt: ai.sessionResetAt,
			weeklyUsed: ai.weeklyUsed,
			weeklyBudget: ai.weeklyBudget,
			weeklyResetAt: ai.weeklyResetAt,
		},
	};
}

/** The overview's Alerts card: whether the plan includes alerting, and the newest deliveries. */
export interface OverviewAlerts {
	/** The plan includes alerting. When false the card shows the plan gate, not the rows. */
	alerting: boolean;
	/** The newest {@link OVERVIEW_ALERT_ROWS} deliveries in the org's ledger. */
	deliveries: DeliveryDTO[];
}

/**
 * The overview's alerts read — the newest few deliveries, not the Alerts page's whole bootstrap
 * (channels, policies, condition options), which the card never showed, and not the Alerts page's
 * filtered ledger either, whose facet pass the card has no use for.
 *
 * A reader without `view_alerts` is refused (`FORBIDDEN` on the wire), and the card renders that
 * as its own state. The PLAN gate is data (`alerting`), not a refusal: a refused read is not
 * dehydrated into the first paint, so a typed refusal here would make every org without alerting —
 * the default plan — fetch again in the browser on every visit. A plan without alerting gets no
 * rows: the card shows the gate, so they would travel for nothing.
 */
export async function readOverviewAlerts(): Promise<OverviewAlerts> {
	const actor = await authorize("view_alerts", { type: "alert" });
	if (!getEntitlements(actor).alerting) return { alerting: false, deliveries: [] };
	const rows = await getServiceDb()
		.select()
		.from(alertDeliveries)
		.where(eq(alertDeliveries.org_id, actor.orgId))
		.orderBy(desc(alertDeliveries.created_at))
		.limit(OVERVIEW_ALERT_ROWS);
	return { alerting: true, deliveries: rows.map(toDeliveryDTO) };
}

/**
 * The overview domain's reads (ADR 0005 D1, #6118). The page prefetches each through
 * `serverOrpc()` and each card reads its own, so one failing read takes down one card (RUBRIC B5).
 * There is no recent-jobs read here: the Recent-jobs card reads the shell's job feed
 * (`workspace.recentJobs`, #6114), which the `[org]` layout already prefetches.
 */
export const overviewRouter = {
	usage: query.handler(({ context }) => readOverviewUsage(context.actor)),
	alerts: query.handler(() => readOverviewAlerts()),
};
