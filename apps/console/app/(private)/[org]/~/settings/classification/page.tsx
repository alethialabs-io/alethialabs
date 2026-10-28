// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { ClassificationManager } from "@/components/classification/classification-manager";
import { ClassificationNoAccess } from "@/components/classification/classification-no-access";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { getQueryClient } from "@/lib/query/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Classification · Settings",
	description:
		"Define the dimensions and values used to classify resources across your organization.",
});

/**
 * `/{org}/~/settings/classification` — the org's classification taxonomy (#6129, the jobs slice's
 * shape). Prefetched in-process through the read router: the unsearched taxonomy (the key every
 * picker shares), the edit decision that decides which controls render, and the coverage panel of
 * the dimension the page opens on (the first) — so the first paint carries all three and the
 * browser fetches nothing on mount (B1). A viewer the taxonomy read refuses (`org:view`) gets the
 * no-access render as their own state, not the blank slate (B4).
 */
export default async function ClassificationSettingsPage() {
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const taxonomy = rpc.classification.dimensions.queryOptions({ input: {}, retry: retryUnlessRefused });
	await Promise.all([
		queryClient.prefetchQuery(taxonomy),
		queryClient.prefetchQuery(rpc.classification.canEdit.queryOptions({ input: undefined, staleTime: 5 * 60_000 })),
	]);
	if (readRefusalOf(queryClient.getQueryState(taxonomy.queryKey)?.error) === "forbidden") {
		return <ClassificationNoAccess />;
	}
	const first = queryClient.getQueryData(taxonomy.queryKey)?.[0];
	if (first) {
		await queryClient.prefetchQuery(
			rpc.classification.dimensionBreakdown.queryOptions({
				input: { dimensionId: first.id },
				retry: retryUnlessRefused,
			}),
		);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("classification") })}>
			<ClassificationManager />
		</HydrationBoundary>
	);
}
