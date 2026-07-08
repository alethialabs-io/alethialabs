"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Usage page. Defined on a three-kind taxonomy (see lib/usage):
//   • Plan & limits  — point-in-time gauges vs the plan cap this billing period
//                      (seats, runner-minutes, concurrency) + the spend-control hard cap.
//   • Resources      — current scale of what the org runs (projects, clusters, jobs,
//                      and informational spend-under-management — a future FinOps seam).
//   • Usage over time — cumulative metrics across a chosen range (the time-range picker
//                      drives this section): runner-minutes, jobs, AI credits.
//   • AI usage       — its own budget model (weekly window + purchased balance + top-up).
// Hobby orgs get an inline "Upgrade to Pro" (UpgradeOrgSheet); subscription/payment
// management still lives on the Billing page.

import { ArrowUpRight, Info } from "lucide-react";
import Link from "next/link";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	getBillingSummary,
	getOrgUsage,
	getResourceCounts,
	getUsageOverTime,
	type ResourceCountsReport,
	setUsageHardCap,
	type UsageOverTime,
	type UsageReport,
} from "@/app/server/actions/billing";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { AiUsageSection } from "@/components/settings/usage/ai-usage-section";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
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

/** One usage meter cell (key, value, fill %, sub note). */
function Meter({
	label,
	value,
	sub,
	fill,
}: {
	label: string;
	value: ReactNode;
	sub: ReactNode;
	/** 0–100 fill percentage. */
	fill: number;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span className="text-[12.5px] text-text-secondary">{value}</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-[10px] text-text-tertiary">{sub}</div>
		</div>
	);
}

/** A compact resource stat (count + label + optional sub). */
function Stat({
	label,
	value,
	sub,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
				{label}
			</div>
			<div className="mt-1.5 font-display text-[20px] font-semibold tracking-[-0.02em] text-text-primary">
				{value}
			</div>
			{sub && <div className="mt-0.5 font-mono text-[10px] text-text-tertiary">{sub}</div>}
		</div>
	);
}

/** A lightweight CSS bar chart for one over-time metric (no chart dependency). */
function Bars({
	points,
	pick,
}: {
	points: UsageOverTime["series"];
	pick: (p: UsageOverTime["series"][number]) => number;
}) {
	const max = Math.max(1, ...points.map(pick));
	return (
		<div className="flex h-28 items-end gap-px">
			{points.map((p) => {
				const v = pick(p);
				return (
					<div
						key={p.date}
						title={`${p.date}: ${v.toLocaleString()}`}
						className="min-w-[2px] flex-1 rounded-t-[1px] bg-text-primary/80 transition-colors hover:bg-text-primary"
						style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
					/>
				);
			})}
		</div>
	);
}

type Metric = "runnerMinutes" | "jobs" | "aiCredits";
const METRICS: { id: Metric; label: string }[] = [
	{ id: "runnerMinutes", label: "Runner minutes" },
	{ id: "jobs", label: "Jobs" },
	{ id: "aiCredits", label: "AI credits" },
];

export function UsagePanel() {
	const orgSlug = useActiveOrgSlug();
	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [usage, setUsage] = useState<UsageReport | null>(null);
	const [counts, setCounts] = useState<ResourceCountsReport | null>(null);
	const [overTime, setOverTime] = useState<UsageOverTime | null>(null);

	const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days",
	);
	const [metric, setMetric] = useState<Metric>("runnerMinutes");

	const [pending, startTransition] = useTransition();
	const [createOpen, setCreateOpen] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);

	// Period-fixed data (seats, runner-minutes this period, resource counts, AI standing).
	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load usage."));
		getOrgUsage()
			.then(setUsage)
			.catch(() => {
				/* best-effort; the meter just shows a dash */
			});
		getResourceCounts()
			.then(setCounts)
			.catch(() => {
				/* best-effort */
			});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	// Range-driven data (the over-time chart) re-queries whenever the window changes.
	useEffect(() => {
		let active = true;
		getUsageOverTime({ from: range.from.toISOString(), to: range.to.toISOString() })
			.then((d) => active && setOverTime(d))
			.catch(() => {
				/* best-effort */
			});
		return () => {
			active = false;
		};
	}, [range]);

	const metricTotal = useMemo(() => {
		if (!overTime) return 0;
		return overTime.totals[metric];
	}, [overTime, metric]);

	if (!summary) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// Self-managed / community: no Stripe metering — usage is a hosted-billing concept.
	if (!summary.hosted) {
		return (
			<Card className="p-6">
				<h2 className="text-sm font-semibold text-foreground">
					Self-managed deployment
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					This instance isn&apos;t connected to hosted billing, so usage isn&apos;t
					metered here.
				</p>
			</Card>
		);
	}

	// Free user with no org yet: usage is per-organization.
	if (!summary.hasOrg) {
		return (
			<div>
				<Card className="p-6">
					<h2 className="text-sm font-semibold text-foreground">No organization yet</h2>
					<p className="mt-1 max-w-prose text-sm text-muted-foreground">
						Usage is metered per organization. Create one to track seats, runner
						minutes, and AI against a plan.
					</p>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						Create organization
					</Button>
				</Card>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		);
	}

	const isCommunity = summary.plan === "community" || summary.status === "none";
	const seatFill =
		summary.seats != null && summary.seats > 0
			? (summary.memberCount / summary.seats) * 100
			: 100;
	const concurrencyMax = usage?.maxConcurrentJobs ?? null;

	const currency = (n: number) =>
		`$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

	return (
		<div className="space-y-2">
			{/* Header: plan standing + the upgrade / manage affordance. */}
			<div className="flex flex-wrap items-center justify-between gap-3 pb-2">
				<div className="flex items-baseline gap-2">
					<span className="font-display text-[15px] font-semibold text-text-primary">
						{planMeta(summary.plan).name} plan
					</span>
					{usage && (
						<span className="font-mono text-[11px] text-text-tertiary">
							period to {new Date(usage.periodEnd).toLocaleDateString()}
						</span>
					)}
				</div>
				{isCommunity ? (
					<Button size="sm" onClick={() => setUpgradeOpen(true)}>
						Upgrade to Pro
						<ArrowUpRight size={14} />
					</Button>
				) : (
					<Link
						href={`/${orgSlug}/settings/billing`}
						className="inline-flex items-center gap-1 text-[12.5px] text-text-secondary transition-colors hover:text-text-primary"
					>
						Manage billing
						<ArrowUpRight size={13} />
					</Link>
				)}
			</div>

			{/* Plan & limits — point-in-time gauges vs the plan, this billing period. */}
			<SettingsSection title="Plan & limits">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-1 sm:grid-cols-3">
						<Meter
							label="Seats"
							value={
								<>
									<b className="font-medium text-text-primary">
										{summary.memberCount}
									</b>
									{summary.seats != null ? ` / ${summary.seats}` : ""}
								</>
							}
							fill={seatFill}
							sub={
								summary.seats != null
									? `${Math.max(0, summary.seats - summary.memberCount)} seats available`
									: "members in this organization"
							}
						/>
						<Meter
							label="Runner minutes"
							value={
								usage ? (
									<>
										<b className="font-medium text-text-primary">
											{Math.round(usage.usedMinutes)}
										</b>
										{` / ${usage.includedMinutes}`}
									</>
								) : (
									<b className="font-medium text-text-primary">—</b>
								)
							}
							fill={usage ? usage.pct * 100 : 0}
							sub={
								!usage
									? "managed runner usage this period"
									: usage.overLimit
										? `${Math.round(usage.overageMinutes)} min over · ~$${usage.overageCost.toFixed(2)} overage`
										: usage.approaching
											? `${Math.round(usage.pct * 100)}% used — approaching included`
											: `${Math.round(usage.pct * 100)}% of included · self-hosted is free`
							}
						/>
						<Meter
							label="Concurrency"
							value={
								<>
									<b className="font-medium text-text-primary">
										{usage?.runningJobs ?? 0}
									</b>
									{` / ${concurrencyMax ?? "∞"}`}
								</>
							}
							fill={
								concurrencyMax && concurrencyMax > 0
									? ((usage?.runningJobs ?? 0) / concurrencyMax) * 100
									: 0
							}
							sub="jobs running right now"
						/>
					</div>

					{/* Spend control: pause at the included allowance instead of overage. */}
					{usage && usage.plan !== "community" && (
						<label className="flex cursor-pointer items-center gap-2 border-t border-border px-6 py-3 text-[12px] text-text-tertiary">
							<input
								type="checkbox"
								className="accent-ink"
								checked={usage.hardCap}
								disabled={pending}
								onChange={(e) => {
									const next = e.target.checked;
									setUsage((u) => (u ? { ...u, hardCap: next } : u));
									startTransition(async () => {
										try {
											await setUsageHardCap(next);
										} catch {
											toast.error("Couldn't update the usage cap.");
											setUsage((u) => (u ? { ...u, hardCap: !next } : u));
										}
									});
								}}
							/>
							Pause new jobs at my included minutes instead of billing overage
						</label>
					)}

					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-[12px] text-text-tertiary">
						<Info size={13} />
						Your cloud-resource spend is billed separately by your provider.
					</div>
				</div>
			</SettingsSection>

			{/* Resources — current scale of what the org runs. */}
			<SettingsSection title="Resources">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-2 sm:grid-cols-4">
						<Stat label="Projects" value={counts?.projects ?? "—"} />
						<Stat label="Clusters" value={counts?.clusters ?? "—"} sub="under management" />
						<Stat
							label="Jobs"
							value={overTime ? overTime.totals.jobs.toLocaleString() : "—"}
							sub={rangeLabel.toLowerCase()}
						/>
					</div>
					<div className="flex items-center justify-between border-t border-border bg-surface-sunken px-6 py-[14px] text-[12px] text-text-tertiary">
						<span className="flex items-center gap-2">
							<Info size={13} />
							Estimated cloud spend under management
						</span>
						<span className="font-mono text-text-secondary">
							{counts ? currency(counts.spendUnderManagement) : "—"}/mo
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
					{overTime && overTime.series.length > 0 ? (
						<Bars points={overTime.series} pick={(p) => p[metric]} />
					) : (
						<div className="flex h-28 items-center justify-center font-mono text-[11px] text-text-tertiary">
							No usage in this range.
						</div>
					)}
				</div>
			</SettingsSection>

			{/* AI plan & usage — standalone metered product (daily/weekly % + top-ups). */}
			<AiUsageSection />

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={(o) => {
					setUpgradeOpen(o);
					if (!o) refresh();
				}}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
