// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { Suspense } from "react";
import { runnersQueryFromUrl } from "@/components/runners/runners-query";
import { RunnersSkeleton } from "@/components/runners/runners-skeleton";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { RunnersClient } from "./runners-client";

export const metadata = pageMetadata({
	title: "Runners",
	description: "Warm pools and the runners that execute your provisioning jobs.",
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Runners route (#6123, ADR 0005).
 *
 * THE PLAN GATE IS DECIDED HERE, ON THE SERVER, before anything that looks like the page renders. A
 * hosted tenant whose plan does not include BYO runners gets the upsell and nothing else — no read is
 * prefetched for it, and no skeleton of a grid is shown first (F021: the old route showed a runner
 * grid's skeleton, then the client learned the entitlement and swapped in the upsell). Self-managed
 * operators are never gated. The entitlement is the actor's, resolved from the ADDRESS like every read.
 *
 * Entitled, the page's reads are prefetched in-process through the read router and hydrated, so the
 * first paint carries data and the browser issues no read on mount (RUBRIC B1). Their skeleton is the
 * `<Suspense>` fallback below — the page's real layout — not `loading.tsx`, which shows before the
 * gate is known and so promises no shape at all.
 */
export default async function RunnersRoute({ searchParams }: { searchParams: SearchParams }) {
	const actor = await currentActor();
	const hosted = deploymentMode() === "hosted";
	if (hosted && !getEntitlements(actor).byoRunners) {
		return <FeatureUpsell feature="byoRunners" />;
	}
	return (
		<Suspense fallback={<RunnersSkeleton hosted={hosted} />}>
			<PrefetchedRunners searchParams={searchParams} hosted={hosted} />
		</Suspense>
	);
}

/**
 * Prefetches exactly the keys the client reads on first paint:
 * - `runners.page` for the pristine grid (`{}`), which the client renders before its filter store has
 *   read the link, and for the URL's filters, the key it settles on once it has (#4980, F8) — `{}`
 *   twice for a pristine link, which TanStack dedupes;
 * - `runners.list`, the unfiltered universe the Versions panel, the default flags and the pickers
 *   read — a different question from a filtered page, not a leftover;
 * - `runners.fleet` and `runners.fleetEconomics`, only where the Pools column renders (self-managed);
 *   the economics read answers null, without a recorded refusal, to anyone who does not manage it.
 * A read that fails is not dehydrated; its region renders its own error after a client retry.
 */
async function PrefetchedRunners({ searchParams, hosted }: { searchParams: SearchParams; hosted: boolean }) {
	const filtered = runnersQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.runners.page.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.runners.page.queryOptions({ input: filtered })),
		queryClient.prefetchQuery(rpc.runners.list.queryOptions()),
		hosted ? undefined : queryClient.prefetchQuery(rpc.runners.fleet.queryOptions()),
		hosted ? undefined : queryClient.prefetchQuery(rpc.runners.fleetEconomics.queryOptions()),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<RunnersClient hosted={hosted} />
		</HydrationBoundary>
	);
}
