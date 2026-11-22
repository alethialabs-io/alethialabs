// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { Suspense } from "react";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { CreateProjectForm } from "@/components/create-project/create-project-form";
import { CreateProjectScreen } from "@/components/create-project/create-project-screen";
import { CreateProjectFormSkeleton } from "@/components/create-project/create-project-skeletons";
import { type CreateSource, isCreateSource } from "@/components/create-project/create-project.wizard";
import { isScanJobId } from "@/components/create-project/scan-job-id";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { offeredClouds } from "@/lib/cloud-providers/availability";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { computePlatformConfigured, getCloudConnectSetup } from "@/lib/connectors/cloud-connect-setup";
import { gitProviderAvailability } from "@/lib/connectors/git-providers";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "New project",
	description: "Create a project to provision multi-cloud infrastructure.",
});

/** What the older two-step links (`?scratch=<kind>`) asked for, as a starting point. */
const SCRATCH_SOURCES: Readonly<Record<string, CreateSource>> = {
	template: "standard",
	blank: "blank",
	"byo-helm": "byo-helm",
	"byo-iac": "byo-iac",
};

/** The starting point a link asks for: `?source=<id>`, or an older `?scratch=<kind>`. */
function requestedSource(sp: {
	source?: string | string[];
	scratch?: string | string[];
}): CreateSource | null {
	if (typeof sp.source === "string" && isCreateSource(sp.source)) return sp.source;
	if (typeof sp.scratch === "string") return SCRATCH_SOURCES[sp.scratch] ?? null;
	return null;
}

/**
 * `/{org}/~/new` — one screen. The design agent's prompt on top, then the create form: start from,
 * cloud, region and name, with every value it can work out already filled in. An import follows its
 * scan in place (`?scan=<jobId>`), and Create lands on the new project's canvas.
 *
 * The prompt draws at once; the form waits on its reads inside a Suspense boundary whose fallback is
 * the form's own shape. What the form's first paint reads — the git accounts, the org's projects,
 * the scan — is PREFETCHED here and hydrated, so nothing it shows is fetched on mount.
 */
export default async function NewProjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<{
		scan?: string | string[];
		scratch?: string | string[];
		source?: string | string[];
	}>;
}) {
	const { org } = await params;
	const sp = await searchParams;
	const scanJobId = typeof sp.scan === "string" ? sp.scan : null;
	const collab = await getCollaborationAccess();
	const flags = { byoHelmEnabled: isByoHelmEnabled(), byoIacEnabled: isByoIacEnabled() };
	return (
		<div className="space-y-9 pb-20">
			<CreateProjectForm orgSlug={org} canCollaborate={collab.canInvite} />
			<Suspense fallback={<CreateProjectFormSkeleton {...flags} />}>
				<FormStep org={org} scanJobId={scanJobId} initialSource={requestedSource(sp)} {...flags} />
			</Suspense>
		</div>
	);
}

/**
 * The form's data: the cloud-connect setup and the offered clouds, the viewer's git accounts, the
 * org's projects (the name and region defaults read them), and for an import the scan — its status,
 * and its proposal once scanned — so a finished scan is READY on the first paint and a running one
 * follows the `jobs` topic from there.
 */
async function FormStep({
	org,
	scanJobId,
	initialSource,
	byoHelmEnabled,
	byoIacEnabled,
}: {
	org: string;
	scanJobId: string | null;
	initialSource: CreateSource | null;
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}) {
	const queryClient = getQueryClient();
	const scanRead = async () => {
		if (scanJobId === null || !isScanJobId(scanJobId)) return;
		const input = { jobId: scanJobId };
		const statusOptions = serverOrpc().projects.scanStatus.queryOptions({ input });
		await queryClient.prefetchQuery(statusOptions);
		if (queryClient.getQueryData(statusOptions.queryKey)?.status === "SCANNED") {
			await queryClient.prefetchQuery(serverOrpc().projects.scanProposal.queryOptions({ input }));
		}
	};
	const [setup] = await Promise.all([
		getCloudConnectSetup(),
		scanRead(),
		queryClient.prefetchQuery(serverOrpc().projects.linkedGitProviders.queryOptions()),
		queryClient.prefetchQuery(serverOrpc().workspace.projects.queryOptions()),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CreateProjectScreen
				orgSlug={org}
				offered={offeredClouds().filter(isCloudProviderSlug)}
				integrations={setup.integrations}
				canManage={setup.canManage}
				awsSetup={setup.awsSetup ?? null}
				gcpSetup={setup.gcpSetup ?? null}
				azureSetup={setup.azureSetup ?? null}
				extraSetup={setup.extraSetup}
				byoHelmEnabled={byoHelmEnabled}
				byoIacEnabled={byoIacEnabled}
				providerAvailability={gitProviderAvailability(computePlatformConfigured())}
				initialSource={initialSource}
			/>
		</HydrationBoundary>
	);
}
