"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	type InfiniteData,
	useInfiniteQuery,
} from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	type EnvironmentJobsPage,
	getEnvironmentJobs,
} from "@/app/server/actions/canvas-jobs";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { qk } from "@/lib/query/keys";
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
 * follows the environment — polling fast while a job runs, a slow heartbeat once it settles.
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

	const query = useInfiniteQuery<
		EnvironmentJobsPage,
		Error,
		InfiniteData<EnvironmentJobsPage, string | null>,
		ReturnType<typeof qk.environmentJobs>,
		string | null
	>({
		queryKey: qk.environmentJobs(projectId, environmentId),
		queryFn: ({ pageParam }) =>
			getEnvironmentJobs(projectId, environmentId, {
				limit: PAGE,
				before: pageParam ?? undefined,
			}),
		initialPageParam: null,
		getNextPageParam: (last) => last.nextCursor,
		refetchInterval: env.activeJob ? 4_000 : 30_000,
	});

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
				<p className="text-xs text-muted-foreground">Loading…</p>
			) : query.isError ? (
				<EmptyState
					title="Could not load the activity"
					description={query.error.message}
					action={
						<Button size="sm" variant="outline" onClick={() => void query.refetch()}>
							Retry
						</Button>
					}
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
