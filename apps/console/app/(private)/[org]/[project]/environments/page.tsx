// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { prefetchClassificationOfList } from "@/components/classification/prefetch-classification";
import { EnvironmentsView } from "@/components/environments/environments-view";
import { getQueryClient } from "@/lib/query/client";
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
 * canvas). Lists every environment; create / duplicate / delete / promote are handled in the client
 * view.
 *
 * THE ADR 0005 SLICE (#6120), as the jobs route (#6113): the page's one read,
 * `environments.overview`, is prefetched IN-PROCESS through the read router with exactly the key
 * the client asks for, and the dehydrated cache is handed to the client — so the first paint
 * carries the environments and the client issues no request on mount. Each environment card's
 * classification control is prefetched the same way once the environments are known (#6334): the
 * edit decision, the taxonomy and every card's chips in the view's one batched read, so the
 * "Classify" pickers are in the first paint. `loading.tsx` covers the
 * prefetch window with the view's own skeleton.
 *
 * An unresolvable slug is a real 404 here, inside this segment's children slot (see the
 * `[project]` layout). A read that fails is NOT rendered here: the failed query does not dehydrate,
 * so the client renders the read's own failed or refused state (RUBRIC B4) — never an empty list.
 */
export default async function ProjectEnvironmentsPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	try {
		await resolveProjectId(project);
	} catch {
		notFound();
	}

	const queryClient = getQueryClient();
	const overview = serverOrpc().environments.overview.queryOptions({ input: { project } });
	await queryClient.prefetchQuery(overview);
	const envs = queryClient.getQueryData(overview.queryKey)?.envs;
	if (envs !== undefined) {
		await prefetchClassificationOfList(
			queryClient,
			"project_environment",
			envs.map((e) => e.id),
		);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<EnvironmentsView org={org} project={project} />
		</HydrationBoundary>
	);
}
