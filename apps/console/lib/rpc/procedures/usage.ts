// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { presetRange } from "@repo/ui/range";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionRefusal } from "@/lib/actions/result";
import { authorizeQuiet, authorizeRead, currentActor } from "@/lib/authz/guard";
import {
	aiCreditsSeries,
	aiCreditsSeriesByProject,
	oldestUsageSince,
	purchasedBalance,
	sumCredits,
	sumCreditsByProject,
} from "@/lib/billing/ai-quota";
import {
	AI_SESSION_WINDOW_MS,
	type AiPlanContext,
	type AiTier,
	aiTierSpec,
	effectiveAiTierSpec,
	resolveAiPlan,
} from "@/lib/billing/ai-plan";
import { aiPaidTiersEnabled } from "@/lib/billing/config";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";
import { computeUsage, type UsageSummary } from "@/lib/billing/usage";
import { getServiceDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import type { BillingPlan } from "@/lib/db/schema/enums";
import {
	queryJobMinutesByOrg,
	queryJobMinutesByProject,
	queryJobMinutesSeries,
	queryJobMinutesSeriesByProject,
} from "@/lib/queries/runner-usage";
import {
	type ProjectResourceCounts,
	queryProjectResourceCounts,
	queryProjectRunningJobs,
	queryResourceCounts,
	queryRunningJobs,
	type ResourceCounts,
} from "@/lib/queries/usage-counts";
import { query } from "@/lib/rpc/base";
import { jobsRangeInput } from "@/lib/rpc/inputs/jobs";

// The usage domain's reads (#6127, ADR 0005 D1): the org Usage page, the project Usage page and the
// AI section both billing and usage render. The bodies MOVED here from `app/server/actions/billing.ts`
// and `app/server/actions/project-usage.ts`; they are plain functions so other server code (the AI
// read tools, the CLI routes, the overview's usage read) calls them in-process.

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The personal scope has no organization to meter (ADR 0005 §7 Q2): an org-only read refuses there
 * with a plan-gated refusal rather than answering zeros, which a page would render as "you used
 * nothing" — a fact about an organization that does not exist.
 */
function refusePersonalScope(): never {
	throw new ActionRefusal(
		"entitlement",
		"Usage is metered per organization. Create one to track it.",
		"organization",
	);
}

// ── The metering window ───────────────────────────────────────────────────────────────────────────

/**
 * When the metering window that started at `from` ends: the paid period's own end when the org has
 * one, else ONE MONTHLY CYCLE after its start — the window `effectiveBillingPeriodStart` opened
 * (the calendar month, or a monthly cycle anchored on an open-ended grant's start day).
 *
 * The cycle's day is the ANCHOR's (`anchor` — the grant's start), clamped to the end month's
 * length — not the window start's, which may itself already be clamped: a grant anchored on the
 * 31st opens a February window on the 28th, and that window ends on March 31, not March 28.
 *
 * It used to fall back to "now", so an org with no paid period was told its period ran "to today"
 * and the value moved on every read — two reads a millisecond apart disagreed (#6209 review).
 */
function periodEndFor(
	paidEnd: Date | null | undefined,
	from: Date,
	anchor: Date | null | undefined,
): Date {
	if (paidEnd) return paidEnd;
	const day = (anchor ?? from).getUTCDate();
	const year = from.getUTCFullYear();
	const month = from.getUTCMonth() + 1;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(
		Date.UTC(
			year,
			month,
			Math.min(day, lastDay),
			from.getUTCHours(),
			from.getUTCMinutes(),
			from.getUTCSeconds(),
			from.getUTCMilliseconds(),
		),
	);
}

// ── Org usage this period ─────────────────────────────────────────────────────────────────────────

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
		periodEnd: periodEndFor(billing?.currentPeriodEnd, from, billing?.currentPeriodStart).toISOString(),
		plan,
		hardCap: billing?.usageHardCap ?? false,
		runningJobs,
		maxConcurrentJobs: quotas.maxConcurrentJobs,
	};
}

// ── Resource counts ───────────────────────────────────────────────────────────────────────────────

/** Point-in-time resource counts for the active org's Usage page (read-only; any member). */
export type ResourceCountsReport = ResourceCounts;

/** Projects / clusters counts + estimated spend under management for the active org. */
export async function getResourceCounts(): Promise<ResourceCountsReport> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) refusePersonalScope();
	return queryResourceCounts(actor.orgId);
}

// ── Usage over time ───────────────────────────────────────────────────────────────────────────────

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

/** A concrete window, after a preset was resolved. */
interface Window {
	from: Date;
	to: Date;
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

/** An empty window — an inverted or invalid range has nothing in it. */
const EMPTY_OVER_TIME: UsageOverTime = {
	series: [],
	totals: { runnerMinutes: 0, jobs: 0, aiCredits: 0 },
};

/** Day-buckets minute rows and AI rows onto a continuous, zero-filled axis, and totals it. */
function bucket(
	window: Window,
	minuteRows: ReadonlyArray<{ day: string; job_minutes: number; job_count: number }>,
	aiRows: ReadonlyArray<{ day: string; credits: number }>,
): UsageOverTime {
	const minuteByDay = new Map(minuteRows.map((r) => [r.day, r]));
	const aiByDay = new Map(aiRows.map((r) => [r.day, r.credits]));
	const series: UsagePoint[] = utcDayKeys(window.from, window.to).map((date) => {
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
 * Cumulative usage over a window for the active org — runner-minutes, jobs, and AI credits,
 * day-bucketed onto a continuous axis (empty days are zero-filled). Managed-runner basis only,
 * matching {@link getOrgUsage}. Refuses the personal scope (there is no organization to meter).
 */
export async function getUsageOverTime(window: Window): Promise<UsageOverTime> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) refusePersonalScope();
	const { from, to } = window;
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
		return EMPTY_OVER_TIME;
	}
	const [minuteRows, aiRows] = await Promise.all([
		queryJobMinutesSeries(getServiceDb(), { from, to, orgId: actor.orgId }),
		aiCreditsSeries(actor.orgId, from, to),
	]);
	return bucket(window, minuteRows, aiRows);
}

// ── AI standing ───────────────────────────────────────────────────────────────────────────────────

/**
 * The active org's STANDALONE AI standing — rolling 5-hour session + fixed weekly included
 * spend vs the AI tier's caps (the % denominators), on the SAME windows the guard
 * (ai-guard.ts) enforces, plus the remaining purchased top-up balance and the tier.
 * Read-only; any member. The single canonical AI-usage read (drives the overview card,
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

/** Resolves the active org's AI standing (see {@link AiUsageSummary}). */
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

// ── Project usage ─────────────────────────────────────────────────────────────────────────────────
// The per-project analogue of the org reads above. Every read takes a `projectId` (resolved from
// the URL slug by the page) and is tenant-guarded: the project must belong to the actor's org AND
// the actor must be allowed to `view` it. Only what is genuinely scopeable per project is here —
// job counts, managed runner job-minutes, clusters, the project's estimated cloud cost, and AI
// credits attributed via ref_id. Seats, plan caps and provisioned-runner hours stay org-wide.

/**
 * Verifies `projectId` belongs to the actor's org and the actor may view it, and returns the
 * actor. The service role bypasses RLS, so the org cross-check is the tenancy wall for every
 * project-scoped read below (`projects.org_id` equals `user_id` in the personal scope, so this
 * holds there too). A missing OR foreign project is a 404 (it also hides existence from other
 * tenants); a project of this org the actor may not view is a FORBIDDEN refusal.
 */
async function assertProjectInScope(projectId: string) {
	const actor = await currentActor();
	const [row] = await getServiceDb()
		.select({ orgId: projects.org_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!row || row.orgId !== actor.orgId) notFound();
	await authorizeRead("view", { type: "project", id: projectId });
	return actor;
}

/**
 * Resolves the current billing period [start, now) for the actor's org — the same window
 * {@link getOrgUsage} meters against, so the project meter lines up with the org one. Falls
 * back to the calendar month start when there's no billing row (community / self-managed).
 */
async function currentPeriod(
	orgId: string,
): Promise<{ from: Date; to: Date; periodEnd: Date }> {
	const billing = await getOrgBilling(orgId).catch(() => null);
	const now = new Date();
	const from = effectiveBillingPeriodStart(
		billing?.currentPeriodStart,
		billing?.currentPeriodEnd,
		now,
	);
	return { from, to: now, periodEnd: periodEndFor(billing?.currentPeriodEnd, from, billing?.currentPeriodStart) };
}

/** Managed runner job-minutes + concurrency for a project this billing period. */
export interface ProjectUsageReport {
	/** Managed-runner job-minutes this period (self-operated runners never count). */
	jobMinutes: number;
	/** Jobs that ran (completed) on a managed runner this period. */
	jobCount: number;
	/** Jobs currently in flight for this project (CLAIMED/PROCESSING). */
	runningJobs: number;
	periodStart: string;
	periodEnd: string;
}

/** Job-minutes a project consumed on managed runners this billing period, plus jobs in flight. */
async function getProjectUsage(projectId: string): Promise<ProjectUsageReport> {
	const actor = await assertProjectInScope(projectId);
	const { from, to, periodEnd } = await currentPeriod(actor.orgId);
	const [minutes, runningJobs] = await Promise.all([
		queryJobMinutesByProject(getServiceDb(), { from, to, projectId }),
		queryProjectRunningJobs(projectId),
	]);
	return {
		jobMinutes: minutes.job_minutes,
		jobCount: minutes.job_count,
		runningJobs,
		periodStart: from.toISOString(),
		periodEnd: periodEnd.toISOString(),
	};
}

/** Clusters + estimated cloud cost for one project's Usage view. */
export type ProjectResourceCountsReport = ProjectResourceCounts;

/** Cluster count + estimated monthly cloud cost for a project. */
async function getProjectResourceCounts(
	projectId: string,
): Promise<ProjectResourceCountsReport> {
	await assertProjectInScope(projectId);
	return queryProjectResourceCounts(projectId);
}

/**
 * Cumulative usage over a window for one project — managed runner-minutes, jobs, and AI credits,
 * day-bucketed onto a continuous axis (empty days zero-filled). Mirrors {@link getUsageOverTime}
 * but scoped by `project_id` (and AI credits by ref_id attribution).
 */
async function getProjectUsageOverTime(
	projectId: string,
	window: Window,
): Promise<UsageOverTime> {
	await assertProjectInScope(projectId);
	const { from, to } = window;
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
		return EMPTY_OVER_TIME;
	}
	const [minuteRows, aiRows] = await Promise.all([
		queryJobMinutesSeriesByProject(getServiceDb(), { from, to, projectId }),
		aiCreditsSeriesByProject(projectId, from, to),
	]);
	return bucket(window, minuteRows, aiRows);
}

/** AI credits attributed to a project this billing period (best-effort via ref_id). */
export interface ProjectAiUsage {
	/** Included + purchased credits attributed to this project this period. */
	creditsThisPeriod: number;
	periodStart: string;
	periodEnd: string;
}

/**
 * AI credits attributable to a project this billing period — included + purchased, best-effort
 * via `ref_id` (scan→jobs.project_id, agent→agent_threads.project_id). Rows matching neither
 * (support Ask-AI, legacy NULL ref_id) are excluded, so this is a lower bound; the Usage page
 * carries a coverage footnote.
 */
async function getProjectAiUsage(projectId: string): Promise<ProjectAiUsage> {
	const actor = await assertProjectInScope(projectId);
	const { from, periodEnd } = await currentPeriod(actor.orgId);
	const [included, purchased] = await Promise.all([
		sumCreditsByProject(projectId, "included", from),
		sumCreditsByProject(projectId, "purchased", from),
	]);
	return {
		creditsThisPeriod: included + purchased,
		periodStart: from.toISOString(),
		periodEnd: periodEnd.toISOString(),
	};
}

// ── Inputs + router ───────────────────────────────────────────────────────────────────────────────

/**
 * The over-time window: a quick-range PRESET (resolved here, at read time) or explicit ISO bounds
 * from the date picker — the jobs page's range input, so a preset key is identical on the server's
 * prefetch and the browser's first read (ADR 0005 §10).
 */
const overTimeInput = z.object({ range: jobsRangeInput });
const projectInput = z.object({ projectId: z.uuid() });
const projectOverTimeInput = z.object({ projectId: z.uuid(), range: jobsRangeInput });

/** The over-time window as the pages send it. */
type UsageRange = z.infer<typeof jobsRangeInput>;

/** Resolves a wire range to concrete bounds; a preset means "the window ending now". */
function resolveUsageRange(range: UsageRange, now: Date = new Date()): Window {
	if ("preset" in range) return presetRange(range.preset, now);
	return { from: new Date(range.from), to: new Date(range.to) };
}

/**
 * The usage domain's read procedures (ADR 0005 D1). The overview's usage card reads
 * `overview.usage` (#6118), which calls {@link getOrgUsage} and {@link getAiUsageSummary} from here
 * in-process.
 */
export const usageRouter = {
	org: query.handler(() => getOrgUsage()),
	resources: query.handler(() => getResourceCounts()),
	overTime: query
		.input(overTimeInput)
		.handler(({ input }) => getUsageOverTime(resolveUsageRange(input.range))),
	ai: query.handler(() => getAiUsageSummary()),
	project: query.input(projectInput).handler(({ input }) => getProjectUsage(input.projectId)),
	projectResources: query
		.input(projectInput)
		.handler(({ input }) => getProjectResourceCounts(input.projectId)),
	projectAi: query.input(projectInput).handler(({ input }) => getProjectAiUsage(input.projectId)),
	projectOverTime: query
		.input(projectOverTimeInput)
		.handler(({ input }) =>
			getProjectUsageOverTime(input.projectId, resolveUsageRange(input.range)),
		),
};
