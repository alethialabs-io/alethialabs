// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import { ConnectorsPage } from "@/components/connectors/connectors-page";
import {
	DEFAULT_CONNECTOR_FILTERS,
	normalizeConnectorQuery,
} from "@/components/connectors/connectors-query";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Connectors",
	description: "Connect AWS, GCP, Azure, Alibaba Cloud, and Hetzner accounts to Alethia.",
});

/**
 * Whether a cached query is this page's own settled read. The server QueryClient is one per request
 * (`cache()`) and the `[org]` layout hands its shell reads to the client through its own boundary,
 * so dehydrating everything would serialize those into this page's HTML a second time.
 */
function isConnectorsRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "connectors";
}

/**
 * Connectors route (#6124, ADR 0005). Prefetches EXACTLY the key the client asks for on first paint
 * — the board read for the link's filters: the matching rows and facets, the catalog with this
 * org's connection status, the manage capability and the per-provider availability — in-process
 * through the read router, so the first paint is the board, not a skeleton that then fetches. The
 * render creates no row: the pending identity a connect sheet binds to is started when the sheet
 * opens. The one side effect the read keeps is the git-link refresh it always did (an expired but
 * refreshable link is renewed before its status is read — `readConnectorsBoard`). `loading.tsx`
 * covers the prefetch window.
 */
export default async function ConnectorsRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org: orgSlug } = await params;
	const input = normalizeConnectorQuery(
		filterStateFromUrl(paramReader(await searchParams), DEFAULT_CONNECTOR_FILTERS),
	);
	const queryClient = getQueryClient();
	// `retry: false`: a refusal or a transient failure must not hold the first byte; the browser
	// reads again under its own retry rule. Not part of the key.
	await queryClient.prefetchQuery(serverOrpc().connectors.board.queryOptions({ input, retry: false }));

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isConnectorsRead })}>
			<ConnectorsPage orgSlug={orgSlug} />
		</HydrationBoundary>
	);
}
