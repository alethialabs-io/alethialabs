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
import { getPdp } from "@/lib/authz";
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
 *
 * Whether the viewer may add and revoke grants is decided here too, with the question
 * `assignGrant` and `revokeGrant` ask (`member:manage_members`), and asked QUIETLY — a viewer who may
 * only read is not recorded as denied for opening the page. A control they cannot use is then
 * disabled with its reason from the first paint (R6 E-08).
 */
export default async function AccessPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const actor = await currentActor();
	const { customRoles } = getEntitlements(actor);
	if (!customRoles) return <AccessManager customRoles={false} />;

	const filtered = accessQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	// A refusal is not retried: it answers the same the second time. The pristine read goes FIRST
	// and alone: a viewer without `member:view` is refused there, once, and the filtered list and the
	// builder's options — which would each record the same denial — are not asked at all.
	const pristine = rpc.members.grants.queryOptions({ input: {}, retry: retryUnlessRefused });
	const [canManage] = await Promise.all([
		getPdp()
			.can(actor, "manage_members", { type: "member" })
			.then((d) => d.allowed),
		queryClient.prefetchQuery(pristine),
	]);
	const forbidden = isForbiddenRead(queryClient.getQueryState(pristine.queryKey)?.error);
	if (!forbidden) {
		await Promise.all([
			queryClient.prefetchQuery(rpc.members.grants.queryOptions({ input: filtered, retry: retryUnlessRefused })),
			queryClient.prefetchQuery(
				rpc.members.grantOptions.queryOptions({ input: undefined, retry: retryUnlessRefused }),
			),
		]);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<AccessManager customRoles forbidden={forbidden} canManage={canManage} />
		</HydrationBoundary>
	);
}
