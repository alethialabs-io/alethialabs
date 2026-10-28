// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { PreviewSettingsPage } from "@/components/settings/preview/preview-settings";
import { getGitlabBaseUrl } from "@/lib/config/auth";
import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";
import { gitProviderAvailability } from "@/lib/connectors/git-providers";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Preview environments - Settings",
	description: "Configure pull request preview environments for this project.",
});

/**
 * `/{org}/{project}/settings/preview` — PR-preview generator settings (#6128).
 *
 * Prefetches the key the page reads (`settings.preview` for this slug: the config, the project's
 * fabrics and its git credentials) in-process and hydrates it, so the first paint is the filled
 * form. A slug that names no project in this org is this segment's 404; a project the caller may not
 * see is not dehydrated, and the client renders the refusal. The git-provider availability and the
 * GitLab base URL are this deployment's configuration, not data, so they stay props.
 */
export default async function ProjectPreviewSettingsPage({
	params,
}: {
	params: Promise<{ project: string }>;
}) {
	const { project } = await params;
	const queryClient = getQueryClient();
	const options = serverOrpc().settings.preview.queryOptions({ input: { project } });
	await queryClient.prefetchQuery(options);
	if (queryClient.getQueryData(options.queryKey) === null) notFound();

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<PreviewSettingsPage
				project={project}
				gitlabBaseUrl={getGitlabBaseUrl()}
				providerAvailability={gitProviderAvailability(computePlatformConfigured())}
			/>
		</HydrationBoundary>
	);
}
