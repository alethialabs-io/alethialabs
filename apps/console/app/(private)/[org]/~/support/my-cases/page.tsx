// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { CaseList } from "@/components/support/cases/case-list";
import {
	CASE_LIST_PARAM_NAMES,
	DEFAULT_SUPPORT_CASE_FILTERS,
	normalizeSupportCaseQuery,
} from "@/components/support/cases/case-query";
import { getPdp } from "@/lib/authz";
import { currentActor } from "@/lib/authz/guard";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "My cases",
	description: "Your support cases and their conversation threads.",
});

/**
 * "My cases" route (#6130, the jobs slice's shape). Prefetches EXACTLY the key the list asks for on
 * first paint — `support.cases` for the link's lifecycle bucket (`?status=`) — in-process through
 * the read router, and hands the dehydrated cache to the client, so the rows are in the server HTML
 * and the browser fetches nothing on mount. When the link names a bucket, "All" is prefetched too:
 * the list's hydration render reads the store's default bucket before the URL is read into it.
 * `loading.tsx` covers the prefetch window.
 */
export default async function MyCasesRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org } = await params;
	const filters = filterStateFromUrl(
		paramReader(await searchParams),
		DEFAULT_SUPPORT_CASE_FILTERS,
		CASE_LIST_PARAM_NAMES,
	);
	const { bucket } = normalizeSupportCaseQuery(filters);

	// Whether the caller sees the whole org's cases (owner/admin) vs only their own —
	// drives the "all cases" caption + the per-row requester label.
	const actor = await currentActor();
	const seeAll = (
		await getPdp().can(actor, "manage_support", { type: "support_case" })
	).allowed;

	const queryClient = getQueryClient();
	const buckets = bucket === "all" ? ["all" as const] : (["all", bucket] as const);
	await Promise.all(
		buckets.map((b) =>
			queryClient.prefetchQuery(serverOrpc().support.cases.queryOptions({ input: { bucket: b } })),
		),
	);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseList orgSlug={org} seeAll={seeAll} />
		</HydrationBoundary>
	);
}
