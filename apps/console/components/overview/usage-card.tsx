"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Usage card — the org's real consumption. Plan-capped resources (runner minutes,
// concurrent jobs, AI credits) render as gauges vs their plan allowance; projects and seats are
// uncapped on paid plans, so they show as plain counts rather than misleading full rings. The header
// CTA is plan-aware: "Upgrade" only on the free plan, a plan pill + "Manage" on paid, and nothing at
// all when billing isn't hosted (self-managed).
//
// #6118: the read is the `overview.usage` GET procedure, prefetched by the page on the server, so
// the card paints with data. Pending, failed and answered are three renders; a failed read never
// renders as a skeleton forever (RUBRIC B4) and takes down this card only (B5).

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import Link from "next/link";
import { Info, Zap } from "lucide-react";
import { formatDate, formatQuota } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { RegionError } from "@/components/errors/region-error";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { sessionResetLabel, weeklyResetLabel } from "@/lib/billing/ai-usage-format";
import { globalHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import type { OverviewUsage } from "@/lib/rpc/procedures/overview";
import { ClockSlot } from "./clock-slot";
import { retryUnlessRefused } from "./overview-reads";
import { NEAR_LIMIT_RATIO, formatUsagePercent, usageRatio } from "./usage-percent";
import { UsageRing } from "./usage-ring";

/** A gauge row: a metered resource with a real plan allowance. */
interface GaugeRow {
	label: string;
	used: number;
	limit: number;
	unit: string;
	tip: string;
	/**
	 * Overrides the right-side readout for rows whose raw counts are the wrong thing to print —
	 * runner minutes show a humanised duration rather than the unrounded float the meter holds.
	 */
	readout?: string;
	/**
	 * A readout that reads the clock (the AI rows' reset times). It renders after hydration only, in
	 * a slot `clockSizer` wide — see `ClockSlot`.
	 */
	clock?: () => string;
	clockSizer?: string;
}

/** A plain count stat (uncapped on paid plans, so no gauge). */
interface CountRow {
	label: string;
	value: number;
	tip: string;
}

/**
 * A count (seats, projects, jobs in flight). Printed as plain digits on purpose: a bare
 * `toLocaleString()` takes the RUNTIME's locale, and the card renders on the server now, so a
 * browser in another locale would hydrate "1.000" against the server's "1,000" (React #418). The
 * runner-minutes allowance — the one number here that reaches four digits — goes through
 * `@repo/format`'s `formatQuota`, whose locale is fixed.
 */
function count(value: number): string {
	return String(value);
}

/** Lowercase a reset label's first word so it fits the mono readout style. */
function asReadout(label: string): string {
	return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The read's options — one value for the card and the Create menu, so both share one cache entry. */
export function overviewUsageQuery() {
	return orpc.overview.usage.queryOptions({ retry: retryUnlessRefused });
}

/**
 * What the header caption says the numbers cover. The runner-minutes gauge — the only windowed
 * gauge — counts from the start of the CURRENT BILLING PERIOD (`getOrgUsage`), not over a trailing
 * 30 days, which is what this caption used to claim. The period is anchored in UTC
 * (`effectiveBillingPeriodStart`), so the date is printed in UTC: the same day on the server and in
 * every browser, and the day the billing period actually started.
 */
export function usagePeriodCaption(periodStart: string): string {
	return `Since ${formatDate(periodStart, "date", "UTC")}`;
}

/** The gauges and counts the card renders, derived from the overview's usage read. */
function usageRows(
	data: OverviewUsage,
	projectCount: number,
): { gauges: GaugeRow[]; counts: CountRow[] } {
	const gauges: GaugeRow[] = [
		{
			label: "Runner minutes",
			used: data.runner.usedMinutes,
			limit: data.runner.includedMinutes,
			unit: "min",
			tip: "Managed-runner compute minutes consumed this billing period.",
			// `usedMinutes` is an unrounded float straight out of `extract(epoch from …) / 60.0`, so a
			// plain readout printed "0.943 / 200 min" (#2876). `formatQuota` is the one answer to
			// "used against allowance" — humanised used side, plan minutes on the allowance side.
			readout: formatQuota(data.runner.usedMinutes, data.runner.includedMinutes),
		},
	];
	// Concurrent jobs is only a gauge when the plan caps it (Enterprise is unlimited).
	if (data.concurrency.max !== null) {
		gauges.push({
			label: "Concurrent jobs",
			used: data.concurrency.running,
			limit: data.concurrency.max,
			unit: "",
			tip: "Provisioning jobs running at once vs your plan's concurrency limit.",
		});
	}
	if (data.ai.enabled) {
		// AI is a standalone metered product — the rolling session and the weekly limit as
		// PERCENTAGES (the ring + "% used"), with the reset time as the readout (never raw credits).
		const { sessionResetAt, weeklyResetAt } = data.ai;
		gauges.push({
			label: "AI · current session",
			used: data.ai.sessionUsed,
			limit: data.ai.sessionBudget,
			unit: "",
			tip: "Included AI usage in the trailing 5-hour window vs your plan's session allowance.",
			// A session that has not started has no reset time, so its readout reads no clock: it is
			// data, printed in the server's HTML like every other readout (#6347, RUBRIC B1). Only a
			// running session's countdown waits for hydration.
			...(sessionResetAt === null
				? { readout: asReadout(sessionResetLabel(null)) }
				: { clock: () => asReadout(sessionResetLabel(sessionResetAt)), clockSizer: "resets in 23 hr 59 min" }),
		});
		gauges.push({
			label: "AI · weekly limit",
			used: data.ai.weeklyUsed,
			limit: data.ai.weeklyBudget,
			unit: "",
			tip: "Included AI usage this week vs your plan's fixed weekly allowance.",
			clock: () => asReadout(weeklyResetLabel(weeklyResetAt)),
			clockSizer: "resets Wed 10:59 AM",
		});
	}
	const counts: CountRow[] = [
		{ label: "Projects", value: projectCount, tip: "Infrastructure configurations in this organization." },
		{ label: "Seats", value: data.memberCount, tip: "Members occupying a seat in this organization." },
	];
	return { gauges, counts };
}

/** The card's frame and header strip — shared by every render, the route skeleton included. */
function UsageFrame({ caption, cta, children }: { caption?: string; cta?: ReactNode; children: ReactNode }) {
	return (
		<section aria-label="Usage" className="rounded-lg border bg-surface shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold text-text-primary">Usage</span>
				{caption ? (
					<span className="font-mono text-ui-2xs text-text-tertiary" title="The current billing period (UTC)">
						{caption}
					</span>
				) : null}
				{cta}
			</div>
			{children}
		</section>
	);
}

/** One gauge row's placeholder: the ring and both text lines at their real sizes. */
function MeterSkeleton() {
	return (
		<div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
			<Skeleton className="size-10 shrink-0 rounded-full" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<Skeleton className="h-3.5 w-28" />
				<Skeleton className="h-2.5 w-14" />
			</div>
			<Skeleton className="h-3 w-20" />
		</div>
	);
}

/**
 * How many gauges the pending card draws: runner minutes, concurrent jobs (capped on every plan but
 * Enterprise) and the two AI meters (AI is on every tier, `lib/billing/ai-plan.ts`). It drew two
 * until #6347, and the answered card on the default plan is four tall — the route skeleton's
 * worst-moving block.
 */
const PENDING_GAUGES = 4;

/**
 * The card while its read is pending — the route's `loading.tsx` renders this too, so the swap to
 * the answered card moves nothing but the rows' contents. The gauges every default-plan org sees
 * (`PENDING_GAUGES`) and the counts line, each at its row's real height.
 */
export function UsageCardSkeleton() {
	return (
		<UsageFrame>
			<div className="px-4" aria-busy="true">
				{Array.from({ length: PENDING_GAUGES }, (_, i) => (
					<MeterSkeleton key={i} />
				))}
				<div className="flex items-center gap-x-6 border-t py-3">
					<Skeleton className="h-5 w-20" />
					<Skeleton className="h-5 w-16" />
				</div>
			</div>
		</UsageFrame>
	);
}

/** Usage card. `projectCount` is the org's project total the page resolved on the server. */
export function UsageCard({ orgSlug, projectCount }: { orgSlug: string; projectCount: number }) {
	const usage = useQuery(overviewUsageQuery());

	if (usage.data === undefined) {
		if (usage.isError) {
			return (
				<UsageFrame>
					<RegionError
						title="Couldn't load usage"
						description="Something went wrong loading this organization's usage."
						onRetry={() => usage.refetch()}
					/>
				</UsageFrame>
			);
		}
		return <UsageCardSkeleton />;
	}

	// A failed REFRESH keeps the last answer on screen (TanStack keeps `data`): the numbers the viewer
	// already had are still the newest the console knows.
	const { gauges, counts } = usageRows(usage.data, projectCount);
	return (
		<UsageFrame
			caption={usagePeriodCaption(usage.data.runner.periodStart)}
			cta={<UsageHeaderCta orgSlug={orgSlug} data={usage.data} />}
		>
			<div className="px-4">
				{gauges.map((g) => (
					<UsageMeter key={g.label} row={g} />
				))}
				<div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t py-3">
					{counts.map((c) => (
						<CountReadout key={c.label} row={c} />
					))}
				</div>
			</div>
		</UsageFrame>
	);
}

/** Free-plan header CTA — opens the in-place Pro upgrade sheet (not a route to billing). */
function UpgradeCta() {
	const { openUpgrade } = useUpgradeSheet();
	return (
		<Button variant="outline" size="xs" className="ml-auto gap-1.5 text-xs" onClick={openUpgrade}>
			<Zap className="h-3 w-3" />
			Upgrade
		</Button>
	);
}

/** Plan-aware header CTA: Upgrade (free), plan pill + Manage (paid), nothing (self-managed). */
function UsageHeaderCta({ orgSlug, data }: { orgSlug: string; data: OverviewUsage }) {
	if (!data.hosted) return null;
	if (data.plan === "community") return <UpgradeCta />;
	return (
		<div className="ml-auto flex items-center gap-2">
			<span className="rounded-full border px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
				{planMeta(data.plan).name}
			</span>
			<Link
				href={globalHref(orgSlug, "settings/billing")}
				className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
			>
				Manage →
			</Link>
		</div>
	);
}

/** One gauge row: ring + label (with info tooltip) + used/limit readout. */
function UsageMeter({ row }: { row: GaugeRow }) {
	// Percent and near-limit both come from the shared helpers the ring uses, so the caption, the arc
	// and the ink weight cannot disagree about the same pair of numbers.
	const near = usageRatio(row.used, row.limit) >= NEAR_LIMIT_RATIO;
	return (
		<div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
			<UsageRing used={row.used} limit={row.limit} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5 text-ui-md text-text-primary">
					{row.label}
					<MetricTip tip={row.tip} />
				</div>
				<div className="mt-0.5 font-mono text-ui-2xs text-text-tertiary">
					{formatUsagePercent(row.used, row.limit)}% used
				</div>
			</div>
			<div className={`font-mono text-ui-sm ${near ? "font-semibold text-text-primary" : "text-text-tertiary"}`}>
				{row.clock ? (
					<ClockSlot sizer={row.clockSizer ?? ""} className="justify-items-end" render={row.clock} />
				) : (
					(row.readout ??
					`${count(row.used)} / ${count(row.limit)}${row.unit ? ` ${row.unit}` : ""}`)
				)}
			</div>
		</div>
	);
}

/** A count readout — a label + mono value inline (uncapped on paid plans, so no gauge and no KPI
 * tile: counts live as mono text, not a bordered stat box). */
function CountReadout({ row }: { row: CountRow }) {
	return (
		<div className="flex items-baseline gap-2">
			<span className="flex items-center gap-1 text-ui-sm text-text-secondary">
				{row.label}
				<MetricTip tip={row.tip} />
			</span>
			<span className="font-mono text-ui-md tabular-nums text-text-primary">{count(row.value)}</span>
		</div>
	);
}

/** The shared info-tooltip glyph next to a metric label. */
function MetricTip({ tip }: { tip: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="inline-flex cursor-default text-text-tertiary hover:text-text-secondary">
						<Info className="h-3 w-3" />
					</span>
				}
			/>
			<TooltipContent side="top" className="max-w-[200px] text-xs">
				{tip}
			</TooltipContent>
		</Tooltip>
	);
}
