// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { prefetchClassificationOfList } from "@/components/classification/prefetch-classification";
import { prefetchEnvironmentsLists } from "@/components/environments/environments-prefetch";
import { EnvironmentsView } from "@/components/environments/environments-view";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export async function generateMetadata() {
	return pageMetadata({
		title: "Environments",
		description: "Isolated instances of this project's services.",
	});
}

/**
 * `/{org}/{project}/environments` — the project's Environments management view (in place of the
 * canvas). Lists the project's environments; create / duplicate / delete / promote are handled in
 * the client view.
 *
 * THE ADR 0005 SLICE (#6120), as the jobs route (#6113): the page's reads are prefetched
 * IN-PROCESS through the read router with exactly the keys the client asks for, and the dehydrated
 * cache is handed to the client — so the first paint carries the environments and the client
 * issues no request on mount. The panels' read, `environments.overview` (`{ project }`: every
 * environment, whatever the bar selects), and the paged reads (LST-3 #7485,
 * `prefetchEnvironmentsLists`): the table's first keyset page for the pristine list and for the
 * link's filters, and the promotions history's first page. Each environment card's
 * classification control is prefetched the same way once the environments are known (#6334): the
 * edit decision, the taxonomy and every card's chips in the view's one batched read, so the
 * "Classify" pickers are in the first paint. `loading.tsx` covers the
 * prefetch window with the view's own skeleton.
 *
 * ONLY THIS PAGE'S READS ARE HANDED DOWN HERE (`settledReadOf("environments", "classification")`).
 * The server QueryClient is one per request, shared with the `[org]` and `[project]` layouts, and
 * each layout already dehydrates its own reads through its own boundary: the shell's `workspace.*`
 * reads and the topbar switcher's `workspace.environments`. An unfiltered `dehydrate` here
 * serialized all of those into this page's HTML a second time (#7736), and handed down whichever of
 * them was still pending at that instant.
 *
 * The slug is resolved once per request: the `[project]` layout asks the same question with the
 * same slug, and `resolveProjectOr404` is memoised with React `cache()`.
 *
 * An unresolvable slug is a real 404 here, inside this segment's children slot (see the
 * `[project]` layout). A read that fails is NOT rendered here: the failed query does not dehydrate,
 * so the client renders the read's own failed or refused state (RUBRIC B4) — never an empty list.
 */
export default async function ProjectEnvironmentsPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org, project } = await params;
	// Null is the project 404; a lost session or a real failure never reaches this line.
	if ((await resolveProjectOr404(project)) === null) notFound();

	const queryClient = getQueryClient();
	const overview = serverOrpc().environments.overview.queryOptions({ input: { project } });
	await Promise.all([
		queryClient.prefetchQuery(overview),
		prefetchEnvironmentsLists(queryClient, project, paramReader(await searchParams)),
	]);
	const envs = queryClient.getQueryData(overview.queryKey)?.envs;
	if (envs !== undefined) {
		await prefetchClassificationOfList(
			queryClient,
			"project_environment",
			envs.map((e) => e.id),
		);
	}

	return (
		<HydrationBoundary
			state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("environments", "classification") })}
		>
			<EnvironmentsView org={org} project={project} />
		</HydrationBoundary>
	);
}
