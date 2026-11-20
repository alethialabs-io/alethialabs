// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound, redirect } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { readConnectorsWithStatus } from "@/lib/rpc/procedures/connectors";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoDescribeEnabled } from "@/lib/addons/describe-flag";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

/**
 * The tab reads "Architecture", as its sibling tabs read "Environments" and "Jobs". It used to be
 * the project's URL slug, which is an address and not a name.
 */
export const metadata = pageMetadata({
	title: "Architecture",
	description: "Design this project's multi-cloud infrastructure.",
});

/** The page's query string without `environment_id`, starting with `?`, or empty. */
function withoutEnvironment(sp: Record<string, string | string[] | undefined>): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(sp)) {
		if (key === "environment_id" || value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
	}
	const text = query.toString();
	return text ? `?${text}` : "";
}

/**
 * `/{org}/{project}/architecture` — the project's Architecture view: the full-bleed design canvas.
 * The active environment (`?environment_id=`) scopes which env's design loads; with none, the
 * project's default environment does. This is the project's default view (the bare
 * `/{org}/{project}` redirects here).
 *
 * WHAT A FAILED LOOKUP IS ANSWERED WITH. A slug that names no project is the project 404; a lost
 * session goes to sign-in; any other failure of that lookup is rethrown to the segment's error
 * boundary, which offers a retry (`resolveProjectOr404`) — it used to be reported as "Project not
 * found". An `environment_id` that names no environment of this project REDIRECTS to the same page
 * without it: the board used to load the default environment while the address and the environment
 * switcher still named the other one, so what was on screen and what the page said it was
 * disagreed. A failed environment lookup is rethrown too, where it used to be read as "no id".
 *
 * THE FIRST PAINT IS THE BOARD (#6119, F009). Everything the board draws is read here, on the server,
 * before the page renders: the design (a prop), and — in-process through the read router, under the
 * exact keys the canvas asks for — the environment's status, its add-ons and, where the features are
 * on, its BYO charts, described workloads and IaC source. The board used to fetch all of those after
 * hydration, so it painted empty and its nodes popped in seconds later. `loading.tsx` covers this
 * wait with the board's own skeleton.
 *
 * And the server render DRAWS that data (#6348). React Flow is client-only and loads at the point of
 * use, so what the server sends in the board's place is `BoardPreview`: the design's cards, the last
 * job, the cost and the toolbar — or the blank-board guide — drawn from these reads without React
 * Flow. A skeleton there would be a first paint without the data this page already read.
 */
export default async function ProjectArchitecturePage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org, project } = await params;
	const sp = await searchParams;
	const envIdParam =
		typeof sp.environment_id === "string" ? sp.environment_id : undefined;
	const projectId = (await resolveProjectOr404(project)) ?? notFound();

	// Not caught: a lookup that fails is not an answer about which environment this is.
	const environmentId = await resolveActiveEnvironmentId(projectId, envIdParam);
	// The address named an environment and the lookup answered with another: that id is stale (a
	// deleted environment, an old link). Go to the address that is true, keeping the rest of it.
	if (sp.environment_id !== undefined && environmentId !== envIdParam) {
		redirect(`/${org}/${project}/architecture${withoutEnvironment(sp)}`);
	}

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
		readConnectorsWithStatus(),
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
					environmentId={environmentId}
					byoHelmEnabled={byoHelmEnabled}
					byoDescribeEnabled={byoDescribeEnabled}
					byoIacEnabled={byoIacEnabled}
				/>
			</div>
		</HydrationBoundary>
	);
}
