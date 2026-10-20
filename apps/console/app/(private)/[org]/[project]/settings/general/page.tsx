// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
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
 * so the first paint is the filled form. A slug that names no project in this org is this
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
	if (queryClient.getQueryData(options.queryKey) === null) notFound();

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ProjectGeneral project={project} orgSlug={org} />
		</HydrationBoundary>
	);
}
