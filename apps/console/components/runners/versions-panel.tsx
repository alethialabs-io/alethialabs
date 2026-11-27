"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Versions panel (left column): the latest runner release, an "updates available" action
// that rolls every outdated deployed runner, and a changelog of recent releases. Replaces
// the old top-of-page updates banner.

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { RegionError } from "@repo/ui/region-error";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { isForbidden } from "@/components/overview/overview-reads";
import { ClockSlot } from "@/components/overview/clock-slot";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { type RunnerRef, useRunnersQuery, useUpdateAllOutdated } from "@/lib/query/use-runners-query";
import { formatRelative } from "@repo/format";
import { ArrowUpCircle } from "lucide-react";
import { useMemo, useState } from "react";
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

	const [confirmOpen, setConfirmOpen] = useState(false);

	// Runners not on the latest release, and the subset we can roll in place (deployed, i.e. have a
	// deploy config). UPDATE re-mints a fresh token, so no stored token is needed. The rest need a
	// manual re-deploy.
	const { outdated, updatable } = useMemo(() => {
		if (!latestRelease || !runners) return { outdated: 0, updatable: Array<RunnerRef>() };
		const out = runners.filter((r) => r.version && r.version !== latestRelease.version);
		const upd = out.filter((r) => r.in_place);
		return { outdated: out.length, updatable: upd.map((r) => ({ id: r.id, name: r.name })) };
	}, [runners, latestRelease]);

	// "Update all" queues one job per runner, so it is confirmed first, naming the runners it will
	// touch. The confirmation runs the batch itself and closes only once it has been sent; the
	// outcome (all queued, or which runners were not) is one toast.
	const confirmable = {
		isPending: updateAll.isPending,
		mutate: (batch: RunnerRef[], options?: { onSuccess?: () => void; onSettled?: () => void }) => {
			updateAll.mutate(batch, {
				onSuccess: ({ queued, failed }) => {
					if (failed.length === 0)
						toast.success(`${queued.length} update${queued.length !== 1 ? "s" : ""} queued`);
					else toast.warning(updateAllPartialMessage(queued.length, failed.map((r) => r.name)));
					options?.onSuccess?.();
				},
				onSettled: options?.onSettled,
			});
		},
	};

	if (isPending) return <VersionsPanelSkeleton />;
	if (isError) {
		return (
			<section className="space-y-3">
				<SectionHeading title="Versions" />
				{isForbidden(error) ? (
					// An expected refusal, not a failure: no retry that would answer the same (RUBRIC B4).
					<RegionRefusal compact refusal="forbidden" subject="runner versions" />
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
			<SectionHeading
				title="Versions"
				actions={latestRelease ? <span className={MONO_LABEL}>latest v{latestRelease.version}</span> : undefined}
			/>

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
									pending={updateAll.isPending}
									onClick={() => setConfirmOpen(true)}
								>
									{updateAll.isPending
										? `Updating ${updatable.length} runner${updatable.length !== 1 ? "s" : ""}…`
										: `Update all (${updatable.length})`}
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

			{latestRelease && (
				<ConfirmAction
					open={confirmOpen}
					onOpenChange={setConfirmOpen}
					title={`Update ${updatable.length} runner${updatable.length !== 1 ? "s" : ""} to v${latestRelease.version}?`}
					description={updateAllDescription(updatable.map((r) => r.name), latestRelease.version)}
					confirmLabel={`Update ${updatable.length}`}
					pendingLabel="Queueing updates…"
					severity={{ level: "confirm" }}
					mutation={confirmable}
					variables={confirmOpen ? updatable : null}
				/>
			)}
		</section>
	);
}

/** How many runner names the confirmation spells out before it says "and N more". */
const NAMED_IN_CONFIRM = 8;

/**
 * The "Update all" confirmation's sentence: which runners get an update job, and what that does.
 * Names up to {@link NAMED_IN_CONFIRM} runners, then counts the rest.
 */
export function updateAllDescription(names: readonly string[], version: string): string {
	return `This queues an update job for each of: ${nameList(names)}. Each runner moves to v${version} when its update job runs.`;
}

/** Up to {@link NAMED_IN_CONFIRM} runner names, comma-separated, then "and N more". */
function nameList(names: readonly string[]): string {
	const shown = names.slice(0, NAMED_IN_CONFIRM).join(", ");
	const rest = names.length - NAMED_IN_CONFIRM;
	return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * The partial-failure toast of "Update all": how many of how many were queued, the runners whose
 * update was NOT queued by name (up to {@link NAMED_IN_CONFIRM}, then a count), and what to do.
 */
export function updateAllPartialMessage(queuedCount: number, failedNames: readonly string[]): string {
	const total = queuedCount + failedNames.length;
	return `${queuedCount} of ${total} updates queued. Not queued: ${nameList(failedNames)}. Each keeps its update badge on its card, where it can be updated on its own.`;
}

/** The panel's pending render: its header, the latest-release block and a changelog of rows. */
export function VersionsPanelSkeleton() {
	return (
		<SkeletonRoot>
			<VersionsPanelSkeletonBody />
		</SkeletonRoot>
	);
}

/** The pending panel's drawing, without a root: the page skeleton draws it inside its own. */
export function VersionsPanelSkeletonBody() {
	return (
		<section className="space-y-3">
			<SectionHeading title="Versions" actions={<Skeleton className="h-3 w-20" />} />
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
