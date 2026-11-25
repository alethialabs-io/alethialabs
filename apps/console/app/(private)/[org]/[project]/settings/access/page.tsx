// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { accessQueryFromUrl, type NormalizedAccessQuery } from "@/components/settings/access/access-filters";
import { AccessManager } from "@/components/settings/access/access-manager";
import {
	isForbiddenRead,
	isPeopleRead,
	retryUnlessRefused,
} from "@/components/settings/members/people-reads";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants scoped to this project.",
});

/**
 * `/{org}/{project}/settings/access` — Access grants scoped to this project. Resolves the project
 * slug → project id and hands it to the shared manager, which filters grants + fixes new-grant
 * scope. The `customRoles` entitlement is resolved here, on the server, so the first paint is the
 * list (or the upsell) rather than an upsell shown while the client store loads (#5850).
 *
 * #6129 (B1): with the entitlement, the first page of the project's grants walk — pristine (`{ projectId }`, the facet
 * universe) and for the link's filters — and the grant builder's options are prefetched in-process
 * exactly as the org Access page prefetches them, so the browser fetches nothing on mount. The
 * pristine read goes first and alone: a viewer without `member:view` is refused there once, and gets
 * the no-access render on the first paint.
 *
 * Whether the viewer may add and revoke grants is decided here as the org Access page decides it
 * (#7091): with the question `assignGrant` and `revokeGrant` ask (`member:manage_members`), asked
 * quietly so a viewer who may only read is not recorded as denied for opening the page. A control
 * they cannot use is then disabled with its reason from the first paint (R6 F-11).
 */
export default async function ProjectAccessPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	// Null is the project 404; a lost session or a real failure never reaches this line.
	const projectId = (await resolveProjectOr404(project)) ?? notFound();
	const actor = await currentActor();
	const { customRoles } = getEntitlements(actor);
	if (!customRoles) return <AccessManager projectId={projectId} customRoles={false} />;

	const filtered = accessQueryFromUrl(paramReader(await searchParams), projectId);
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	/**
	 * The first page of one filter's walk, under the infinite key `useKeysetList` reads (LST-8 #7490).
	 * Not retried: a refusal answers the same the second time.
	 */
	const grantsWalk = (filter: NormalizedAccessQuery) =>
		rpc.members.grants.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? filter : { ...filter, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: retryUnlessRefused,
		});
	const pristine = grantsWalk({ projectId });
	const [canManage] = await Promise.all([
		getPdp()
			.can(actor, "manage_members", { type: "member" })
			.then((d) => d.allowed),
		queryClient.prefetchInfiniteQuery(pristine),
	]);
	const forbidden = isForbiddenRead(queryClient.getQueryState(pristine.queryKey)?.error);
	if (!forbidden) {
		await Promise.all([
			queryClient.prefetchInfiniteQuery(grantsWalk(filtered)),
			queryClient.prefetchQuery(
				rpc.members.grantOptions.queryOptions({ input: undefined, retry: retryUnlessRefused }),
			),
		]);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<AccessManager projectId={projectId} customRoles forbidden={forbidden} canManage={canManage} />
		</HydrationBoundary>
	);
}
