// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type Query, dehydrate } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { ProjectShell } from "@/components/design-project/project-shell";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";

/** Whether a cached query is this layout's environments prefetch, and settled (see `[org]/layout.tsx`). */
function isEnvSwitcherRead(query: Query): boolean {
	const [path] = query.queryKey;
	return (
		query.state.status === "success" &&
		Array.isArray(path) &&
		path[0] === "workspace" &&
		path[1] === "environments"
	);
}

/**
 * The project workspace layout. Owns the docked panel (service inspector + AI assistant) so the
 * assistant persists across the project's views (Architecture / Environments / Jobs / …) — Next
 * keeps the layout mounted across route changes. The routed view renders in the shell's main area.
 *
 * WHY AN UNRESOLVABLE SLUG DOES NOT `notFound()` HERE. In the App Router a segment's
 * `not-found.tsx` is handed to the `LayoutRouter` for that segment's **children** slot
 * (`next/dist/server/app-render/create-component-tree.js`: `notFoundComponent = isChildrenRouteKey
 * ? notFoundElement : undefined`), so the `HTTPAccessFallbackBoundary` mounts INSIDE this layout.
 * A `notFound()` thrown in the layout body is outside it and unwinds to the next boundary above —
 * `[org]/not-found.tsx` — which answered "Organization not found" for a project that is missing
 * while its org is fine (#3880).
 *
 * So the layout resolves for `ProjectShell` and stops there. When the slug names no project there
 * is no shell to render and no `projectId` to render it with, so the layout renders the routed
 * segment bare; every page under `[project]` resolves the same slug and calls `notFound()` itself,
 * and THAT throw is inside this segment's children slot, so `[project]/not-found.tsx` catches it
 * and the response is a real 404 rather than a 200 carrying not-found content.
 *
 * ONLY a slug that names no project is answered that way (`resolveProjectOr404`,
 * `lib/projects/resolve-project-or-404.ts`). A lost session redirects to sign-in, and any other
 * failure is rethrown as it is: this layout used to swallow every throw into "no project", so a
 * failed lookup rendered the page with no shell around it, or as "Project not found". A throw from
 * a layout is outside its own segment's `error.tsx` for the same reason as above, so that one
 * lands on `[org]/error.tsx`, inside the app shell, with its retry.
 */
export default async function ProjectLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	const projectId = await resolveProjectOr404(project);
	// No project, no shell — the page below answers the miss inside the boundary (see above).
	if (projectId === null) return <>{children}</>;

	// The project's CANONICAL environments entry (#7877): the topbar switcher reads it, and the
	// Environments page derives which environments its panels list from it. Prefetching it here lets
	// both paint with the page instead of fetching after hydration (#6114). On the server it is the
	// environments domain's request-memoised read, so the page below reusing it costs no query.
	const queryClient = getQueryClient();
	const [identities] = await Promise.all([
		getVerifiedCloudIdentities(),
		queryClient.prefetchQuery(
			serverOrpc().workspace.environments.queryOptions({ input: { project } }),
		),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isEnvSwitcherRead })}>
			<ProjectShell projectId={projectId} identities={identities}>
				{children}
			</ProjectShell>
		</HydrationBoundary>
	);
}
