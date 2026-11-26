// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary, type Query } from "@tanstack/react-query";
import { EvidenceClient } from "@/components/evidence/evidence-client";
import {
	filtersFromSearchParams,
	normalizeEvidenceQuery,
} from "@/components/evidence/evidence-query";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Evidence",
	description:
		"Proof that your infrastructure is what you provisioned: verification verdicts, drift posture, and recorded waivers across every environment.",
});

/**
 * Whether a cached query is this page's own read (`evidence.*`) and settled. The server
 * QueryClient is one per request, shared with the `[org]` layout, which hands the shell's reads
 * down through its own boundary; this one does not serialize them a second time.
 */
function isEvidenceRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "evidence";
}

/**
 * Evidence route — the org-wide day-2 "keep proving it" roll-up (#6126, ADR 0005 D1). Decodes the
 * link's filters (the URL half of the filter standard) and prefetches EXACTLY the two reads the
 * client asks for on first paint — the first page of the `evidence.page` posture walk for those
 * filters, under the infinite key `useKeysetList` reads (#7755), and the first page of the
 * `evidence.waivers` log — in-process through the read router, so the tenant is the org this
 * address names, and a shared filtered link hydrates into the view it shows. Later pages of either
 * are the browser's.
 *
 * Awaited, because the first paint IS the data; `loading.tsx` covers the window. A prefetch that
 * fails is not dehydrated: the client then shows its skeleton, reads once more in the browser, and
 * renders the error or refusal it gets — never an empty page. `retry: false` keeps a refusal from
 * holding the first byte for a retry the browser makes anyway; it is not part of the key.
 */
export default async function EvidenceRoute({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const input = normalizeEvidenceQuery(filtersFromSearchParams(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchInfiniteQuery(
			rpc.evidence.page.infiniteOptions({
				input: (cursor: string | null) => (cursor === null ? input : { ...input, cursor }),
				initialPageParam: null,
				getNextPageParam: (last) => last.nextCursor,
				retry: false,
			}),
		),
		queryClient.prefetchInfiniteQuery({ ...waiversFirstPage(rpc), retry: false }),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isEvidenceRead })}>
			<EvidenceClient />
		</HydrationBoundary>
	);
}

/**
 * The recorded-waivers log's first page as an infinite query, built the way `useKeysetList` builds it
 * (lib/query/use-keyset-list.ts) for `EvidenceWaivers`' one stable query `{}`: the cursor is the page
 * param, so the key is the filter alone and the client reads this entry on hydration instead of
 * fetching on mount (B1 — the panel painted its pending lines until hydration after #7529 gave the
 * log its own read).
 */
function waiversFirstPage(rpc: ReturnType<typeof serverOrpc>) {
	return rpc.evidence.waivers.infiniteOptions({
		input: (cursor: string | null) => (cursor === null ? {} : { cursor }),
		initialPageParam: null,
		getNextPageParam: (last) => last.nextCursor,
	});
}
