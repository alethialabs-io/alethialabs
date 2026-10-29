// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { prefetchClassificationOf } from "@/components/classification/prefetch-classification";
import { ProjectGeneral } from "@/components/settings/general/project-general";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Rename or delete this project.",
});

/**
 * `/{org}/{project}/settings/general` — the project's General settings (rename + delete), #6128.
 *
 * Prefetches the key the form reads (`settings.project` for this slug) in-process and hydrates it,
 * so the first paint is the filled form — and, once the project's id is known, what the form's
 * Classification field reads (the edit decision, the taxonomy, the project's chips, #6334), so its
 * "Classify" picker is in that first paint too rather than arriving after a client read. A slug that names no project in this org is this
 * segment's 404 (`[project]/not-found.tsx`, inside the layout's children slot — see the layout's
 * comment); a project the caller may not see is not dehydrated, and the client renders the refusal.
 */
export default async function ProjectGeneralPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	const queryClient = getQueryClient();
	const options = serverOrpc().settings.project.queryOptions({ input: { project } });
	await queryClient.prefetchQuery(options);
	const general = queryClient.getQueryData(options.queryKey);
	if (general === null) notFound();
	if (general !== undefined) await prefetchClassificationOf(queryClient, "project", general.id);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ProjectGeneral project={project} orgSlug={org} />
		</HydrationBoundary>
	);
}
