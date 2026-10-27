// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { AccessManager } from "@/components/settings/access/access-manager";
import { accessQueryFromUrl } from "@/components/settings/access/access-filters";
import {
	isForbiddenRead,
	isPeopleRead,
	retryUnlessRefused,
} from "@/components/settings/members/people-reads";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants and resource-level permissions for your organization.",
});

/**
 * `/{org}/~/settings/access` — the org's access grants (#6129, the jobs slice's shape).
 *
 * The `customRoles` entitlement is resolved here, on the server, so the first paint is the list
 * or the upsell rather than an upsell shown while the client store loads (#5850). With it, the
 * grants (pristine, and for the link's filters) and the grant builder's options are prefetched
 * in-process through the read router, so the browser fetches nothing on mount. Both reads require
 * `member:view`; a viewer without it gets the no-access render on the first paint (`forbidden`).
 */
export default async function AccessPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { customRoles } = getEntitlements(await currentActor());
	if (!customRoles) return <AccessManager customRoles={false} />;

	const filtered = accessQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	// A refusal is not retried: it answers the same the second time.
	const pristine = rpc.members.grants.queryOptions({ input: {}, retry: retryUnlessRefused });
	await Promise.all([
		queryClient.prefetchQuery(pristine),
		queryClient.prefetchQuery(rpc.members.grants.queryOptions({ input: filtered, retry: retryUnlessRefused })),
		queryClient.prefetchQuery(
			rpc.members.grantOptions.queryOptions({ input: undefined, retry: retryUnlessRefused }),
		),
	]);
	const forbidden = isForbiddenRead(queryClient.getQueryState(pristine.queryKey)?.error);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<AccessManager customRoles forbidden={forbidden} />
		</HydrationBoundary>
	);
}
