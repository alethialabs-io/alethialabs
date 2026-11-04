// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PreviewSettingsSkeleton, linkedFromProviders } from "@/components/settings/preview/preview-settings-skeleton";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * Skeleton for the project Preview environments settings page, in its final shape: the one
 * Preview environments section with its Save band. No title — the page has none (the breadcrumb
 * names it), so a title-shaped placeholder made the page jump when it loaded.
 *
 * It reads the viewer's linked git accounts BEFORE it draws (#6335). The Source row is either the
 * repository row (40px) or the "No Git accounts linked" panel (178px), and nothing else on the page
 * says which. A skeleton that guessed was 140px wrong for one of the two kinds of viewer, and every
 * row below moved by that much. The read is the viewer's own account list, not the page's data. It
 * goes through the request's query client, so the page's prefetch of the same key in the same
 * request is answered from it rather than read twice. A failed read draws the row, which is what the
 * picker shows while it reads the list itself.
 */
export default async function PreviewSettingsLoading() {
	const queryClient = getQueryClient();
	const options = serverOrpc().projects.linkedGitProviders.queryOptions();
	await queryClient.prefetchQuery(options);
	return <PreviewSettingsSkeleton linked={linkedFromProviders(queryClient.getQueryData(options.queryKey))} />;
}
