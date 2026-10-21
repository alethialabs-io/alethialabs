// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import {
	resolveActiveEnvironmentId,
	resolveProjectId,
} from "@/app/server/actions/resolve";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoDescribeEnabled } from "@/lib/addons/describe-flag";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

/** Per-project tab title from the URL slug (kept cheap — no extra project fetch). */
export async function generateMetadata({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	return pageMetadata({
		title: project,
		description: "Design this project's multi-cloud infrastructure.",
	});
}

/**
 * `/{org}/{project}/architecture` — the project's Architecture view: the full-bleed design canvas.
 * The active environment (`?environment_id=`) scopes which env's design loads; an absent or
 * unresolvable id falls back to the project's default environment. This is the project's default
 * view (the bare `/{org}/{project}` redirects here).
 *
 * THE FIRST PAINT IS THE BOARD (#6119, F009). Everything the board draws is read here, on the server,
 * before the page renders: the design (a prop), and — in-process through the read router, under the
 * exact keys the canvas asks for — the environment's status, its add-ons and, where the features are
 * on, its BYO charts, described workloads and IaC source. The board used to fetch all of those after
 * hydration, so it painted empty and its nodes popped in seconds later. `loading.tsx` covers this
 * wait with the board's own skeleton.
 */
export default async function ProjectArchitecturePage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<{ environment_id?: string | string[] }>;
}) {
	const { project } = await params;
	const sp = await searchParams;
	const envIdParam =
		typeof sp.environment_id === "string" ? sp.environment_id : undefined;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const environmentId = await resolveActiveEnvironmentId(
		projectId,
		envIdParam,
	).catch(() => null);

	const byoHelmEnabled = isByoHelmEnabled();
	const byoDescribeEnabled = isByoDescribeEnabled();
	const byoIacEnabled = isByoIacEnabled();

	// The canvas's reads, keyed exactly as the client keys them: the RESOLVED environment, null for
	// the project's default (lib/query/use-environment-status-query.ts `environmentStatusInput`).
	// `prefetchQuery` never throws: a read that fails here is simply not dehydrated, and the board
	// shows that read's own error state after it retries in the browser.
	const input = { projectId, environmentId };
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const [identities, connectors, sourceProject] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
		getProjectAsFormData(projectId, environmentId).catch(() => undefined),
		queryClient.prefetchQuery(rpc.canvas.environmentStatus.queryOptions({ input })),
		queryClient.prefetchQuery(rpc.canvas.addons.queryOptions({ input })),
		byoHelmEnabled
			? queryClient.prefetchQuery(rpc.canvas.byoCharts.queryOptions({ input }))
			: undefined,
		byoDescribeEnabled
			? queryClient.prefetchQuery(rpc.canvas.chartWorkloads.queryOptions({ input }))
			: undefined,
		byoIacEnabled
			? queryClient.prefetchQuery(rpc.canvas.iacSource.queryOptions({ input }))
			: undefined,
	]);

	return (
		// The project shell (layout) owns the full-bleed height + the docked panel; the board fills it.
		<HydrationBoundary state={dehydrate(queryClient)}>
			<div className="h-full overflow-hidden">
				<DesignProjectWorkbench
					cloudIdentities={identities}
					connectors={connectors}
					sourceProject={sourceProject}
					projectId={projectId}
					environmentId={environmentId ?? undefined}
					dockInShell
					byoHelmEnabled={byoHelmEnabled}
					byoDescribeEnabled={byoDescribeEnabled}
					byoIacEnabled={byoIacEnabled}
				/>
			</div>
		</HydrationBoundary>
	);
}
