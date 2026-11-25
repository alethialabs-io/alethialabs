// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import { ConnectedAgentsPage } from "@/components/settings/connected/connected-agents-page";
import { getQueryClient } from "@/lib/query/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Connected agents · Settings",
	description: "The AI apps you've let act for you in this organization.",
});

/** Whether a cached query is one of this page's own settled reads (the board and the project names). */
function isConnectedAgentsRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	if (query.state.status !== "success" || !Array.isArray(path)) return false;
	return (path[0] === "agents" && path[1] === "connected") || (path[0] === "workspace" && path[1] === "projects");
}

/**
 * `/{org}/~/settings/connected` — the signed-in person's connected agents in this org (AGT-L2 SPEC
 * §5a). Prefetches the exact keys the board asks for on first paint, in-process through the read
 * router: `agents.connected` (their grants, the app catalogue, the kill switch) and the org's project
 * names for the projects chip. A refusal or a failure is the board's own state, never a thrown page.
 */
export default async function ConnectedAgentsRoute({ params }: { params: Promise<{ org: string }> }) {
	const { org } = await params;
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.agents.connected.queryOptions({ input: undefined, retry: retryUnlessRefused })),
		queryClient.prefetchQuery(rpc.workspace.projects.queryOptions({ retry: retryUnlessRefused })),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isConnectedAgentsRead })}>
			<ConnectedAgentsPage orgSlug={org} />
		</HydrationBoundary>
	);
}
