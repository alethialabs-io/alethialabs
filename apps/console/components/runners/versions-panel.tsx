"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Versions panel (left column): the latest runner release, an "updates available" action
// that rolls every outdated deployed runner, and a changelog of recent releases. Replaces
// the old top-of-page updates banner.

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { Skeleton } from "@repo/ui/skeleton";
import { RegionError } from "@/components/errors/region-error";
import { isForbidden } from "@/components/overview/overview-reads";
import { ClockSlot } from "@/components/overview/clock-slot";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { useRunnersQuery, useUpdateAllOutdated } from "@/lib/query/use-runners-query";
import { formatRelative } from "@repo/format";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

const MONO_LABEL = "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

/** The widest relative time the panel normally prints, so its slot holds that width before hydration. */
const RELATIVE_SIZER = "less than a minute ago";

/** A clickable version label that opens the release-notes popover. */
function VersionLink({ version }: { version: string }) {
	return (
		<ReleaseNotesPopover version={version}>
			<button
				type="button"
				className="cursor-pointer font-mono text-xs font-medium text-foreground transition-colors hover:underline"
			>
				v{version}
			</button>
		</ReleaseNotesPopover>
	);
}

/**
 * The Versions panel. Reads the runners universe (`runners.list`), which carries the latest release
 * and the changelog too — prefetched by the route, so it paints with data and fetches nothing on
 * mount (the changelog used to be fetched in an effect after the first paint).
 */
export function VersionsPanel() {
	const { data: runnersData, isPending, isError, error, refetch } = useRunnersQuery();
	const runners = runnersData?.runners;
	const latestRelease = runnersData?.latestRelease ?? null;
	const releases = runnersData?.releases ?? [];
	const updateAll = useUpdateAllOutdated();

	// Runners not on the latest release, and the subset we can roll in place (deployed, i.e. have a
	// deploy config). UPDATE re-mints a fresh token, so no stored token is needed. The rest need a
	// manual re-deploy.
	const { outdated, updatable } = useMemo(() => {
		if (!latestRelease || !runners) return { outdated: 0, updatable: Array<string>() };
		const out = runners.filter((r) => r.version && r.version !== latestRelease.version);
		const upd = out.filter((r) => r.in_place);
		return { outdated: out.length, updatable: upd.map((r) => r.id) };
	}, [runners, latestRelease]);

	const handleUpdateAll = () => {
		updateAll.mutate(updatable, {
			onSuccess: ({ queued, failed }) => {
				if (failed === 0) toast.success(`${queued} update${queued !== 1 ? "s" : ""} queued`);
				else toast.warning(`${queued} queued, ${failed} failed`);
			},
		});
	};

	if (isPending) return <VersionsPanelSkeleton />;
	if (isError) {
		return (
			<section className="space-y-3">
				<span className="text-sm font-semibold tracking-tight text-foreground">Versions</span>
				{isForbidden(error) ? (
					// An expected refusal, not a failure: no retry that would answer the same (RUBRIC B4).
					<p className="text-xs text-muted-foreground">You don&rsquo;t have access to runner versions.</p>
				) : (
					<RegionError
						title="Couldn't load runner versions"
						description="Something went wrong fetching the runner releases. Try again."
						onRetry={() => void refetch()}
					/>
				)}
			</section>
		);
	}

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-semibold tracking-tight text-foreground">Versions</span>
				{latestRelease && (
					<span className={MONO_LABEL}>latest v{latestRelease.version}</span>
				)}
			</div>

			<Card className="gap-0 overflow-hidden py-0">
				{/* latest release */}
				{latestRelease ? (
					<div className="flex flex-col gap-2 border-b border-border p-4">
						<span className={MONO_LABEL}>Latest release</span>
						<div className="flex items-center gap-2">
							<VersionLink version={latestRelease.version} />
							{latestRelease.is_breaking && (
								<Badge variant="destructive" className="py-0 text-ui-2xs">
									Breaking
								</Badge>
							)}
						</div>
						<span className="text-ui-xs text-muted-foreground">
							Released{" "}
							<ClockSlot sizer={RELATIVE_SIZER} render={() => formatRelative(latestRelease.released_at)} />
						</span>
					</div>
				) : (
					<div className="p-4 text-xs text-muted-foreground">No runner releases yet.</div>
				)}

				{/* updates available */}
				{outdated > 0 && latestRelease && (
					<div className="flex items-start gap-2.5 border-b border-border bg-muted/40 p-4">
						<ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
						<div className="min-w-0 flex-1 space-y-2">
							<p className="text-xs text-foreground">
								<strong>
									{outdated} runner{outdated !== 1 ? "s" : ""}
								</strong>{" "}
								behind v{latestRelease.version}
								{outdated > updatable.length && (
									<span className="text-muted-foreground">
										{" "}
										· {outdated - updatable.length} need re-deploy
									</span>
								)}
							</p>
							{updatable.length > 0 && (
								<Button
									size="sm"
									variant="outline"
									className="h-7 text-xs"
									disabled={updateAll.isPending}
									onClick={handleUpdateAll}
								>
									{updateAll.isPending ? (
										<>
											<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
											Updating…
										</>
									) : (
										<>Update all ({updatable.length})</>
									)}
								</Button>
							)}
						</div>
					</div>
				)}

				{/* changelog */}
				<div className="flex flex-col">
					<div className={`${MONO_LABEL} px-4 pb-1 pt-3`}>Changelog</div>
					{releases.length === 0 ? (
						<div className="px-4 pb-4 pt-1 text-xs text-muted-foreground">No releases.</div>
					) : (
						<ul className="pb-2">
							{releases.map((r) => (
								<li
									key={r.version}
									className="flex items-center justify-between gap-2 px-4 py-1.5"
								>
									<VersionLink version={r.version} />
									<div className="flex items-center gap-2">
										{r.is_breaking && (
											<Badge variant="outline" className="border-border bg-muted py-0 text-ui-3xs text-muted-foreground">
												Breaking
											</Badge>
										)}
										<ClockSlot
											sizer={RELATIVE_SIZER}
											className="font-mono text-ui-2xs text-muted-foreground"
											render={() => formatRelative(r.released_at)}
										/>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</Card>
		</section>
	);
}

/** The panel's pending render: its header, the latest-release block and a changelog of rows. */
export function VersionsPanelSkeleton() {
	return (
		<section className="space-y-3" aria-busy="true">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-semibold tracking-tight text-foreground">Versions</span>
				<Skeleton className="h-3 w-20" />
			</div>
			<Card className="gap-0 overflow-hidden py-0">
				<div className="flex flex-col gap-2 border-b border-border p-4">
					<Skeleton className="h-2.5 w-24" />
					<Skeleton className="h-4 w-16" />
					<Skeleton className="h-3 w-32" />
				</div>
				<div className="space-y-2 px-4 pb-4 pt-3">
					<Skeleton className="h-2.5 w-20" />
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-4 w-full" />
					))}
				</div>
			</Card>
		</section>
	);
}
