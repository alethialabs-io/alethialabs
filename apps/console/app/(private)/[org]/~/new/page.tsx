// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { Suspense } from "react";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { ConfigureProject } from "@/components/create-project/configure-project";
import { CreateProjectForm } from "@/components/create-project/create-project-form";
import {
	ChooserSkeleton,
	ConfigureSkeleton,
} from "@/components/create-project/create-project-skeletons";
import type { ScratchKind } from "@/components/create-project/start-from-scratch-cards";
import { isScanJobId } from "@/components/create-project/scan-job-id";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import {
	computePlatformConfigured,
	getCloudConnectSetup,
} from "@/lib/connectors/cloud-connect-setup";
import { gitProviderAvailability } from "@/lib/connectors/git-providers";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { arrayIncludes } from "@/lib/type-guards";

export const metadata = pageMetadata({
	title: "New project",
	description: "Create a project to provision multi-cloud infrastructure.",
});

const SCRATCH_KINDS: readonly ScratchKind[] = [
	"template",
	"blank",
	"byo-helm",
	"byo-iac",
];

/**
 * `/{org}/~/new` — the two-step create flow.
 *  - **Step 1 (bare):** the source chooser — an Elench hero + Import a repository + Start from scratch.
 *  - **Step 2 (`?scan=<jobId>` or `?scratch=<kind>`):** the Configure screen — name, cloud + region,
 *    environments — which creates the project and opens its canvas.
 *
 * Each step is its own Suspense boundary, keyed by the step, with a skeleton in that step's shape
 * (RUBRIC B2): a `loading.tsx` cannot read the search params, so it can only ever be one of the two.
 * Each step PREFETCHES what its first paint reads, through the read router in-process, and hydrates
 * it (RUBRIC B1, the jobs slice's pattern) — nothing the first paint shows is fetched on mount.
 */
export default async function NewProjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<{ scan?: string | string[]; scratch?: string | string[] }>;
}) {
	const { org } = await params;
	const sp = await searchParams;
	const scanJobId = typeof sp.scan === "string" ? sp.scan : undefined;
	const scratch =
		typeof sp.scratch === "string" && arrayIncludes(SCRATCH_KINDS, sp.scratch)
			? sp.scratch
			: undefined;

	// Step 2 — Configure (import or scratch). Both funnel through the same screen.
	if (scanJobId || scratch) {
		const source = scanJobId
			? { kind: "import" as const, scanJobId }
			: { kind: "scratch" as const, scratch: scratch! };
		return (
			<Suspense
				key={scanJobId ? `scan:${scanJobId}` : `scratch:${scratch}`}
				fallback={<ConfigureSkeleton />}
			>
				<ConfigureStep org={org} source={source} />
			</Suspense>
		);
	}

	// Step 1 — the source chooser.
	return (
		<Suspense key="chooser" fallback={<ChooserSkeleton />}>
			<ChooserStep org={org} />
		</Suspense>
	);
}

/**
 * Step 1's data: the collaboration flag, and the caller's linked git providers — which decide the
 * import panel's layout, so they must be in the first paint rather than swapped in after it (F034).
 */
async function ChooserStep({ org }: { org: string }) {
	const queryClient = getQueryClient();
	const [collab] = await Promise.all([
		getCollaborationAccess(),
		queryClient.prefetchQuery(serverOrpc().projects.linkedGitProviders.queryOptions()),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CreateProjectForm
				orgSlug={org}
				canCollaborate={collab.canInvite}
				byoHelmEnabled={isByoHelmEnabled()}
				byoIacEnabled={isByoIacEnabled()}
				providerAvailability={gitProviderAvailability(computePlatformConfigured())}
			/>
		</HydrationBoundary>
	);
}

/**
 * Step 2's data: the cloud-connect setup, and for an import the scan — its status, and its proposal
 * when the digest is already there — so a finished scan renders READY on the first paint and a
 * running one renders the rail's "scanning" state, then follows the scan live over the `jobs` topic.
 * A `?scan=` that cannot be a job id is not asked about: the screen says the scan was not found.
 */
async function ConfigureStep({
	org,
	source,
}: {
	org: string;
	source: { kind: "import"; scanJobId: string } | { kind: "scratch"; scratch: ScratchKind };
}) {
	const queryClient = getQueryClient();
	const scanRead = async () => {
		if (source.kind !== "import" || !isScanJobId(source.scanJobId)) return;
		const input = { jobId: source.scanJobId };
		const statusOptions = serverOrpc().projects.scanStatus.queryOptions({ input });
		await queryClient.prefetchQuery(statusOptions);
		if (queryClient.getQueryData(statusOptions.queryKey)?.status === "SCANNED") {
			await queryClient.prefetchQuery(serverOrpc().projects.scanProposal.queryOptions({ input }));
		}
	};
	const [setup] = await Promise.all([getCloudConnectSetup(), scanRead()]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ConfigureProject
				orgSlug={org}
				source={source}
				canManage={setup.canManage}
				integrations={setup.integrations}
				awsSetup={setup.awsSetup ?? null}
				gcpSetup={setup.gcpSetup ?? null}
				azureSetup={setup.azureSetup ?? null}
				extraSetup={setup.extraSetup}
				platformConfigured={setup.platformConfigured}
				byoHelmEnabled={isByoHelmEnabled()}
				byoIacEnabled={isByoIacEnabled()}
			/>
		</HydrationBoundary>
	);
}
