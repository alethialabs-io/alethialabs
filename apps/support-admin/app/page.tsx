// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { listStaffCases } from "@/app/actions";
import { getStaff } from "@/lib/auth/staff";
import { getQueryClient } from "@/lib/query-client";
import { StaffCaseList } from "@/components/staff-case-list";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = {
	title: "Support admin",
	description: "Cross-tenant support console for Alethia staff.",
};

/**
 * The staff support console landing route (the app root, `/`). Gates on `getStaff()`
 * (Cloudflare Access should already have blocked non-staff — this is defense-in-depth),
 * then prefetches the unfiltered cross-tenant case list on the server and hands the
 * dehydrated cache to the client so the list renders on first paint.
 */
export default async function SupportAdminHome() {
	const staff = await getStaff();
	if (!staff) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
				<h1 className="text-lg font-medium text-foreground">Not authorized</h1>
				<p className="max-w-sm text-sm text-muted-foreground">
					This dashboard is for Alethia support staff only. If you believe you
					should have access, contact an administrator.
				</p>
			</div>
		);
	}

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: ["support-admin", "cases", {}],
		queryFn: () => listStaffCases({}),
	});

	return (
		<StaffShell staffEmail={staff.email}>
			<HydrationBoundary state={dehydrate(queryClient)}>
				<StaffCaseList />
			</HydrationBoundary>
		</StaffShell>
	);
}
