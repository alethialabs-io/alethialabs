// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getStaffCase } from "@/app/server/actions/support-staff";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { getSupportStaff } from "@/lib/support/staff";
import { StaffCaseDetail } from "@/components/support/staff/staff-case-detail";

export const metadata = pageMetadata({
	title: "Case · Support admin",
	description: "Cross-tenant support case for Alethia staff.",
});

/**
 * The staff case-detail route. Reads the acting staff identity (for the composer's macro
 * `agentName` + assignment checks), prefetches the full cross-tenant case (incl. internal
 * notes) into the cache, 404s on a missing case, then hands the dehydrated cache to the
 * client detail view.
 */
export default async function SupportAdminCaseRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const staff = await getSupportStaff();
	if (!staff) notFound();

	const queryClient = getQueryClient();
	const initial = await getStaffCase(id);
	if (!initial) notFound();
	queryClient.setQueryData(["support-admin", "case", id], initial);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<StaffCaseDetail
				caseId={id}
				staffId={staff.userId}
				staffName={staff.name}
			/>
		</HydrationBoundary>
	);
}
