// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { listDimensions } from "@/app/server/actions/classification/dimensions";
import { ClassificationManager } from "@/components/classification/classification-manager";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Classification · Settings",
	description:
		"Define the dimensions and values used to classify resources across your organization.",
});

/**
 * Settings · Classification route. Prefetches the org's classification taxonomy on the
 * server and hands the dehydrated cache to the manager so it renders on first paint.
 */
export default async function ClassificationSettingsPage() {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.classificationDimensions(),
		queryFn: () => listDimensions(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ClassificationManager />
		</HydrationBoundary>
	);
}
