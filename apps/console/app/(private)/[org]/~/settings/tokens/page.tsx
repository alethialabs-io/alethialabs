// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { ServiceTokensPage } from "@/components/settings/tokens/service-tokens-page";
import { TokensNoAccess } from "@/components/settings/tokens/tokens-no-access";
import { prefetchServiceTokens } from "@/components/settings/tokens/tokens-prefetch";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { readServiceTokenPermissions } from "@/lib/rpc/procedures/agents";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Service tokens · Settings",
	description: "Tokens that let pipelines and scripts use Alethia without a person signed in.",
});

/**
 * `/{org}/~/settings/tokens` — the org's service tokens (AGT-L2-U3): list, create with the
 * "Deploy without approval" picker, edit environments, revoke. Listing needs `org:manage_tokens`; a
 * viewer without it gets the no-access render on the first paint. `org:manage_agents` decides whether
 * the picker is editable — asked here, from the PDP, and handed down; the page never guesses.
 *
 * The first keyset page for the link's filters is prefetched in-process, so the list paints with rows.
 */
export default async function ServiceTokensRoute({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { canManageTokens, canManageAgents } = await readServiceTokenPermissions();
	if (!canManageTokens) return <TokensNoAccess />;

	const queryClient = getQueryClient();
	await prefetchServiceTokens(queryClient, paramReader(await searchParams));

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("agents") })}>
			<ServiceTokensPage canManageAgents={canManageAgents} />
		</HydrationBoundary>
	);
}
