"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import type { ClusterCardShape } from "@/components/clusters/cluster-card-shape";
import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";
import { orpc } from "@/lib/rpc/client";

/**
 * The cards one project's clusters page will draw, from the org's cluster shapes. The list is
 * org-wide and a project's clusters are the rows whose `projectId` is its id, so:
 *
 * - no cluster in the org — none in the project either: `[]`;
 * - the project's id found among the projects — its own shapes, `[]` when it has none;
 * - the project not resolvable — `undefined`: the skeleton's default grid.
 */
export function projectShapes(
	shapes: ClusterCardShape[] | undefined,
	projectId: string | undefined,
): ClusterCardShape[] | undefined {
	if (shapes === undefined) return undefined;
	if (shapes.length === 0) return [];
	if (projectId === undefined) return undefined;
	return shapes.filter((shape) => shape.projectId === projectId);
}

/**
 * The project clusters route's skeleton (`app/(private)/[org]/[project]/clusters/loading.tsx`). A
 * `loading.tsx` receives no params, so the server hands over the org's shapes and this resolves the
 * project in the browser: the slug from the address, its id from the shell's `workspace.projects`
 * answer — read from the cache only (`enabled: false`; the `[org]` layout prefetches and hydrates it
 * above this boundary), never fetched for a skeleton.
 */
export function ProjectClustersSkeleton({ shapes }: { shapes: ClusterCardShape[] | undefined }) {
	const params = useParams<{ project: string }>();
	const projects = useQuery(orpc.workspace.projects.queryOptions({ enabled: false })).data;
	const projectId = projects?.find((p) => p.slug === params.project)?.id;
	return <ClustersSkeleton shapes={projectShapes(shapes, projectId)} />;
}
