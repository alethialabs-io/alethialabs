// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type SQL, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";

type ServiceDb = ReturnType<typeof getServiceDb>;

/**
 * Binds a Date as a timestamptz parameter. drizzle's raw `sql` template doesn't serialize a
 * JS Date through the postgres-js driver (it reaches the wire as an unparameterised Date and
 * throws), so we pass the ISO string with an explicit cast. Use for every Date in a raw query.
 */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/**
 * Provisioned-usage rollup for one managed runner over a billing window.
 * Declared as a `type` so it carries an implicit index signature and stays
 * assignable to `Record<string, unknown>` for `db.execute`.
 */
export type ProvisionedHoursRow = {
	runner_id: string;
	org_id: string | null;
	provisioned_seconds: number;
	provisioned_hours: number;
	open_sessions: number;
};

/** Window + scope for {@link queryProvisionedHours} (all AND-combined). */
interface ProvisionedHoursFilters {
	/** Window start (inclusive). */
	from: Date;
	/** Window end (exclusive); still-open sessions are billed up to here. */
	to: Date;
	runnerId?: string;
	orgId?: string;
}

/**
 * Sums provisioned seconds per managed runner over [from, to) from the
 * `runner_usage_sessions` ledger. Each session is clamped to the window
 * (greatest(started_at, from) .. least(coalesce(ended_at, to), to)), so
 * scale-to-zero ONLINE/OFFLINE cycles and boundary-spanning sessions are summed
 * correctly and open sessions are billed up to `to`. Service path only (platform
 * billing data — the ledger is RLS-denied to the app role).
 */
export async function queryProvisionedHours(
	db: ServiceDb,
	filters: ProvisionedHoursFilters,
): Promise<ProvisionedHoursRow[]> {
	const conds: SQL[] = [
		sql`s.operator = 'managed'`,
		sql`s.started_at < ${ts(filters.to)}`,
		sql`coalesce(s.ended_at, ${ts(filters.to)}) > ${ts(filters.from)}`,
	];
	if (filters.runnerId !== undefined)
		conds.push(sql`s.runner_id = ${filters.runnerId}`);
	if (filters.orgId !== undefined) conds.push(sql`s.org_id = ${filters.orgId}`);

	// Clamped per-session duration, reused for the seconds sum and the hours sum.
	const clamped = sql`extract(epoch from (
		least(coalesce(s.ended_at, ${ts(filters.to)}), ${ts(filters.to)})
		- greatest(s.started_at, ${ts(filters.from)})
	))`;

	return db.execute<ProvisionedHoursRow>(sql`
		select
			s.runner_id,
			s.org_id,
			sum(${clamped})::bigint as provisioned_seconds,
			(sum(${clamped}) / 3600.0)::float8 as provisioned_hours,
			count(*) filter (where s.ended_at is null)::int as open_sessions
		from public.runner_usage_sessions s
		where ${sql.join(conds, sql` and `)}
		group by s.runner_id, s.org_id
		order by provisioned_seconds desc
	`);
}

/**
 * Idle managed runners serving a provider that carry a cloud instance id — the
 * scale-down candidates for a cloud `FleetProvider` (no in-flight CLAIMED/PROCESSING
 * job, so deleting their VM is safe). Service path.
 */
export type IdleRunnerRow = { runner_id: string; instance_id: string };

export async function idleManagedRunnersForProvider(
	db: ServiceDb,
	provider: string,
): Promise<IdleRunnerRow[]> {
	return db.execute<IdleRunnerRow>(sql`
		select r.id as runner_id, r.metadata->>'cloud_instance_id' as instance_id
		from public.runners r
		where r.operator = 'managed' and r.status = 'ONLINE'
		  and r.metadata->>'cloud_instance_id' is not null
		  and (r.supported_providers is null or ${provider}::cloud_provider = any(r.supported_providers))
		  and not exists (
		    select 1 from public.jobs j
		    where j.runner_id = r.id and j.status in ('CLAIMED', 'PROCESSING')
		  )
	`);
}

/** Provisioned-hours rolled up per cloud provider — the per-pool COGS input for the Fleet
 *  economics view. Managed runners are per-cloud, so a runner's provider is its first
 *  `supported_providers` entry (NULL → "any", surfaced only in totals). Same clamped-session
 *  sum as {@link queryProvisionedHours}. Service path. */
export type ProvisionedHoursByProviderRow = {
	provider: string;
	provisioned_hours: number;
	runner_count: number;
};

export async function provisionedHoursByProvider(
	db: ServiceDb,
	filters: { from: Date; to: Date },
): Promise<ProvisionedHoursByProviderRow[]> {
	const clamped = sql`extract(epoch from (
		least(coalesce(s.ended_at, ${ts(filters.to)}), ${ts(filters.to)})
		- greatest(s.started_at, ${ts(filters.from)})
	))`;
	return db.execute<ProvisionedHoursByProviderRow>(sql`
		select
			coalesce(r.supported_providers[1]::text, 'any') as provider,
			(sum(${clamped}) / 3600.0)::float8 as provisioned_hours,
			count(distinct s.runner_id)::int as runner_count
		from public.runner_usage_sessions s
		join public.runners r on r.id = s.runner_id
		where s.operator = 'managed'
		  and s.started_at < ${ts(filters.to)}
		  and coalesce(s.ended_at, ${ts(filters.to)}) > ${ts(filters.from)}
		group by 1
		order by provisioned_hours desc
	`);
}

/** Job-minutes rolled up per cloud provider — the per-pool utilization numerator. Like
 *  {@link queryJobMinutesByOrg} but grouped by the job's target provider (NULL lifecycle
 *  jobs → "any"). Service path. */
export type JobMinutesByProviderRow = {
	provider: string;
	job_minutes: number;
	job_count: number;
};

export async function jobMinutesByProvider(
	db: ServiceDb,
	filters: { from: Date; to: Date },
): Promise<JobMinutesByProviderRow[]> {
	const minutes = sql`extract(epoch from (j.completed_at - j.started_at)) / 60.0`;
	return db.execute<JobMinutesByProviderRow>(sql`
		select
			coalesce(j.provider::text, 'any') as provider,
			coalesce(sum(greatest(${minutes}, 0)), 0)::float8 as job_minutes,
			count(*)::int as job_count
		from public.jobs j
		join public.runners r on r.id = j.runner_id
		where r.operator = 'managed'
		  and j.started_at is not null
		  and j.completed_at is not null
		  and j.completed_at >= ${ts(filters.from)}
		  and j.completed_at < ${ts(filters.to)}
		group by 1
		order by job_minutes desc
	`);
}

/**
 * Per-org **job-minutes** rollup — the customer-facing billable unit (ADR 20 §5):
 * the wall-clock execution time of jobs that ran on a **managed** runner, summed
 * per org over [from, to) by completion time. This is the value-aligned meter
 * (self-operated runners never count); provisioned-hours above is our internal COGS.
 */
export type JobMinutesRow = {
	org_id: string | null;
	job_minutes: number;
	job_count: number;
};

/**
 * Day-bucketed job-minutes for one org over [from, to) — the time-series behind the
 * Usage page's "over time" chart. Same managed-only, completed-jobs basis as
 * {@link queryJobMinutesByOrg}, grouped by `completed_at`'s day. Only days with
 * activity are returned; the caller fills the gaps to a continuous axis. Service path.
 */
export type JobMinutesDayRow = {
	day: string;
	job_minutes: number;
	job_count: number;
};

export async function queryJobMinutesSeries(
	db: ServiceDb,
	filters: { from: Date; to: Date; orgId: string },
): Promise<JobMinutesDayRow[]> {
	const minutes = sql`extract(epoch from (j.completed_at - j.started_at)) / 60.0`;
	return db.execute<JobMinutesDayRow>(sql`
		select
			to_char(date_trunc('day', j.completed_at), 'YYYY-MM-DD') as day,
			coalesce(sum(greatest(${minutes}, 0)), 0)::float8 as job_minutes,
			count(*)::int as job_count
		from public.jobs j
		join public.runners r on r.id = j.runner_id
		where r.operator = 'managed'
		  and j.started_at is not null
		  and j.completed_at is not null
		  and j.completed_at >= ${ts(filters.from)}
		  and j.completed_at < ${ts(filters.to)}
		  and j.org_id = ${filters.orgId}
		group by 1
		order by 1
	`);
}

export async function queryJobMinutesByOrg(
	db: ServiceDb,
	filters: { from: Date; to: Date; orgId?: string },
): Promise<JobMinutesRow[]> {
	const conds: SQL[] = [
		sql`r.operator = 'managed'`,
		sql`j.started_at is not null`,
		sql`j.completed_at is not null`,
		sql`j.completed_at >= ${ts(filters.from)}`,
		sql`j.completed_at < ${ts(filters.to)}`,
	];
	if (filters.orgId !== undefined) conds.push(sql`j.org_id = ${filters.orgId}`);

	const minutes = sql`extract(epoch from (j.completed_at - j.started_at)) / 60.0`;

	return db.execute<JobMinutesRow>(sql`
		select
			j.org_id,
			coalesce(sum(greatest(${minutes}, 0)), 0)::float8 as job_minutes,
			count(*)::int as job_count
		from public.jobs j
		join public.runners r on r.id = j.runner_id
		where ${sql.join(conds, sql` and `)}
		group by j.org_id
		order by job_minutes desc
	`);
}
