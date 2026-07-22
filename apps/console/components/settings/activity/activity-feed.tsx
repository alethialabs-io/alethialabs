"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The natural-language Activity feed. Rows arrive newest-first (already filtered + paginated
// server-side); this groups them by month and renders each as an actor avatar + a humanized
// line — the actor and the action target are bold, the connective is plain. No card chrome:
// a dense, hairline-divided list (grayscale, mono meta) with a "Load more" affordance that
// pages in older rows.

import { format, formatDistanceToNow, parseISO } from "date-fns";
import { Loader2, ScrollText } from "lucide-react";
import { useMemo } from "react";
import type { ActivityRow } from "@/app/server/actions/activity";
import { useInfiniteScrollSentinel } from "@/lib/query/use-infinite-scroll";
import { userInitials } from "@/lib/user-display";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { type ActivityContext, describeEvent } from "./humanize-event";

/** Group rows into month buckets, preserving the incoming (newest-first) order. */
function byMonth(rows: ActivityRow[]): { month: string; rows: ActivityRow[] }[] {
	const out: { month: string; rows: ActivityRow[] }[] = [];
	for (const row of rows) {
		const month = format(parseISO(row.ts), "LLLL yyyy");
		const last = out[out.length - 1];
		if (last && last.month === month) last.rows.push(row);
		else out.push({ month, rows: [row] });
	}
	return out;
}

export function ActivityFeed({
	rows,
	ctx,
	onLoadMore,
	hasMore = false,
	loadingMore = false,
}: {
	rows: ActivityRow[];
	ctx: ActivityContext;
	/** Fetch + append the next page. Omit to disable the "Load more" affordance. */
	onLoadMore?: () => void;
	/** Whether a further page exists (controls the "Load more" button). */
	hasMore?: boolean;
	/** Whether the next page is in flight (button spinner + disabled). */
	loadingMore?: boolean;
}) {
	const groups = useMemo(() => byMonth(rows), [rows]);
	// Auto-pull the next page as the tail scrolls into view; the button below stays as an
	// explicit fallback.
	const sentinelRef = useInfiniteScrollSentinel<HTMLDivElement>({
		hasMore,
		loading: loadingMore,
		onLoadMore: () => onLoadMore?.(),
		resetKey: rows.length,
	});

	if (rows.length === 0) {
		return (
			<div className="rounded-lg bg-surface-sunken px-6 py-16 text-center">
				<ScrollText className="mx-auto mb-3 size-5 text-text-tertiary" />
				<p className="text-[13px] text-text-tertiary">
					No activity matches these filters.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{groups.map((g) => (
				<section key={g.month}>
					<h3 className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">
						{g.month}
					</h3>
					<ul>
						{g.rows.map((row) => {
							const e = describeEvent(row, ctx);
							return (
								<li key={row.id} className="flex items-center gap-2 py-1">
									{row.actorImage ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={row.actorImage}
											alt=""
											className="size-6 shrink-0 rounded-full border border-border object-cover"
										/>
									) : (
										<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-muted font-mono text-[9px] text-text-secondary">
											{userInitials({
												name: row.actorName,
												email: row.actorEmail,
												username: row.actorUsername,
											})}
										</span>
									)}
									<span
										title={e.denied ? (e.detail ?? undefined) : undefined}
										className={cn(
											"min-w-0 flex-1 truncate text-[13px]",
											e.denied ? "text-text-secondary" : "text-text-primary",
										)}
									>
										{e.denied && (
											<span className="mr-1.5 rounded-full border border-border-strong px-1.5 py-px align-middle font-mono text-[9px] uppercase tracking-wide text-text-tertiary">
												Denied
											</span>
										)}
										<strong className="font-semibold text-text-primary">
											{e.actor}
										</strong>{" "}
										{e.lead}
										{e.target && (
											<>
												{" "}
												<strong className="font-semibold text-text-primary">
													{e.target}
												</strong>
											</>
										)}
									</span>
									<time
										dateTime={row.ts}
										title={new Date(row.ts).toLocaleString()}
										className="shrink-0 whitespace-nowrap font-mono text-[11px] text-text-tertiary"
									>
										{formatDistanceToNow(parseISO(row.ts), { addSuffix: true })}
									</time>
								</li>
							);
						})}
					</ul>
				</section>
			))}

			{hasMore && onLoadMore && (
				<div className="flex justify-center pt-1">
					{/* Invisible tail sentinel that drives the auto-load-on-scroll. */}
					<div ref={sentinelRef} aria-hidden className="h-px w-px" />
					<Button
						variant="outline"
						size="sm"
						disabled={loadingMore}
						onClick={onLoadMore}
					>
						{loadingMore && <Loader2 className="size-3.5 animate-spin" />}
						Load more
					</Button>
				</div>
			)}
		</div>
	);
}
