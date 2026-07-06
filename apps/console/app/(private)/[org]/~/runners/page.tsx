// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { qk } from "@/lib/query/keys";
import { fetchFleetData, fetchRunnersData } from "@/lib/query/resource-fetchers";
import { RunnersClient } from "./runners-client";

export const metadata = pageMetadata({
	title: "Runners",
	description: "Warm pools and the runners that execute your provisioning jobs.",
});

/**
 * Runners route. Prefetches the runner list + fleet pools on the server and hydrates them
 * into the client cache so the grids render on first paint; `loading.tsx` covers the
 * prefetch window. The query hooks then poll on the reconcile cadence.
 */
export default async function RunnersRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await Promise.all([
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
