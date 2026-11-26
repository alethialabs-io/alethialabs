// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import { AgentPolicyPage } from "@/components/settings/agents/agent-policy-page";
import { getQueryClient } from "@/lib/query/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Agents · Settings",
	description: "What agents may do in this organization, and how approvals work.",
});

/** Whether a cached query is this page's own settled read. */
function isAgentPolicyRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "agents" && path[1] === "policy";
}

/**
 * `/{org}/~/settings/agents` — the org's agent policy (AGT-L2 SPEC §3). Prefetches the exact key the
 * page asks for on first paint, in-process through the read router: `agents.policy` (the settings,
 * who changed them last, and the `org:manage_agents` flag). A refusal or a failure is the page's own
 * state, never a thrown page.
 */
export default async function AgentPolicyRoute() {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(
		serverOrpc().agents.policy.queryOptions({ input: undefined, retry: retryUnlessRefused }),
	);
	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isAgentPolicyRead })}>
			<AgentPolicyPage />
		</HydrationBoundary>
	);
}
