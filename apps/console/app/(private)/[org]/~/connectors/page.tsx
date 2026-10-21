// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import { ConnectorsPage } from "@/components/connectors/connectors-page";
import { getQueryClient } from "@/lib/query/client";
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
 * Connectors route (#6124, ADR 0005). Prefetches the board's one read — the catalog with this
 * org's connection status, the manage capability and the instance's per-provider availability —
 * in-process through the read router, so the first paint is the board, not a skeleton that then
 * fetches. Nothing here writes: the pending identity a connect sheet binds to is created when the
 * sheet opens. `loading.tsx` covers the prefetch window.
 */
export default async function ConnectorsRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org: orgSlug } = await params;
	const queryClient = getQueryClient();
	// `retry: false`: a refusal or a transient failure must not hold the first byte; the browser
	// reads again under its own retry rule. Not part of the key.
	await queryClient.prefetchQuery(serverOrpc().connectors.board.queryOptions({ retry: false }));

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isConnectorsRead })}>
			<ConnectorsPage orgSlug={orgSlug} />
		</HydrationBoundary>
	);
}
