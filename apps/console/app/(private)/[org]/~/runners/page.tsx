// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { qk } from "@/lib/query/keys";
import { getRunnersPage } from "@/app/server/actions/runners";
import { fetchFleetData, fetchRunnersData } from "@/lib/query/resource-fetchers";
import { RunnersClient } from "./runners-client";

export const metadata = pageMetadata({
	title: "Runners",
	description: "Warm pools and the runners that execute your provisioning jobs.",
});

/**
 * Runners route. Prefetches the runner GRID's pristine page + the fleet pools on the server
 * and hydrates them into the client cache so both render on first paint; `loading.tsx` covers
 * the prefetch window. The query hooks then poll on the reconcile cadence.
 */
export default async function RunnersRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await Promise.all([
		// The GRID's key, pristine — `normalizeRunnersQuery()` of the default filters is `{}`,
		// and the key the client builds on first render has to be this one or hydration misses
		// and the page fetches anyway (#4890).
		queryClient.prefetchQuery({
			queryKey: qk.runnersPage(org, {}),
			queryFn: () => getRunnersPage({}),
		}),
		// The UNFILTERED universe, which is a different read for different consumers and not a
		// leftover: the Versions changelog compares every runner against the latest release, and
		// each card's action menu needs to know whether ITS runner is the org default — neither
		// question is answerable from a filtered page. Dropping this prefetch does not break
		// them, it just makes them both fetch after hydration, on a page that had them on first
		// paint.
		queryClient.prefetchQuery({
			queryKey: qk.runners(org),
			queryFn: fetchRunnersData,
		}),
		queryClient.prefetchQuery({
			queryKey: qk.fleet(org),
			queryFn: fetchFleetData,
		}),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<RunnersClient />
		</HydrationBoundary>
	);
}
