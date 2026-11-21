// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Postgres-derived sign-up funnel (REL-L12, #6913).
//
// WHY THIS EXISTS. Product analytics is consent-gated in the browser and `captureServer` is a
// deliberate no-op (lib/analytics/server.ts), so a funnel built from analytics events counts only
// the people who accepted analytics — an unknown fraction of them. Launch-day conversion read that
// way is a number about consent, not about conversion. This funnel is computed from the service's
// own tables instead, so it counts everyone, and nothing leaves the service: no third party is
// involved and `captureServer` stays a no-op.
//
// COUNTS ONLY. The query aggregates in SQL and selects nothing but a stage, a cloud, a day and a
// count. No user, organization, project or job identifier is selected, so none can reach the
// report; `funnelReportSchema` is strict, so a field added to the shape later fails the parse
// rather than riding through, and tests/lib/queries/funnel.test.ts asserts the whole result
// carries no identifier.
//
// WHAT A STAGE COUNTS. Each stage counts the moment a subject reached it FOR THE FIRST TIME, in the
// UTC day it happened. For the per-cloud stages the subject is the (organization, cloud) pair, so an
// organization that connects AWS on Monday and GCP on Friday counts once in each cloud's column. The
// organization is `coalesce(org_id, user_id)`: community rows carry org_id = user_id via trigger,
// and the fallback covers a row written before that trigger existed. A later stage is therefore not
// a subset of an earlier one on the same day — it is the day each step happened, which is what a
// launch-day read needs ("how many people got to a first deploy today").
//
//   signed_up             a `user` row was created
//   organization_created  an `organization` row was created
//   cloud_connected       the first cloud identity of an (org, cloud) that ever verified
//                         (status connected / degraded / disconnected — `disconnected` means it WAS
//                         connected). Dated by the identity's created_at: there is no verified-at
//                         column, and adding one is a migration this unit does not own.
//   project_created       the first project of an (org, cloud); the cloud is the project's cloud
//                         identity's provider, NULL when the project has none (yet)
//   first_deploy          the first DEPLOY job of an (org, cloud) that finished SUCCESS, dated by
//                         completed_at; the cloud is the job's denormalized provider
//   subscribed            the first paid invoice of an organization, dated by paid_at. The invoice
//                         table does not separate the plan subscription from a paid AI tier, so
//                         this is "first money", not "first Pro seat"; an off-Stripe Enterprise org
//                         onboarded through the operator plane has no invoice and is not counted.

import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { getServiceDb } from "@/lib/db";
import { cloudProvider } from "@/lib/db/schema/enums";

type ServiceDb = ReturnType<typeof getServiceDb>;

/** The funnel's stages, in funnel order. */
export const FUNNEL_STAGES = [
	"signed_up",
	"organization_created",
	"cloud_connected",
	"project_created",
	"first_deploy",
	"subscribed",
] as const;

/** One funnel stage. */
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** The widest window the report answers, in days. */
export const FUNNEL_MAX_DAYS = 90;

/** The window the report answers when the caller names none, in days. */
export const FUNNEL_DEFAULT_DAYS = 30;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stage = z.enum(FUNNEL_STAGES);
/** NULL = the stage has no cloud (sign-up, organization, subscription) or the row named none. */
const cloud = z.enum(cloudProvider.enumValues).nullable();
const count = z.number().int().nonnegative();

/** One aggregate row as Postgres returns it; extra columns are stripped, never passed on. */
const funnelRowSchema = z.object({
	stage,
	cloud,
	day,
	count: z.coerce.number().int().nonnegative(),
});

/**
 * The report's shape — strict at every level, so it can hold nothing but days, stages, clouds and
 * counts. A field added here is a decision a reviewer sees; a field added anywhere else fails the
 * parse.
 */
export const funnelReportSchema = z
	.object({
		/** First day in the window (inclusive), UTC. */
		from: day,
		/** Last day in the window (inclusive), UTC. */
		to: day,
		/** Every day in the window, oldest first — the caller does not have to fill gaps. */
		days: z.array(day),
		/** Stage × cloud × day counts; only non-zero cells are listed. */
		cells: z.array(z.object({ day, stage, cloud, count }).strict()),
		/** Stage × cloud counts over the whole window. */
		totals: z.array(z.object({ stage, cloud, count }).strict()),
	})
	.strict();

/** The funnel report: aggregate counts only. */
export type FunnelReport = z.infer<typeof funnelReportSchema>;

/** One stage × cloud × day count. */
export type FunnelCell = FunnelReport["cells"][number];

/**
 * Binds a Date as a timestamptz parameter. drizzle's raw `sql` template does not serialize a JS
 * Date through the postgres-js driver, so the ISO string goes over the wire with an explicit cast
 * (the same helper as lib/queries/runner-usage.ts).
 */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** Formats a Date as its UTC calendar day, `YYYY-MM-DD`. */
function utcDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** The UTC midnight that starts the day `d` falls in. */
function startOfUtcDay(d: Date): Date {
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const DAY_MS = 86_400_000;

/**
 * The window a report covers: the last `days` UTC days ending with (and including) the day `now`
 * falls in, as a half-open `[start, end)` instant range plus the inclusive day list. `days` is
 * clamped to 1..{@link FUNNEL_MAX_DAYS}; a non-integer is floored.
 */
export function funnelWindow(
	now: Date,
	days: number,
): { start: Date; end: Date; days: string[] } {
	const requested = Number.isFinite(days) ? Math.floor(days) : FUNNEL_DEFAULT_DAYS;
	const n = Math.min(FUNNEL_MAX_DAYS, Math.max(1, requested));
	const end = new Date(startOfUtcDay(now).getTime() + DAY_MS);
	const start = new Date(end.getTime() - n * DAY_MS);
	const list: string[] = [];
	for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) list.push(utcDay(new Date(t)));
	return { start, end, days: list };
}

/**
 * The one aggregate query. Each CTE yields `(stage, cloud, at)` — one row per first-time event,
 * never an identifier — and the outer select buckets them by UTC day inside `[start, end)`. The
 * per-subject `min()` runs over all time, so an organization that connected a cloud last month and
 * another identity of the same cloud today is counted last month, not today.
 */
function funnelSql(start: Date, end: Date): SQL {
	return sql`
		with events as (
			select 'signed_up'::text as stage, null::text as cloud, u.created_at as at
			from public."user" u
			where u.created_at >= ${ts(start)} and u.created_at < ${ts(end)}

			union all
			select 'organization_created', null, o.created_at
			from public.organization o
			where o.created_at >= ${ts(start)} and o.created_at < ${ts(end)}

			union all
			select 'cloud_connected', ci.provider::text, min(ci.created_at)
			from public.cloud_identities ci
			where ci.status in ('connected', 'degraded', 'disconnected')
			group by coalesce(ci.org_id, ci.user_id), ci.provider

			union all
			select 'project_created', ci.provider::text, min(p.created_at)
			from public.projects p
			left join public.cloud_identities ci on ci.id = p.cloud_identity_id
			group by coalesce(p.org_id, p.user_id), ci.provider

			union all
			select 'first_deploy', j.provider::text, min(j.completed_at)
			from public.jobs j
			where j.job_type = 'DEPLOY' and j.status = 'SUCCESS' and j.completed_at is not null
			group by coalesce(j.org_id, j.user_id), j.provider

			union all
			select 'subscribed', null, min(i.paid_at)
			from public.invoice i
			where i.paid_at is not null
			group by i.organization_id
		)
		select
			e.stage,
			e.cloud,
			to_char(e.at at time zone 'UTC', 'YYYY-MM-DD') as day,
			count(*)::int as count
		from events e
		where e.at >= ${ts(start)} and e.at < ${ts(end)}
		group by 1, 2, 3
		order by 3, 1, 2
	`;
}

/**
 * Builds the report from aggregate rows: validates each row, drops anything outside the window's
 * days, and sums the per-window totals. Pure — the query's half is {@link queryFunnel}. Cells and
 * totals are ordered by day, then funnel stage, then cloud (NULL first), so the output is stable.
 */
export function shapeFunnel(rows: readonly unknown[], days: readonly string[]): FunnelReport {
	const inWindow = new Set(days);
	const stageOrder = new Map<string, number>(FUNNEL_STAGES.map((s, i) => [s, i]));
	type Keyed = { stage: FunnelStage; cloud: string | null };
	/** Funnel order first, then cloud with NULL (no cloud) ahead of every named one. */
	const byStageCloud = (a: Keyed, b: Keyed): number =>
		(stageOrder.get(a.stage) ?? 0) - (stageOrder.get(b.stage) ?? 0) ||
		(a.cloud ?? "").localeCompare(b.cloud ?? "");

	const cellMap = new Map<string, FunnelCell>();
	for (const raw of rows) {
		const r = funnelRowSchema.parse(raw);
		if (!inWindow.has(r.day) || r.count === 0) continue;
		const key = `${r.day}|${r.stage}|${r.cloud ?? ""}`;
		const prev = cellMap.get(key);
		cellMap.set(key, {
			day: r.day,
			stage: r.stage,
			cloud: r.cloud,
			count: (prev?.count ?? 0) + r.count,
		});
	}
	const cells = [...cellMap.values()].sort(
		(a, b) => a.day.localeCompare(b.day) || byStageCloud(a, b),
	);

	const totalMap = new Map<string, FunnelReport["totals"][number]>();
	for (const c of cells) {
		const key = `${c.stage}|${c.cloud ?? ""}`;
		const prev = totalMap.get(key);
		totalMap.set(key, { stage: c.stage, cloud: c.cloud, count: (prev?.count ?? 0) + c.count });
	}
	const totals = [...totalMap.values()].sort(byStageCloud);

	return funnelReportSchema.parse({
		from: days[0] ?? "",
		to: days[days.length - 1] ?? "",
		days: [...days],
		cells,
		totals,
	});
}

/**
 * The funnel over the last `days` UTC days (default {@link FUNNEL_DEFAULT_DAYS}, at most
 * {@link FUNNEL_MAX_DAYS}), counting each stage per day and per cloud. Service path: it reads
 * across every tenant, so it must only ever be reached from a platform-internal caller (the staff
 * app's `/funnel` page, through `/api/internal/platform/funnel`).
 */
export async function queryFunnel(
	db: ServiceDb,
	opts: { now?: Date; days?: number } = {},
): Promise<FunnelReport> {
	const window = funnelWindow(opts.now ?? new Date(), opts.days ?? FUNNEL_DEFAULT_DAYS);
	const rows = await db.execute(funnelSql(window.start, window.end));
	return shapeFunnel(rows, window.days);
}
