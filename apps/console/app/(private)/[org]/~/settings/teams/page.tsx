// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { isPeopleRead } from "@/components/settings/members/people-reads";
import { teamsQueryFromUrl } from "@/components/settings/teams/teams-filters";
import { TeamsList } from "@/components/settings/teams/teams-list";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Teams · Settings",
	description: "Teams and their members within your organization.",
});

/**
 * Settings · Teams route (#6129, the jobs slice's shape). Prefetches the `members.teams` read for
 * the pristine view and for the link's filters, in-process through the read router, so the first
 * paint is the list and the browser fetches nothing on mount.
 *
 * The `teams` entitlement is resolved HERE, from the same actor, and handed down: the workspace
 * store's copy is `null` until it loads after hydration, so a client-side gate showed every org
 * neither the button nor the upsell for that round trip (#5864) — and decided the create button
 * on the client at all (F017).
 */
export default async function TeamsPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const filtered = teamsQueryFromUrl(paramReader(await searchParams));
	const { teams } = getEntitlements(await currentActor());
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.members.teams.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.members.teams.queryOptions({ input: filtered })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<TeamsList entitled={teams} />
		</HydrationBoundary>
	);
}
