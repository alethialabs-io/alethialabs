// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import {
	isForbiddenRead,
	isPeopleRead,
	retryUnlessRefused,
} from "@/components/settings/members/people-reads";
import { rolesSearchFromUrl } from "@/components/settings/roles/roles-filters";
import { RolesManager } from "@/components/settings/roles/roles-manager";
import { RolesNoAccess } from "@/components/settings/roles/roles-no-access";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Roles · Settings",
	description: "Built-in and custom roles for fine-grained access control.",
});

/**
 * Roles route (#6129, the jobs slice's shape). Prefetches the role catalog (built-ins with their
 * grant counts, the permission catalog, the entitlement, the manage check) and the custom roles —
 * unsearched, and for the link's search — in-process through the read router, so the rail and the
 * detail paint with data and the browser fetches nothing on mount.
 *
 * Both reads require `member:view`. A viewer without it gets the no-access notice from HERE, on the
 * first paint — the catalog's typed FORBIDDEN, never an empty rail and never an error.
 */
export default async function RolesPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const search = rolesSearchFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	// A refusal is not retried: it answers the same the second time, and the retry's back-off would
	// hold the no-access render up for a second.
	const catalog = rpc.members.roleCatalog.queryOptions({ input: undefined, retry: retryUnlessRefused });
	await Promise.all([
		queryClient.prefetchQuery(catalog),
		queryClient.prefetchQuery(rpc.members.roles.queryOptions({ input: {}, retry: retryUnlessRefused })),
		search
			? queryClient.prefetchQuery(
					rpc.members.roles.queryOptions({ input: { search }, retry: retryUnlessRefused }),
				)
			: Promise.resolve(),
	]);

	if (isForbiddenRead(queryClient.getQueryState(catalog.queryKey)?.error)) {
		return <RolesNoAccess />;
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<RolesManager />
		</HydrationBoundary>
	);
}
