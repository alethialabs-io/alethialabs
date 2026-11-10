// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { accessQueryFromUrl } from "@/components/settings/access/access-filters";
import { AccessManager } from "@/components/settings/access/access-manager";
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
	description: "Access grants scoped to this project.",
});

/**
 * `/{org}/{project}/settings/access` — Access grants scoped to this project. Resolves the project
 * slug → project id and hands it to the shared manager, which filters grants + fixes new-grant
 * scope. The `customRoles` entitlement is resolved here, on the server, so the first paint is the
 * list (or the upsell) rather than an upsell shown while the client store loads (#5850).
 *
 * #6129 (B1): with the entitlement, the project's grants — pristine (`{ projectId }`, the facet
 * universe) and for the link's filters — and the grant builder's options are prefetched in-process
 * exactly as the org Access page prefetches them, so the browser fetches nothing on mount. The
 * pristine read goes first and alone: a viewer without `member:view` is refused there once, and gets
 * the no-access render on the first paint.
 */
export default async function ProjectAccessPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	const { customRoles } = getEntitlements(await currentActor());
	if (!customRoles) return <AccessManager projectId={projectId} customRoles={false} />;

	const filtered = accessQueryFromUrl(paramReader(await searchParams), projectId);
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const pristine = rpc.members.grants.queryOptions({ input: { projectId }, retry: retryUnlessRefused });
	await queryClient.prefetchQuery(pristine);
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
			<AccessManager projectId={projectId} customRoles forbidden={forbidden} />
		</HydrationBoundary>
	);
}
