// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import type { CloudProvider } from "@/lib/db/schema";
import type { RunnerState } from "@/lib/fleet/controller";
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

/** Mark an ONLINE runner DRAINING so it stops claiming and drains to idle. */
export async function markRunnerDraining(runnerId: string): Promise<void> {
	await getServiceDb().execute(sql`
		update public.runners set status = 'DRAINING'::public.runner_status, updated_at = now()
		where id = ${runnerId}::uuid and status = 'ONLINE'
	`);
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
