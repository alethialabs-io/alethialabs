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
		    version = coalesce(version, ${version}),
		    updated_at = now()
		where id = ${runnerId}::uuid
		  and (location is distinct from ${location} or version is null)
	`);
}

/** Mark an ONLINE runner DRAINING so it stops claiming and drains to idle. */
export async function markRunnerDraining(runnerId: string): Promise<void> {
	await getServiceDb().execute(sql`
		update public.runners set status = 'DRAINING'::public.runner_status, updated_at = now()
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

/** Mark a removed runner OFFLINE and close its open usage session at now(). */
export async function retireRunner(runnerId: string): Promise<void> {
	await getServiceDb().execute(sql`
		with closed as (
			update public.runners set status = 'OFFLINE'::public.runner_status, updated_at = now()
			where id = ${runnerId}::uuid returning id
		)
		update public.runner_usage_sessions s
		set ended_at = now(),
		    duration_seconds = greatest(0, extract(epoch from (now() - s.started_at)))::bigint
		from closed c where s.runner_id = c.id and s.ended_at is null
	`);
}
