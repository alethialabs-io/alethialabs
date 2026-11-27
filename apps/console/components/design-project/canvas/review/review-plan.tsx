"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMonthlyRate, formatRelative } from "@repo/format";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge } from "@repo/ui/status-badge";
import { useState, type ReactNode } from "react";
import { RegionError } from "@repo/ui/region-error";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import type { PlanResource } from "@/lib/plan/parse-plan";
import { countOf, planCountsSentence } from "./changeset-status";
import { JobLink } from "./job-link";
import type { ReviewController } from "./use-review";

/** How many resources are listed before the rest are folded behind "Show all". */
const RESOURCES_SHOWN = 8;

/** A planned action's mark and word. */
const ACTION: Record<PlanResource["action"], { glyph: string; word: string; rank: number }> = {
	delete: { glyph: "−", word: "Destroy", rank: 0 },
	replace: { glyph: "±", word: "Replace", rank: 1 },
	update: { glyph: "~", word: "Change", rank: 2 },
	create: { glyph: "+", word: "Add", rank: 3 },
	"no-op": { glyph: "·", word: "Keep", rank: 4 },
};

/** The plan's resources, the ones a deploy cannot give back first. */
function byConsequence(resources: readonly PlanResource[]): PlanResource[] {
	return [...resources].sort((a, b) => ACTION[a.action].rank - ACTION[b.action].rank);
}

/**
 * Step two of the review: the plan. It says where the environment's latest plan stands — none,
 * queued, running, failed, or finished with its counts, its resources and its cost — and holds the
 * one button that makes a new one. Run plan saves the design first; the button's caption says so.
 */
export function ReviewPlanStep({ review }: { review: ReviewController }) {
	const { phase, server } = review;
	const pendingCount = review.changes.length;
	const hasPlan = phase !== "none" && phase !== "loading" && phase !== "unknown";
	// The primary button of the view is whichever step the person is on: Run plan until there is a
	// current plan, Deploy after.
	const planIsNext = phase !== "current" || pendingCount > 0;

	return (
		<div className="space-y-3">
			<PlanStatus review={review} />

			{review.planRefusal && (
				<Alert variant="destructive">
					<AlertDescription>
						The plan was not queued. {review.planRefusal}
					</AlertDescription>
				</Alert>
			)}
			{review.draftMoved && (
				<Alert>
					<AlertDescription>
						The design changed while it was being saved, so the plan that was queued is of the
						earlier design. Run the plan again to include the newer changes.
					</AlertDescription>
				</Alert>
			)}

			{phase !== "loading" && phase !== "unknown" && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<DisabledReason reason={review.planBlocked?.reason}>
						<Button
							type="button"
							size="sm"
							variant={planIsNext ? "default" : "outline"}
							aria-busy={review.planPending}
							disabled={review.planPending}
							onClick={review.runPlan}
						>
							{review.planPending
								? "Saving and queueing…"
								: hasPlan
									? "Run plan again"
									: "Run plan"}
						</Button>
					</DisabledReason>
					<p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
						{review.planBlocked
							? review.planBlocked.reason
							: pendingCount > 0
								? `Saves your ${countOf(pendingCount, "change")} to this environment, then plans. Nothing is created.`
								: "Plans the saved design. Nothing is created."}
					</p>
				</div>
			)}
			{server?.planJobId && (phase === "waiting" || phase === "running") && (
				<JobLink jobId={server.planJobId} variant="link">
					View the plan log
				</JobLink>
			)}
		</div>
	);
}

/** Where the latest plan stands, and what it found. */
function PlanStatus({ review }: { review: ReviewController }) {
	const { phase, server } = review;
	switch (phase) {
		case "loading":
			return (
				<SkeletonRoot className="space-y-2" aria-label="Loading the latest plan">
					<Skeleton className="h-4 w-2/3 rounded-none" />
					<Skeleton className="h-4 w-1/2 rounded-none" />
				</SkeletonRoot>
			);
		case "unknown":
			return (
				<RegionError
					title="Couldn't load the latest plan"
					description="Whether this environment has a plan to deploy did not load."
					onRetry={review.retryRead}
				/>
			);
		case "none":
			return (
				<p className="text-ui-md text-muted-foreground">
					No plan yet. A plan works out what would be added, changed and destroyed in your cloud,
					and what it would cost, without creating anything.
				</p>
			);
		case "waiting":
			return (
				<PlanLine
					badge={<StatusBadge status="queued" label="Queued" />}
					text="The plan is queued. It starts when a runner picks it up."
				/>
			);
		case "running":
			return (
				<PlanLine
					badge={<StatusBadge status="running" tier="live" label="Running" />}
					text="Working out what would change. This usually takes a few minutes; you can keep working."
				/>
			);
		case "failed":
			return (
				<div className="space-y-1.5">
					<PlanLine
						badge={<StatusBadge status="failed" label="Failed" />}
						text="The plan failed, so there is nothing to deploy."
					/>
					{review.planError && (
						<p className="break-words border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-ui-xs">
							{review.planError}
						</p>
					)}
					{server?.planJobId && (
						<JobLink jobId={server.planJobId} variant="link">
							View the plan log
						</JobLink>
					)}
				</div>
			);
		case "cancelled":
			return (
				<PlanLine
					badge={<StatusBadge status="cancelled" label="Cancelled" />}
					text="The plan was cancelled before it finished."
				/>
			);
		case "current":
		case "design-changed":
		case "run-since":
			return <PlanResult review={review} />;
	}
}

/** One status line: a badge and a sentence. */
function PlanLine({ badge, text }: { badge: ReactNode; text: string }) {
	return (
		<div className="flex items-start gap-2.5">
			<span className="mt-0.5 shrink-0">{badge}</span>
			<p className="min-w-0 flex-1 text-ui-md">{text}</p>
		</div>
	);
}

/** A finished plan: whether it is still the one to deploy, its counts, its resources, its cost. */
function PlanResult({ review }: { review: ReviewController }) {
	const { phase, server, resources } = review;
	const [showAll, setShowAll] = useState(false);
	if (!server) return null;
	const ran = server.createdAt ? `ran ${formatRelative(server.createdAt)}` : null;
	const standing =
		phase === "current"
			? { badge: <StatusBadge status="active" label="Current" />, text: "This plan is of the saved design." }
			: phase === "design-changed"
				? {
						badge: <StatusBadge status="idle" label="Out of date" />,
						text: "The design was saved after this plan ran.",
					}
				: {
						badge: <StatusBadge status="idle" label="Out of date" />,
						text: "Something ran on this environment after this plan.",
					};
	const ordered = resources.state === "ready" ? byConsequence(resources.resources) : [];
	const visible = showAll ? ordered : ordered.slice(0, RESOURCES_SHOWN);

	return (
		<div className="space-y-3">
			<PlanLine badge={standing.badge} text={ran ? `${standing.text} It ${ran}.` : standing.text} />

			<p className="text-ui-md" data-testid="plan-counts">
				{server.summary
					? planCountsSentence(server.summary)
					: "This plan stored no summary of its changes."}
			</p>

			{resources.state === "loading" && (
				<SkeletonRoot className="space-y-1.5" aria-label="Loading the plan's resources">
					<Skeleton className="h-6 w-full rounded-none" />
					<Skeleton className="h-6 w-full rounded-none" />
					<Skeleton className="h-6 w-full rounded-none" />
				</SkeletonRoot>
			)}
			{resources.state === "error" && (
				<p className="text-ui-sm text-muted-foreground">
					The list of resources did not load. The counts above come from the plan itself, and the
					plan log has every resource.
				</p>
			)}
			{resources.state === "ready" && ordered.length === 0 && (
				<p className="text-ui-sm text-muted-foreground">
					This plan changes nothing: what is running already matches the design.
				</p>
			)}
			{visible.length > 0 && (
				<ul className="space-y-1" aria-label="What the plan would change">
					{visible.map((resource) => (
						<li
							key={resource.address}
							className="flex items-center gap-2 border border-border bg-surface-sunken px-2.5 py-1.5"
						>
							<span
								aria-hidden
								className="flex size-4 shrink-0 items-center justify-center border border-border font-mono text-ui-xs leading-none text-muted-foreground"
							>
								{ACTION[resource.action].glyph}
							</span>
							<span className="w-14 shrink-0 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
								{ACTION[resource.action].word}
							</span>
							<span className="shrink-0 text-ui-sm">{resource.displayName}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-muted-foreground" title={resource.address}>
								{resource.address}
							</span>
						</li>
					))}
				</ul>
			)}
			{ordered.length > RESOURCES_SHOWN && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-expanded={showAll}
					onClick={() => setShowAll((all) => !all)}
				>
					{showAll ? "Show fewer" : `Show all ${ordered.length} resources`}
				</Button>
			)}

			<p className="text-ui-md">
				<span className="text-muted-foreground">Cost after this plan: </span>
				{server.cost && server.cost.totalMonthly !== null
					? formatMonthlyRate(server.cost.totalMonthly, "exact", server.cost.currency)
					: "not priced. This plan has no cost estimate."}
			</p>
		</div>
	);
}
