"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-PROJECT Usage panel — the project analogue of usage-panel.tsx. Shows only what is
// genuinely scopeable to one project: its jobs, managed runner job-minutes, clusters, estimated
// cloud cost, and AI credits attributed via ref_id (best-effort — see the footnote). Org-wide
// meters (seats, plan limits, provisioned-runner hours) are NOT per-project, so we link out to
// the organization usage report for them. Data comes from the project-usage server actions
// through the shared TanStack cache (period-fixed reads are server-prefetched + hydrated; the
// over-time chart re-queries as the range picker changes).

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Info } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
	getProjectAiUsage,
	getProjectResourceCounts,
	getProjectUsage,
	getProjectUsageOverTime,
} from "@/app/server/actions/project-usage";
import { ErrorState } from "@/components/errors/error-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Bars, Stat } from "@/components/settings/usage/usage-primitives";
import { qk } from "@/lib/query/keys";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";

type Metric = "runnerMinutes" | "jobs" | "aiCredits";
const METRICS: { id: Metric; label: string }[] = [
	{ id: "runnerMinutes", label: "Runner minutes" },
	{ id: "jobs", label: "Jobs" },
	{ id: "aiCredits", label: "AI credits" },
];

/** Formats a USD amount with no decimals (e.g. "$1,240"). */
function currency(n: number): string {
	return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * Renders the Usage view for a single project. `projectId` is resolved from the URL slug in
 * the server page; every read is tenant-guarded server-side against the actor's active org.
 */
export function ProjectUsagePanel({ projectId }: { projectId: string }) {
	const orgSlug = useActiveOrgSlug();

	const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days",
	);
	const [metric, setMetric] = useState<Metric>("runnerMinutes");

	// Period-fixed reads (server-prefetched + hydrated): runner job-minutes, resource counts, AI.
	const usage = useQuery({
		queryKey: [...qk.projectUsage(projectId), "report"] as const,
		queryFn: () => getProjectUsage(projectId),
	});
	const counts = useQuery({
		queryKey: [...qk.projectUsage(projectId), "counts"] as const,
		queryFn: () => getProjectResourceCounts(projectId),
	});
	const ai = useQuery({
		queryKey: [...qk.projectUsage(projectId), "ai"] as const,
		queryFn: () => getProjectAiUsage(projectId),
	});

	// Range-driven over-time series — re-queries whenever the window changes.
	const overTime = useQuery({
		queryKey: qk.projectUsageOverTime(
			projectId,
			range.from.toISOString(),
			range.to.toISOString(),
		),
		queryFn: () =>
			getProjectUsageOverTime(projectId, {
				from: range.from.toISOString(),
				to: range.to.toISOString(),
			}),
	});

	const metricTotal = useMemo(
		() => overTime.data?.totals[metric] ?? 0,
		[overTime.data, metric],
	);

	if (usage.isLoading && !usage.data) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// A fetch failure must not read as "no usage" (dashes everywhere) — surface it with a retry
	// that refetches every read the panel needs.
	if (usage.isError && !usage.data) {
		return (
			<ErrorState
				title="Couldn't load usage"
				description="Something went wrong fetching this project's usage. Check your connection and try again."
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void usage.refetch();
							void counts.refetch();
							void ai.refetch();
							void overTime.refetch();
						}}
					>
						Retry
					</Button>
				}
			/>
		);
	}

	return (
		<div className="space-y-2">
			{/* Header: scope + the link out to org-wide usage. */}
			<div className="flex flex-wrap items-center justify-between gap-3 pb-2">
				<span className="font-display text-[15px] font-semibold text-text-primary">
					Project usage
				</span>
				<Link
					href={globalHref(orgSlug, "usage")}
					className="inline-flex items-center gap-1 text-[12.5px] text-text-secondary transition-colors hover:text-text-primary"
				>
					View organization usage
					<ArrowUpRight size={13} />
				</Link>
			</div>

			{/* Resources — the current scale of what this project runs. */}
			<SettingsSection title="Resources">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-2 sm:grid-cols-4">
						<Stat
							label="Jobs"
							value={overTime.data ? overTime.data.totals.jobs.toLocaleString() : "—"}
							sub={rangeLabel.toLowerCase()}
						/>
						<Stat
							label="Running"
							value={usage.data?.runningJobs ?? "—"}
							sub="jobs in flight"
						/>
						<Stat
							label="Clusters"
							value={counts.data?.clusters ?? "—"}
							sub="under management"
						/>
					</div>
					<div className="flex items-center justify-between border-t border-border bg-surface-sunken px-6 py-[14px] text-[12px] text-text-tertiary">
						<span className="flex items-center gap-2">
							<Info size={13} />
							Estimated cloud spend for this project
						</span>
						<span className="font-mono text-text-secondary">
							{counts.data ? currency(counts.data.estimatedMonthlyCost) : "—"}/mo
						</span>
					</div>
				</div>
			</SettingsSection>

			{/* Runner job-minutes + AI credits — the metered, project-attributable units. */}
			<SettingsSection title="Metered usage this period">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-1 sm:grid-cols-2">
						<Stat
							label="Runner job-minutes"
							value={
								usage.data ? Math.round(usage.data.jobMinutes).toLocaleString() : "—"
							}
							sub={
								usage.data
									? `${usage.data.jobCount.toLocaleString()} managed jobs this period`
									: "managed runner usage this period"
							}
						/>
						<Stat
							label="AI credits used"
							value={
								ai.data ? ai.data.creditsThisPeriod.toLocaleString() : "—"
							}
							sub="attributed to this project *"
						/>
					</div>
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-[12px] text-text-tertiary">
						<Info size={13} />
						<span>
							* AI credits are attributed to a project via the scan job or agent thread
							that spent them; usage that isn&apos;t tied to a project (e.g. support
							Ask&nbsp;AI) is counted only at the organization level.
						</span>
					</div>
				</div>
			</SettingsSection>

			{/* Usage over time — cumulative, driven by the time-range filters. */}
			<SettingsSection
				title="Usage over time"
				action={
					<div className="flex flex-wrap items-center gap-2">
						<QuickRangeFilter
							label={rangeLabel}
							value={range}
							onChange={(r, l) => {
								setRange(r);
								setRangeLabel(l);
							}}
						/>
						<DateRangeFilter
							value={range}
							onChange={(r) => {
								setRange(r);
								setRangeLabel(formatRangeLabel(r));
							}}
						/>
					</div>
				}
			>
				<div className="overflow-hidden rounded-lg border border-border bg-surface p-5 shadow-sm">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div className="flex gap-1">
							{METRICS.map((m) => (
								<button
									key={m.id}
									type="button"
									onClick={() => setMetric(m.id)}
									className={`rounded-sm px-2.5 py-1 text-[12px] transition-colors ${
										metric === m.id
											? "bg-surface-muted text-text-primary"
											: "text-text-tertiary hover:text-text-secondary"
									}`}
								>
									{m.label}
								</button>
							))}
						</div>
						<div className="font-mono text-[12px] text-text-secondary">
							{metricTotal.toLocaleString()}{" "}
							<span className="text-text-tertiary">
								{METRICS.find((m) => m.id === metric)?.label.toLowerCase()} ·{" "}
								{rangeLabel.toLowerCase()}
							</span>
						</div>
					</div>
					{overTime.data && overTime.data.series.length > 0 ? (
						<Bars points={overTime.data.series} pick={(p) => p[metric]} />
					) : (
						<div className="flex h-28 items-center justify-center font-mono text-[11px] text-text-tertiary">
							No usage in this range.
						</div>
					)}
				</div>
			</SettingsSection>

			<p className="px-1 pt-1 text-[12px] text-text-tertiary">
				Seats, plan limits, and provisioned-runner hours are billed org-wide —{" "}
				<Link
					href={globalHref(orgSlug, "usage")}
					className="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
				>
					view organization usage
				</Link>
				.
			</p>
		</div>
	);
}
