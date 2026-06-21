// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import type { CloudProvider } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

type CountRow = { n: number };
type ProviderCountRow = { provider: string | null; n: number };

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
