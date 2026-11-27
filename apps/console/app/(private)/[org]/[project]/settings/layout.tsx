// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";

/** Whether a cached query is this layout's linked-git-accounts prefetch, and settled. */
function isLinkedGitProvidersRead(query: Query): boolean {
	const [path] = query.queryKey;
	return (
		query.state.status === "success" &&
		Array.isArray(path) &&
		path[0] === "projects" &&
		path[1] === "linkedGitProviders"
	);
}

/**
 * Project settings content shell. The section-nav (General · Access · Activity) lives in the
 * app-shell sidebar's Settings drill — which force-expands the sidebar on these routes — so this
 * layout only frames the content, mirroring the org settings layout.
 *
 * It also seeds the viewer's linked git accounts (`projects.linkedGitProviders`) into the query
 * cache, ABOVE every child route's `loading.tsx`. The Preview environments skeleton is synchronous
 * (CON-M4) and takes its Source row's layout — the repository row, or the taller "No Git accounts
 * linked" panel — from that cache entry alone (`preview-route-skeleton.tsx`). Before this, a
 * navigation into Preview from any route that had not read the accounts drew the repository row,
 * and a viewer with nothing linked watched it grow by the panel's height (#7200's accepted cost,
 * 138px on the UI audit's seeded org). The layout stays mounted across settings routes, so the read
 * is made once on entering settings, not per navigation, and it is a database read of the viewer's
 * own `account` rows — no provider API is asked.
 */
export default async function ProjectSettingsLayout({
	children,
}: {
	children: ReactNode;
}) {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().projects.linkedGitProviders.queryOptions());
	return (
		<SettingsShell>
			<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isLinkedGitProvidersRead })}>
				{children}
			</HydrationBoundary>
		</SettingsShell>
	);
}
