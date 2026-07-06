// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStaffCase } from "@/app/actions";
import { getStaff } from "@/lib/auth/staff";
import { getQueryClient } from "@/lib/query-client";
import { StaffCaseDetail } from "@/components/staff-case-detail";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = {
	title: "Case",
	description: "Cross-tenant support case for Alethia staff.",
};

/**
 * The staff case-detail route (`/cases/[id]`). Gates on `getStaff()` (Cloudflare Access +
 * allowlist), prefetches the full cross-tenant case (incl. internal notes) into the cache,
 * 404s on a missing case, then hands the dehydrated cache to the client detail view. The
 * acting staff identity feeds the composer's macro `agentName` + the assignment checks.
 */
export default async function SupportAdminCaseRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const staff = await getStaff();
	if (!staff) notFound();

	const queryClient = getQueryClient();
	const initial = await getStaffCase(id);
	if (!initial) notFound();
	queryClient.setQueryData(["support-admin", "case", id], initial);

	return (
		<StaffShell staffEmail={staff.email}>
			<HydrationBoundary state={dehydrate(queryClient)}>
				<StaffCaseDetail
					caseId={id}
					staffId={staff.userId}
					staffName={staff.name}
				/>
			</HydrationBoundary>
		</StaffShell>
	);
}
