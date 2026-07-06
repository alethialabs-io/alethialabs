// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { listStaffCases } from "@/app/server/actions/support-staff";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { StaffCaseList } from "@/components/support/staff/staff-case-list";

export const metadata = pageMetadata({
	title: "Support admin",
	description: "Cross-tenant support console for Alethia staff.",
});

/**
 * The staff support console landing route. Prefetches the unfiltered cross-tenant case
 * list on the server and hands the dehydrated cache to the client so the list renders on
 * first paint; `loading.tsx` covers the prefetch window.
 */
export default async function SupportAdminRoute() {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: ["support-admin", "cases", {}],
		queryFn: () => listStaffCases({}),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<StaffCaseList />
		</HydrationBoundary>
	);
}
