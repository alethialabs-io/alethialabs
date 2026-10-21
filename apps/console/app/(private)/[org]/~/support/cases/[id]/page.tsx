// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ORPCError } from "@orpc/server";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CaseDetail } from "@/components/support/cases/case-detail";
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
 */
export default async function CaseDetailRoute({
	params,
}: {
	params: Promise<{ org: string; id: string }>;
}) {
	const { org, id } = await params;
	if (!z.string().uuid().safeParse(id).success) notFound();

	const queryClient = getQueryClient();
	try {
		await queryClient.fetchQuery(serverOrpc().support.case.queryOptions({ input: { id } }));
	} catch (error) {
		if (error instanceof ORPCError && error.code === "NOT_FOUND") notFound();
		throw error;
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseDetail caseId={id} orgSlug={org} />
		</HydrationBoundary>
	);
}
