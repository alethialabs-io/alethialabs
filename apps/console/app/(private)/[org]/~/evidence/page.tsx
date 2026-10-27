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
 * link's filters (the URL half of the filter standard) and prefetches EXACTLY the `evidence.page`
 * read the client asks for on first paint, in-process through the read router — so the tenant is
 * the org this address names, and a shared filtered link hydrates into the view it shows.
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
	await queryClient.prefetchQuery({
		...serverOrpc().evidence.page.queryOptions({ input }),
		retry: false,
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isEvidenceRead })}>
			<EvidenceClient />
		</HydrationBoundary>
	);
}
