// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ORPCError } from "@orpc/server";
import { HydrationBoundary, type QueryClient, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CaseDetail } from "@/components/support/cases/case-detail";
import { CASE_RESOURCE_KIND } from "@/components/support/cases/case-query";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Case",
	description: "A support case and its conversation thread.",
});

/**
 * Case-detail route (#6130). Reads the case in-process through the read router's `support.case`
 * — the key the client view reads — and hands the dehydrated cache to the client, so the thread is
 * in the server HTML. A case the caller cannot see (or an id that is not a case id at all) is the
 * segment's `not-found.tsx`, which reads the same whether the case never existed or is another
 * org's or another requester's. Any other failure propagates to the route's error boundary rather
 * than rendering as a missing case. `loading.tsx` covers the read.
 *
 * The case's classification row is part of the same first paint (#6336): the edit decision that
 * decides whether "Classify" renders, the case's chips, and the unsearched taxonomy the picker reads
 * are prefetched beside the case under the keys `ClassificationControl` asks for. Without them the
 * server HTML had no picker and the browser made those reads on mount to draw it (B1), and a failure
 * of those reads made the button disappear with nothing in its place (B4). They are not the case:
 * one that fails on the server leaves the case rendering, is not shipped as a cached error (the
 * default `dehydrate` ships successes only), and is asked again by the browser.
 */
export default async function CaseDetailRoute({
	params,
}: {
	params: Promise<{ org: string; id: string }>;
}) {
	const { org, id } = await params;

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	// Started first and awaited after the case, so they run beside it. `prefetchQuery` never
	// rejects, so a not-found or a failed case read cannot leave this promise unhandled.
	const sideReads = prefetchCaseSideReads(queryClient, rpc, id);
	try {
		await queryClient.fetchQuery(rpc.support.case.queryOptions({ input: { id } }));
	} catch (error) {
		if (error instanceof ORPCError && error.code !== "NOT_FOUND") notFound();
		throw error;
	}
	await sideReads;

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseDetail caseId={id} orgSlug={org} />
		</HydrationBoundary>
	);
}

/**
 * Prefetches the reads the case view's classification row makes, under the keys the browser asks
 * for (`lib/query/use-classification-query.ts`): `canEdit` (input-less — the org-level key every
 * control shares), this case's `assignments`, and the unsearched taxonomy (`{}`, the blank form of
 * `dimensionsInput()`) the picker reads on mount. No retry: a failed side read is the browser's to
 * ask again, and the case should not wait out a retry delay for a button. Never rejects.
 */
async function prefetchCaseSideReads(
	queryClient: QueryClient,
	rpc: ReturnType<typeof serverOrpc>,
	id: string,
): Promise<void> {
	await Promise.all([
		queryClient.prefetchQuery(rpc.classification.canEdit.queryOptions({ input: undefined })),
		queryClient.prefetchQuery(rpc.classification.dimensions.queryOptions({ input: {}, retry: false })),
	]);
}
