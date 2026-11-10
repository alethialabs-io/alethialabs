// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ORPCError } from "@orpc/server";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { z } from "zod";
import { prefetchClassificationOf } from "@/components/classification/prefetch-classification";
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
 * are prefetched beside the case by `prefetchClassificationOf` (#6344), the one copy of the keys
 * `ClassificationControl` asks for, shared with every other route that renders it. Without them the
 * server HTML had no picker and the browser made those reads on mount to draw it (B1), and a failure
 * of those reads made the button disappear with nothing in its place (B4). They are not the case:
 * one that fails on the server leaves the case rendering, is not retried there (the helper asks with
 * `retry: false`), is not shipped as a cached error (the client's `dehydrate` ships successes and
 * still-pending queries only, and these are awaited, so none is pending), and is asked again by the
 * browser.
 */
export default async function CaseDetailRoute({
	params,
}: {
	params: Promise<{ org: string; id: string }>;
}) {
	const { org, id } = await params;
	if (!z.string().uuid().safeParse(id).success) notFound();

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	// Started first and awaited after the case, so they run beside it. The helper only calls
	// `prefetchQuery`, which never rejects, so a not-found or a failed case read cannot leave this
	// promise unhandled.
	const sideReads = prefetchClassificationOf(queryClient, CASE_RESOURCE_KIND, id);
	try {
		await queryClient.fetchQuery(rpc.support.case.queryOptions({ input: { id } }));
	} catch (error) {
		if (error instanceof ORPCError && error.code === "NOT_FOUND") notFound();
		throw error;
	}
	await sideReads;

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseDetail caseId={id} orgSlug={org} />
		</HydrationBoundary>
	);
}
