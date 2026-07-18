// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { fleetActions } from "@/lib/db/schema";
import type { CloudProvider } from "@/lib/db/schema";
import type { FleetActionRecord, RunnerState } from "@/lib/fleet/controller";
import { sql } from "drizzle-orm";

type CountRow = { n: number };
type ProviderCountRow = { provider: string | null; n: number };
type RunnerByInstanceRow = {
	instance_id: string;
	runner_id: string;
	status: string;
	version: string | null;
	busy: boolean;
};

/** One managed runner enriched for the Fleet observability view (per-pool table + stats). */
export interface ManagedRunnerRow {
	runnerId: string;
	instanceId: string | null;
	location: string | null;
	version: string | null;
	status: "online" | "draining" | "offline";
	busy: boolean;
	/** Seconds since the runner row was created (uptime); null if unknown. */
	ageSeconds: number | null;
	/** Seconds since the last heartbeat (last seen); null if never. */
	lastSeenSeconds: number | null;
}

type ManagedRunnerRawRow = {
	runner_id: string;
	instance_id: string | null;
	location: string | null;
	version: string | null;
	status: string;
	busy: boolean;
	age_seconds: number | null;
	last_seen_seconds: number | null;
};

/** QUEUED job counts grouped by target provider. Provider-less lifecycle jobs land
 *  under the "any" key (claimable by any runner; not attributed to a cloud pool). */
export async function backlogByProvider(): Promise<Map<string, number>> {
	const rows = await getServiceDb().execute<ProviderCountRow>(sql`
		select provider, count(*)::int as n
		from jobs where status = 'QUEUED'
		group by provider
	`);
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.provider ?? "any", Number(r.n));
	return out;
}

/**
 * DISPATCHABLE QUEUED job counts grouped by target provider — the subset of the raw backlog a managed
 * runner could actually claim RIGHT NOW, given each org's plan concurrency cap. Raw `backlogByProvider`
 * over-counts: a free (community) org that queues 50 jobs while already running its 2 has 48 jobs
 * `claim_next_job` will refuse — sizing the fleet to those provisions VMs the caps themselves block
 * (idle billable capacity). Here, per provider, we sum each org's LEAST(queued, remaining cap headroom);
 * a NULL cap (enterprise) contributes its full queued count.
 *
 * The cap headroom is per-ORG and shared across providers, but credited per (org, provider): an org
 * queueing on two providers at once can double-count its headroom (bounded, and rare — an org usually
 * targets one cloud per burst). That errs toward slightly OVER-provisioning, never under — the opposite
 * of, and far smaller than, the raw-backlog over-count it replaces. Mirrors the managed-claim
 * eligibility filters in claim_next_job (unassigned, not self-required).
 */
export async function dispatchableBacklogByProvider(): Promise<
	Map<string, number>
> {
	const rows = await getServiceDb().execute<ProviderCountRow>(sql`
		with inflight as (
			select k.org_id, count(*)::int as n
			from public.jobs k
			join public.runners r on r.id = k.runner_id
			where k.status in ('CLAIMED', 'PROCESSING') and r.operator = 'managed'
			group by k.org_id
		),
		queued as (
			select org_id, provider, count(*)::int as n
			from public.jobs
			where status = 'QUEUED'
			  and assigned_runner_id is null
			  and requires_self_runner = false
			group by org_id, provider
		)
		select q.provider,
			sum(
				case
					when public.plan_max_concurrency(public.org_effective_plan(q.org_id)) is null then q.n
					else least(
						q.n,
						greatest(0, public.plan_max_concurrency(public.org_effective_plan(q.org_id)) - coalesce(i.n, 0))
					)
				end
			)::int as n
		from queued q
		left join inflight i on i.org_id = q.org_id
		group by q.provider
	`);
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.provider ?? "any", Number(r.n));
	return out;
}

/** ONLINE managed runners that can serve a provider (NULL supported_providers = any). */
export async function countManagedRunnersForProvider(
	provider: CloudProvider,
): Promise<number> {
	const rows = await getServiceDb().execute<CountRow>(sql`
		select count(*)::int as n from runners
		where operator = 'managed' and status = 'ONLINE'
		  and (supported_providers is null or ${provider}::cloud_provider = any(supported_providers))
	`);
	return Number(rows[0]?.n ?? 0);
}

/** Managed runners that carry a cloud instance id, keyed by it — the controller joins
 *  this with the provider's instance list to build the observed view. */
export async function managedRunnersByInstance(
	provider: string,
): Promise<Map<string, RunnerState>> {
	const rows = await getServiceDb().execute<RunnerByInstanceRow>(sql`
		select r.metadata->>'cloud_instance_id' as instance_id, r.id::text as runner_id,
		       lower(r.status::text) as status, r.version,
		       exists(select 1 from public.jobs j
		              where j.runner_id = r.id and j.status in ('CLAIMED','PROCESSING')) as busy
		from public.runners r
		where r.operator = 'managed' and r.metadata->>'cloud_instance_id' is not null
		  and (r.supported_providers is null or ${provider}::cloud_provider = any(r.supported_providers))
	`);
	const m = new Map<string, RunnerState>();
	for (const r of rows) {
		const status = r.status === "draining" ? "draining" : r.status === "online" ? "online" : "offline";
		m.set(r.instance_id, { runnerId: r.runner_id, status, version: r.version, busy: r.busy });
	}
	return m;
}

/** Managed runners that can serve a provider, enriched with location/version/uptime/last-seen
 *  for the Fleet view. Same provider filter as {@link managedRunnersByInstance} (NULL
 *  supported_providers = any). Ordered newest-first. */
export async function managedRunnerRowsForProvider(
	provider: string,
): Promise<ManagedRunnerRow[]> {
	const rows = await getServiceDb().execute<ManagedRunnerRawRow>(sql`
		select r.id::text as runner_id, r.metadata->>'cloud_instance_id' as instance_id,
		       r.location, r.version, lower(r.status::text) as status,
		       exists(select 1 from public.jobs j
		              where j.runner_id = r.id and j.status in ('CLAIMED','PROCESSING')) as busy,
		       extract(epoch from (now() - r.created_at))::int as age_seconds,
		       extract(epoch from (now() - r.last_heartbeat))::int as last_seen_seconds
		from public.runners r
		where r.operator = 'managed'
		  and (r.supported_providers is null or ${provider}::cloud_provider = any(r.supported_providers))
		order by r.created_at desc
	`);
	return rows.map((r) => ({
		runnerId: r.runner_id,
		instanceId: r.instance_id,
		location: r.location,
		version: r.version,
		status: r.status === "draining" ? "draining" : r.status === "online" ? "online" : "offline",
		busy: r.busy,
		ageSeconds: r.age_seconds == null ? null : Number(r.age_seconds),
		lastSeenSeconds: r.last_seen_seconds == null ? null : Number(r.last_seen_seconds),
	}));
}

/** Current in-flight (CLAIMED/PROCESSING) managed jobs for a provider — the auto-grow signal. */
export async function countInflightForProvider(provider: string): Promise<number> {
	const rows = await getServiceDb().execute<CountRow>(sql`
		select count(*)::int as n from public.jobs j
		join public.runners r on r.id = j.runner_id
		where r.operator = 'managed' and j.status in ('CLAIMED','PROCESSING')
		  and (r.supported_providers is null or ${provider}::cloud_provider = any(r.supported_providers))
	`);
	return Number(rows[0]?.n ?? 0);
}

/** Newest runner release version (the channel resolves to this; one release stream today). */
export async function latestReleaseVersion(): Promise<string | null> {
	const rows = await getServiceDb().execute<{ version: string }>(sql`
		select version from public.runner_releases order by released_at desc nulls last limit 1
	`);
	return rows[0]?.version ?? null;
}

/** Persist the cloud-observed placement (location) + launch version onto a runner row.
 *  Only writes when something changed (no per-tick churn); `version` backfills via coalesce
 *  so the runner's own heartbeat-reported version always wins. */
export async function setRunnerObserved(
	runnerId: string,
	location: string,
	version: string | null,
): Promise<void> {
	await getServiceDb().execute(sql`
		update public.runners
		set location = ${location},
		    version = coalesce(version, ${version})
		where id = ${runnerId}::uuid
		  and (location is distinct from ${location} or version is null)
	`);
}

/** Mark an ONLINE runner DRAINING so it stops claiming and drains to idle. */
export async function markRunnerDraining(runnerId: string): Promise<void> {
	await getServiceDb().execute(sql`
		update public.runners set status = 'DRAINING'::public.runner_status
		where id = ${runnerId}::uuid and status = 'ONLINE'
	`);
}

/** Append one row to the durable fleet_actions ledger. A drizzle typed insert (not raw sql) so the
 *  enum/column types are checked. Global platform table (no org_id / no RLS) → getServiceDb. */
export async function insertFleetAction(record: FleetActionRecord): Promise<void> {
	await getServiceDb()
		.insert(fleetActions)
		.values({
			provider: record.provider,
			action: record.action,
			runner_id: record.runnerId,
			reason: record.reason,
			queue_depth: record.queueDepth,
			pool_size: record.poolSize,
			metadata: record.metadata,
		});
}

/**
 * Cross-replica scale guard for one provider's pool. Opens a transaction, takes a NON-blocking
 * per-provider advisory xact lock (`pg_try_advisory_xact_lock`), and only runs `apply` if it won the
 * lock — auto-released when the tx commits/rolls back. A second replica ticking the same provider gets
 * `false` immediately (no wait) and skips its whole apply span, so two replicas can't both create off
 * the same stale pool snapshot (over-provision). Single replica ⇒ lock always free ⇒ `apply` always
 * runs (identical to pre-lock).
 *
 * Key: `hashtextextended('fleet-scaler:' || provider, 0)` — a stable 64-bit key in the single-arg
 * advisory-lock space. The `fleet-scaler:` prefix keeps it distinct from every other advisory lock in
 * the repo: the Stripe webhook keys on `evt_…` ids, the claim admission on `alethia:claim:managed:…`,
 * and the AI budget uses the two-int overload (a separate lock space entirely).
 *
 * The tx holds one pooled connection across this pool's create calls for the tick (low-frequency, one
 * provider). `apply`'s own writes (create/drain/retire/recordAction) draw a SEPARATE connection from
 * the same pool. This therefore requires `ALETHIA_DB_POOL_MAX >= 2` (the default is 10): at a pool
 * size of 1 the lock tx pins the only connection and `apply`'s nested query can never acquire one →
 * the scaler tick would wedge. Any realistic deployment runs a pool of several; a size-1 pool is a
 * pathological config and would starve much of the app besides the scaler.
 */
export async function tryFleetScaleLock(
	provider: string,
	apply: () => Promise<void>,
): Promise<boolean> {
	return getServiceDb().transaction(async (tx) => {
		const rows = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(hashtextextended(${`fleet-scaler:${provider}`}, 0)) as locked`,
		);
		if (!rows[0]?.locked) return false;
		await apply();
		return true;
	});
}

/**
 * Try to acquire or renew the single-row fleet-controller leader LEASE for this replica, in one
 * atomic upsert. Returns true iff `holder` now owns the lease (freshly seized because it was unheld/
 * expired, or renewed because `holder` already held it) — the caller then runs the reconcile tick;
 * a false means another live replica holds it, so this tick no-ops. The `ON CONFLICT … WHERE` only
 * overwrites an EXPIRED lease or the holder's own row, so a live leader is never stolen; RETURNING
 * yields no row when the update is skipped → not leader. TTL should exceed the tick interval so the
 * leader renews each tick it wins and holds across ticks; a crashed leader is superseded after ≤TTL.
 * Unlike a held advisory-lock transaction, the lease pins no connection across the tick's slow cloud
 * calls (no idle-in-transaction). Global platform row (no RLS) → getServiceDb().
 */
export async function tryBecomeFleetLeader(
	holder: string,
	ttlSeconds: number,
): Promise<boolean> {
	const rows = await getServiceDb().execute<{ is_leader: boolean }>(sql`
		insert into public.fleet_leader (singleton, holder, expires_at, updated_at)
		values (true, ${holder}::uuid, now() + make_interval(secs => ${ttlSeconds}), now())
		on conflict (singleton) do update
			set holder = excluded.holder, expires_at = excluded.expires_at, updated_at = now()
			where public.fleet_leader.expires_at < now()
			   or public.fleet_leader.holder = excluded.holder
		returning (holder = ${holder}::uuid) as is_leader
	`);
	return rows[0]?.is_leader === true;
}

/** Mark a removed runner OFFLINE and close its open usage session at now(). */
export async function retireRunner(runnerId: string): Promise<void> {
	await getServiceDb().execute(sql`
		with closed as (
			update public.runners set status = 'OFFLINE'::public.runner_status
			where id = ${runnerId}::uuid returning id
		)
		update public.runner_usage_sessions s
		set ended_at = now(),
		    duration_seconds = greatest(0, extract(epoch from (now() - s.started_at)))::bigint
		from closed c where s.runner_id = c.id and s.ended_at is null
	`);
}
