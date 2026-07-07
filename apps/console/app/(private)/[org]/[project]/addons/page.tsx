// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getProjectAddons } from "@/app/server/actions/addons";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { AddonsClient } from "@/components/addons/addons-client";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Add-ons",
	description:
		"Free, open-source apps your cluster comes up with — Grafana, Prometheus, Loki and more, installed via GitOps.",
});

/**
 * `/{org}/{project}/addons` — the marketplace for this project's active environment. Prefetches
 * the catalog joined with the environment's install state and hydrates it; `loading.tsx` covers
 * the prefetch window. Add-ons apply on the next Deploy.
 */
export default async function ProjectAddonsRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<{ environment_id?: string }>;
}) {
	const { project } = await params;
	const { environment_id } = await searchParams;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const environmentId = environment_id ?? null;
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.addons(projectId, environmentId),
		queryFn: () => getProjectAddons(projectId, environmentId),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<AddonsClient projectId={projectId} environmentId={environmentId} />
		</HydrationBoundary>
	);
}
