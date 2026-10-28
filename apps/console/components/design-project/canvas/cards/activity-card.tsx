"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge } from "@repo/ui/status-badge";
import { RegionError } from "@/components/errors/region-error";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { orpc } from "@/lib/rpc/client";
import { orgHref } from "@/lib/routing";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { JobList } from "./job-list";
import { SheetCard } from "./sheet-card";

/** Rows per page. Small: the card is one column, and "Show more" is one click. */
const PAGE = 20;

/**
 * The environment's activity — what has run against this board and what is running now — as a
 * card on the workspace rail, paged.
 *
 * This replaces a floating list pinned to the board's top-left corner that showed the newest
 * eight jobs with no scroll, no paging and no route to the rest: an environment's history ended
 * wherever the list did, over the cards it was about. Here it pages on a keyset cursor and
 * follows the environment: the read is the `canvas.environmentJobs` GET procedure, and a job that is
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
	const closeCard = useCanvasStore((s) => s.closeCard);
	const orgSlug = useActiveOrgSlug();
	const env = useEnvironmentStatus();

	const query = useInfiniteQuery(
		orpc.canvas.environmentJobs.infiniteOptions({
			input: (before: string | null) => ({
				projectId,
				environmentId,
				limit: PAGE,
				before: before ?? undefined,
			}),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
		}),
	);

	const jobs = query.data?.pages.flatMap((p) => p.jobs) ?? [];

	// Scrolling to the tail loads the next page; the button stays for keyboards and for a page
	// whose tail is already in view.
	const sentinel = useRef<HTMLDivElement | null>(null);
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
	useEffect(() => {
		const el = sentinel.current;
		if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
		});
		io.observe(el);
		return () => io.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
			{query.isPending ? (
				<ul className="space-y-1" aria-busy="true" aria-label="Loading the activity">
					{[0, 1, 2, 3].map((i) => (
						<li key={i}>
							<Skeleton className="h-7 w-full rounded-none" />
						</li>
					))}
				</ul>
			) : query.isError && query.data === undefined ? (
				<RegionError
					title="Couldn't load the activity"
					description="This environment's job history did not load."
					onRetry={() => void query.refetch()}
				/>
			) : jobs.length === 0 ? (
				<EmptyState
					title="Nothing has run here yet"
					description="Plan or deploy this environment and its jobs will be listed here."
				/>
			) : (
				<div className="space-y-3">
					<JobList jobs={jobs} jobHref={(id) => `${orgHref(orgSlug)}/~/jobs?job=${id}`} />
					{hasNextPage && (
						<div ref={sentinel} className="flex justify-center">
							<Button
								size="sm"
								variant="outline"
								disabled={isFetchingNextPage}
								onClick={() => void fetchNextPage()}
							>
								{isFetchingNextPage ? "Loading…" : "Show more"}
							</Button>
						</div>
					)}
				</div>
			)}
		</SheetCard>
	);
}
