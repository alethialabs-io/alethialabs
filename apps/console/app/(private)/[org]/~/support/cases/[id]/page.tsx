// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getCase } from "@/app/server/actions/support";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { CaseDetail } from "@/components/support/cases/case-detail";

export const metadata = pageMetadata({
	title: "Case",
	description: "A support case and its conversation thread.",
});

/**
 * Case-detail route. Prefetches the case + thread on the server (404s when it isn't
 * visible), hydrates it into the client cache so the thread renders on first paint, and
 * lets the client view take over the live SSE updates; `loading.tsx` covers the prefetch.
 */
export default async function CaseDetailRoute({
	params,
}: {
	params: Promise<{ org: string; id: string }>;
}) {
	const { org, id } = await params;
	const queryClient = getQueryClient();
	const result = await getCase(id);
	if (!result) notFound();

	queryClient.setQueryData(qk.supportCase(id), result);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseDetail caseId={id} orgSlug={org} />
		</HydrationBoundary>
	);
}
