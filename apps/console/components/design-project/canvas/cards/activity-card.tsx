"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Activity } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge } from "@repo/ui/status-badge";
import { RegionError } from "@repo/ui/region-error";
import { ListFooter } from "@/components/list/list-footer";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { orgHref } from "@/lib/routing";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { JobList } from "./job-list";
import { SheetCard } from "./sheet-card";

/** Rows per page. Small: the card is one column, and "Load more" is one click. */
const PAGE = 20;

/**
 * The environment's activity — what has run against this board and what is running now — as a
 * card on the workspace rail, paged.
 *
 * This replaces a floating list pinned to the board's top-left corner that showed the newest
 * eight jobs with no scroll, no paging and no route to the rest: an environment's history ended
 * wherever the list did, over the cards it was about. Here it pages on the console's one keyset
 * contract (`useKeysetList` + `ListFooter`, LST-10 #7492) and follows the environment: the read is the `canvas.environmentJobs` GET procedure, and a job that is
 * queued, starts or finishes is a `jobs` hint on the org's change stream that invalidates it
 * (`lib/query/topics.ts`) — it used to poll every 4 s while a job ran and every 30 s otherwise.
 */
export function ActivityCard({
	projectId,
	environmentId,
}: {
	projectId: string;
	environmentId: string;
}) {
	const board = useBoard();
	const closeCard = () => board.view.getState().openCard(null);
	const orgSlug = useActiveOrgSlug();
	const env = useEnvironmentStatus();

	// The environment is scope, and the page size is fixed: together they are the whole key; the
	// cursor is the page param. A `jobs` hint invalidates the walk, which refetches from page one,
	// and rows are joined keeping each id once, so a job that moved up is never drawn twice.
	const scope = useMemo(() => ({ projectId, environmentId, limit: PAGE }), [projectId, environmentId]);
	const list = useKeysetList(orpc.canvas.environmentJobs, scope);
	const jobs = list.rows;

	return (
		<SheetCard
			title="Activity"
			eyebrow="Environment"
			icon={<Activity className="h-4 w-4" />}
			description="What has run against this environment, and what is running now."
			actions={
				env.activeJob ? <StatusBadge status="running" tier="live" className="mr-1" /> : null
			}
			onClose={closeCard}
		>
			{/* A switched environment's first page is a skeleton, never the previous environment's
			    rows held over as placeholder data: those would attribute its jobs to this one. */}
			{list.isPending || list.isPlaceholderData ? (
				<ul className="space-y-1" aria-busy="true" aria-label="Loading the activity">
					{[0, 1, 2, 3].map((i) => (
						<li key={i}>
							<Skeleton className="h-7 w-full rounded-none" />
						</li>
					))}
				</ul>
			) : list.query.isError && list.query.data === undefined ? (
				<RegionError
					title="Couldn't load the activity"
					description="This environment's job history did not load."
					onRetry={() => void list.query.refetch()}
				/>
			) : jobs.length === 0 ? (
				<EmptyState
					title="Nothing has run here yet"
					description="Plan or deploy this environment and its jobs will be listed here."
				/>
			) : (
				<div className="space-y-3">
					<JobList jobs={jobs} jobHref={(id) => `${orgHref(orgSlug)}/~/jobs?job=${id}`} />
					<ListFooter list={list} />
				</div>
			)}
		</SheetCard>
	);
}
