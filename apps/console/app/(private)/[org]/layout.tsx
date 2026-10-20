// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import { notFound, redirect } from "next/navigation";
import { resolveOrgScope } from "@/app/server/actions/resolve";
import { currentActor } from "@/lib/authz/guard";
import { classifyOrgScopeFailure } from "@/lib/auth/org-scope-failure";
import { getOwner } from "@/lib/auth/owner";
import { deploymentMode } from "@/lib/billing/config";
import { getQueryClient } from "@/lib/query/client";
import { orgHasSelfRunners } from "@/lib/queries/runner-capabilities";
import { serverOrpc } from "@/lib/rpc/server";
import { AppShell } from "@/components/shell/app-shell";
import { UpgradeSheetProvider } from "@/components/org/upgrade-sheet-provider";

/**
 * Whether a cached query is one of the shell reads this layout prefetched, and settled. The server
 * QueryClient is one per request (`cache()`), shared with the page below, so without this filter the
 * layout would also hand down whatever the page happened to have in flight at that instant.
 */
function isShellRead(query: Query): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "workspace";
}

/**
 * C2 slug-tree layout. Resolves the `{org}` segment to a scope and syncs the
 * session's active organization to it (so the rest of the request is scoped to the
 * URL org), then renders the shared dashboard chrome. Unknown/forbidden org → 404.
 *
 * The 404 it throws is caught by `(private)/not-found.tsx`, NOT by the sibling
 * `[org]/not-found.tsx`: a segment's own boundary mounts inside its layout, so a throw
 * from the layout escapes it (#3891). Do not "fix" a wrong-looking 404 here by moving
 * the boundary back down beside this file — that is the defect, not the remedy, and
 * `scripts/check-route-states.mjs` refuses the tree if the boundary above disappears.
 */
export default async function OrgLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	// No valid session (e.g. a stale/expired cookie the optimistic middleware let
	// through, or a failed session lookup) → sign-in, not a dead-end 404.
	if (!(await getOwner())) redirect("/login");
	let orgId: string;
	// The org a chat turn names (ADR 0003 §6.1): the page's `currentActor().orgId`, which in
	// community collapses to the user id. NOT `orgId` above, which is the real organization's id
	// for every non-`~` slug, and which the turn resolver refuses in community.
	let pageOrgId: string;
	try {
		({ orgId } = await resolveOrgScope(org));
		({ orgId: pageOrgId } = await currentActor());
	} catch (e) {
		// A lost session → sign-in; an org this user is not in → the 404. Anything else is rethrown
		// by the classifier, so it reaches the error boundary and is logged (#5001) instead of being
		// reported as "Organization not found" about the user's own org.
		//
		// Both answers here still THROW, and that is deliberate: redirect() throws NEXT_REDIRECT,
		// which no not-found boundary catches, so adding one above cannot turn this branch into a
		// render. notFound() throws NEXT_NOT_FOUND and lands on `(private)/not-found.tsx` with a real
		// 404 status — the alternative, returning a not-found body from here, answers 200.
		if (classifyOrgScopeFailure(e) === "sign-in") redirect("/login");
		notFound();
	}
	// Feedback is a hosted-only feature (it emails Alethia Labs); the shell hides it
	// off the hosted control plane. Resolved server-side and passed to the client shell.
	const isHosted = deploymentMode() === "hosted";
	// Runners is a self-operator surface only — gate the nav item on whether this org runs
	// its own runners (managed warm pools are internal/support-admin). Resolved server-side.
	//
	// The shell's own reads are prefetched HERE, in parallel, and handed to the client hydrated
	// (#6114, ADR 0005 D1): the org, its plan and the user's org list; the project list; the job and
	// support-case feeds behind the bell and the toasts; the setup guide. The chrome therefore paints
	// with data on the server render and on the first client paint — no "Personal" / "All projects"
	// placeholder that flips when a client fetch lands (F002), and no request of its own on load
	// (F003). Each goes through the read router in-process, so it is served from the actor the
	// ADDRESS resolves, exactly as the browser's GET would be. A prefetch that fails is simply not
	// dehydrated, and the client's own query retries it.
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const [selfRunners] = await Promise.all([
		orgHasSelfRunners(orgId),
		queryClient.prefetchQuery(rpc.workspace.context.queryOptions()),
		queryClient.prefetchQuery(rpc.workspace.projects.queryOptions()),
		queryClient.prefetchQuery(rpc.workspace.jobs.queryOptions()),
		queryClient.prefetchQuery(rpc.workspace.supportCases.queryOptions()),
		queryClient.prefetchQuery(rpc.workspace.setupGuide.queryOptions()),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isShellRead })}>
			<UpgradeSheetProvider>
				<AppShell isHosted={isHosted} selfRunners={selfRunners} pageOrgId={pageOrgId}>
					{children}
				</AppShell>
			</UpgradeSheetProvider>
		</HydrationBoundary>
	);
}
