// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { OrgGeneral } from "@/components/settings/general/org-general";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Organization name, slug, and primary billing address.",
});

/**
 * `/{org}/~/settings/general` (#6128, ADR 0005 D1.5). Prefetches EXACTLY the key the form reads —
 * `settings.org` — in-process through the read router and hands the dehydrated cache to the client,
 * so the first paint is the filled form. Before this the page had no server fetch at all: the form
 * read `getOrgSettings` in a `useEffect` after hydration, behind a skeleton that never ended when
 * the answer was `null` (F050). `loading.tsx` covers the prefetch window.
 *
 * A refused or failed prefetch is not dehydrated; the client asks once and renders the refusal or
 * the error (never the skeleton) — `OrgGeneral`'s four renders.
 */
export default async function GeneralPage() {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().settings.org.queryOptions());
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<OrgGeneral />
		</HydrationBoundary>
	);
}
