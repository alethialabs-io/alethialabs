// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary, type Query } from "@tanstack/react-query";
import { Suspense } from "react";
import { AlertsPage } from "@/components/alerts/alerts-page";
import { alertsQueriesFromUrl } from "@/components/alerts/alerts-query";
import { AlertsSkeleton } from "@/components/alerts/alerts-skeleton";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Alerts",
	description: "Notification channels, alert rules, and delivery activity.",
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Alerts route (#6125, ADR 0005 — the jobs slice's shape).
 *
 * THE GATES ARE DECIDED HERE, ON THE SERVER, before anything that looks like the hub renders. A
 * member without `view_alerts` gets the no-access notice; an org whose plan does not include
 * alerting gets the upsell — and neither is shown a skeleton of a hub first, nor has any read
 * prefetched for it (F021). Both answers are the ADDRESSED org's: the actor resolves from the URL.
 * The permission probe is `can`, not `authorize`, so loading the page records nothing in the org's
 * activity log.
 *
 * Past both, the hub's reads are prefetched in-process through the read router and hydrated, so the
 * first paint carries every section's rows and the browser issues no read on mount (RUBRIC B1).
 * Their skeleton is the `<Suspense>` fallback below — the hub's real layout — not `loading.tsx`,
 * which shows before the gates are known and so promises no shape at all.
 */
export default async function AlertsRoute({ searchParams }: { searchParams: SearchParams }) {
	const actor = await currentActor();
	const canView = (await getPdp().can(actor, "view_alerts", { type: "alert" })).allowed;
	if (!canView) {
		return (
			<div className="p-6">
				<Alert>
					<AlertTitle>No access to alerts</AlertTitle>
					<AlertDescription>
						You don&apos;t have permission to view alerting for this organization.
						Ask an owner or admin for the <code>view_alerts</code> permission.
					</AlertDescription>
				</Alert>
			</div>
		);
	}
	if (!getEntitlements(actor).alerting) {
		return <FeatureUpsell feature="alerting" />;
	}
	return (
		<Suspense fallback={<AlertsSkeleton />}>
			<PrefetchedAlerts searchParams={searchParams} />
		</Suspense>
	);
}

/** Whether a cached query is one of this route's own reads, and answered — the `dehydrate` filter. */
function isAlertsRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "alerts";
}

/**
 * Prefetches exactly the keys the hub reads on first paint:
 * - `alerts.settings` — the plan gate, `canManage`, the event catalog, the condition options;
 * - each list's PRISTINE page (`{}`), which the panel renders before its filter store has read the
 *   link, and which is also the universe the panels cross-reference against;
 * - each list for the URL's filters, the key the panel settles on once it has read the link (#4980,
 *   the audit's F8) — `{}` again for a pristine link, which TanStack dedupes.
 * A read that fails is not dehydrated; its section renders its own error after a client retry. The
 * `[org]` layout shares this request's QueryClient and hands its shell reads over through its own
 * boundary, so only this route's reads are serialized here.
 */
async function PrefetchedAlerts({ searchParams }: { searchParams: SearchParams }) {
	const filtered = alertsQueriesFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.alerts.settings.queryOptions()),
		queryClient.prefetchQuery(rpc.alerts.policies.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.alerts.channels.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.alerts.deliveries.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.alerts.policies.queryOptions({ input: filtered.policies })),
		queryClient.prefetchQuery(rpc.alerts.channels.queryOptions({ input: filtered.channels })),
		queryClient.prefetchQuery(rpc.alerts.deliveries.queryOptions({ input: filtered.activity })),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isAlertsRead })}>
			<AlertsPage />
		</HydrationBoundary>
	);
}
