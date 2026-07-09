"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Usage card — the org's real consumption this period. Plan-capped resources
// (runner minutes, concurrent jobs, AI credits) render as gauges vs their plan allowance;
// projects and seats are uncapped on paid plans, so they show as plain counts rather than
// misleading full rings. The header CTA is plan-aware: "Upgrade" only on the free plan, a
// plan pill + "Manage" on paid, and nothing at all when billing isn't hosted (self-managed).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info, Zap } from "lucide-react";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@repo/ui/tooltip";
import {
	getAiUsageSummary,
	getBillingSummary,
	getOrgUsage,
} from "@/app/server/actions/billing";
import { globalHref } from "@/lib/routing";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { UsageRing } from "./usage-ring";

/** A gauge row: a metered resource with a real plan allowance. */
interface GaugeRow {
	label: string;
	used: number;
	limit: number;
	unit: string;
	tip: string;
	/** Overrides the right-side readout (used for AI rows — a reset time, not raw counts). */
	readout?: string;
}

/** Humanize the time until an ISO reset ("2h", "1d", "5m", or "soon"). */
function resetsIn(iso: string): string {
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms) || ms <= 0) return "soon";
	const h = Math.floor(ms / 3_600_000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h >= 1) return `${h}h`;
	return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** A plain count stat (uncapped on paid plans, so no gauge). */
interface CountRow {
	label: string;
	value: number;
	tip: string;
}

/** Everything the card renders, resolved from the three usage actions. */
interface UsageData {
	hosted: boolean;
	plan: "community" | "team" | "enterprise";
	gauges: GaugeRow[];
	counts: CountRow[];
}

/** Usage card. `projectCount` is the live project total rolled up from the projects store. */
export function UsageCard({
	orgSlug,
	projectCount,
}: {
	orgSlug: string;
	projectCount: number;
}) {
	const [data, setData] = useState<UsageData | null>(null);

	useEffect(() => {
		let alive = true;
		Promise.all([getOrgUsage(), getBillingSummary(), getAiUsageSummary()])
			.then(([usage, billing, ai]) => {
				if (!alive) return;
				const gauges: GaugeRow[] = [
					{
						label: "Runner minutes",
						used: usage.usedMinutes,
						limit: usage.includedMinutes,
						unit: "min",
						tip: "Managed-runner compute minutes consumed this billing period.",
					},
				];
				// Concurrent jobs is only a gauge when the plan caps it (Enterprise is unlimited).
				if (usage.maxConcurrentJobs !== null) {
					gauges.push({
						label: "Concurrent jobs",
						used: usage.runningJobs,
						limit: usage.maxConcurrentJobs,
						unit: "",
						tip: "Provisioning jobs running at once vs your plan's concurrency limit.",
					});
				}
				if (ai.enabled) {
					// AI is a standalone metered product — show daily + weekly as PERCENTAGES
					// (the ring + "% used"), with the reset time as the readout (never raw credits).
					gauges.push({
						label: "AI · today",
						used: ai.dailyUsed,
						limit: ai.dailyBudget,
						unit: "",
						tip: "Included AI credits used today vs your AI tier's daily allowance.",
						readout: `resets ${resetsIn(ai.dailyResetAt)}`,
					});
					gauges.push({
						label: "AI · this week",
						used: ai.weeklyUsed,
						limit: ai.weeklyBudget,
						unit: "",
						tip: "Included AI credits used this week vs your AI tier's weekly allowance.",
						readout: `resets ${resetsIn(ai.weeklyResetAt)}`,
					});
				}

				const counts: CountRow[] = [
					{
						label: "Projects",
						value: projectCount,
						tip: "Infrastructure configurations in this organization.",
					},
					{
						label: "Seats",
						value: billing.memberCount,
						tip: "Members occupying a seat in this organization.",
					},
				];

				setData({ hosted: billing.hosted, plan: billing.plan, gauges, counts });
			})
			.catch(() => {
				if (alive) setData(null);
			});
		return () => {
			alive = false;
		};
	}, [projectCount]);

	return (
		<div className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Usage</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					Last 30 days
				</span>
				{data && <UsageHeaderCta orgSlug={orgSlug} data={data} />}
			</div>

			<div className="px-4">
				{data === null ? (
					<div className="space-y-3 py-3">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-10 w-full rounded-md" />
						))}
					</div>
				) : (
					<>
						{data.gauges.map((g) => (
							<UsageMeter key={g.label} row={g} />
						))}
						{data.counts.length > 0 && (
							<div className="grid grid-cols-2 gap-3 border-t py-3">
								{data.counts.map((c) => (
									<CountStat key={c.label} row={c} />
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/** Plan-aware header CTA: Upgrade (free), plan pill + Manage (paid), nothing (self-managed). */
/** Free-plan header CTA — opens the in-place Pro upgrade sheet (not a route to billing). */
function UpgradeCta() {
	const { openUpgrade } = useUpgradeSheet();
	return (
		<Button
			variant="outline"
			size="xs"
			className="ml-auto gap-1.5 text-xs"
			onClick={openUpgrade}
		>
			<Zap className="h-3 w-3" />
			Upgrade
		</Button>
	);
}

function UsageHeaderCta({
	orgSlug,
	data,
}: {
	orgSlug: string;
	data: UsageData;
}) {
	if (!data.hosted) return null;
	const billingHref = globalHref(orgSlug, "settings/billing");

	if (data.plan === "community") {
		return <UpgradeCta />;
	}

	return (
		<div className="ml-auto flex items-center gap-2">
			<span className="rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
				{planMeta(data.plan).name}
			</span>
			<Link
				href={billingHref}
				className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
			>
				Manage →
			</Link>
		</div>
	);
}

/** One gauge row: ring + label (with info tooltip) + used/limit readout. */
function UsageMeter({ row }: { row: GaugeRow }) {
	const pct = row.limit > 0 ? Math.round((row.used / row.limit) * 100) : 0;
	const near = pct >= 85;
	return (
		<div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
			<UsageRing used={row.used} limit={row.limit} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5 text-[13px] text-foreground">
					{row.label}
					<MetricTip tip={row.tip} />
				</div>
				<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
					{pct}% used
				</div>
			</div>
			<div
				className={`font-mono text-xs ${near ? "font-semibold text-foreground" : "text-muted-foreground"}`}
			>
				{row.readout ??
					`${row.used.toLocaleString()} / ${row.limit.toLocaleString()}${row.unit ? ` ${row.unit}` : ""}`}
			</div>
		</div>
	);
}

/** A compact count stat — a big number + label, no gauge (uncapped on paid plans). */
function CountStat({ row }: { row: CountRow }) {
	return (
		<div className="rounded-md border bg-muted/20 px-3 py-2">
			<div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
				{row.label}
				<MetricTip tip={row.tip} />
			</div>
			<div className="mt-0.5 font-display text-lg font-semibold tabular-nums">
				{row.value.toLocaleString()}
			</div>
		</div>
	);
}

/** The shared info-tooltip glyph next to a metric label. */
function MetricTip({ tip }: { tip: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex cursor-default text-muted-foreground/60 hover:text-muted-foreground">
					<Info className="h-3 w-3" />
				</span>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-[200px] text-xs">
				{tip}
			</TooltipContent>
		</Tooltip>
	);
}
