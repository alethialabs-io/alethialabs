"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The organization Usage page.
//
// ── The order, and why it is this one ────────────────────────────────────────────────────────
// An operator opens a usage page with three questions, and they are not equally urgent:
//
//   1. Am I about to be stopped or charged?   → "Plan & limits": seats, runner minutes and
//      concurrency as gauges against the plan, plus the hard cap that turns overage into a stop.
//      This is first because it is the only part that is ACTIONABLE NOW.
//   2. What used it?                          → "Usage over time": the range picker and every
//      number the range picker moves — runner minutes, jobs, AI credits.
//   3. What am I running, and what does that cost outside the plan? → "Resources": projects,
//      clusters, and the estimated cloud spend those clusters carry. LAST, because none of it is
//      a number anyone acts on — it is the context the two sections above are measured in.
//   4. AI is its own budget model (weekly window + purchased balance + top-up) and keeps its
//      own section.
//
// Two things moved, and each fixes a real defect rather than rearranging furniture:
//
//   • The range's JOB TOTAL used to sit in the Resources card near the top of the page while the
//     picker that changes it lived two sections below — a control silently rewriting a number
//     above it. Every range-scoped number now lives in `OverTimeCard`, beside its picker, and
//     what is left in the fact list is point-in-time only.
//   • "Your cloud-resource spend is billed separately by your provider" used to be a band on the
//     PLAN & LIMITS card, under the seats/minutes/concurrency meters — nowhere near a cloud
//     spend figure, qualifying numbers it has nothing to do with. It is now the footnote of the
//     card that states the cloud spend, which is the only figure on the page it is about.
//
// Hobby orgs get an inline "Upgrade to Pro" (UpgradeOrgSheet); subscription/payment management
// still lives on the Billing page.
//
// This page OWNS all of AI (#6133, design decision A): the tier, the meters, Upgrade AI plan, Buy
// credits and the admin spend limits, next to the runner hard cap above. The Billing page states the
// AI tier as one row on its plan card and links here, to `#ai`; it never renders the AI card.
//
// ── Data (#6127, ADR 0005) ───────────────────────────────────────────────────────────────────────
// Every read is a GET procedure the route PREFETCHES on the server (`~/usage/page.tsx`), so the
// first paint carries the numbers and the browser fetches nothing on mount. Each section owns its
// read and its four renders (pending · refused · failed · data, `../billing/read-state.tsx`), so one
// failing read takes down one section, never the page. Nothing here polls: usage moves through the
// `jobs` and `usage` topics of the org's change stream (lib/query/topics.ts).

import { formatMonthlyRate } from "@repo/format";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Building2, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { setUsageHardCap } from "@/app/server/actions/billing";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { RegionError } from "@/components/errors/region-error";
import {
	RegionRefusal,
	refusalOf,
	retryUnlessRefused,
} from "@/components/settings/billing/read-state";
import { AiUsageSection } from "@/components/settings/usage/ai-usage-section";
import { ClockText } from "@/components/settings/usage/clock-text";
import { useUsageRange } from "@/components/settings/usage/use-usage-range";
import {
	count,
	countQuota,
	Fact,
	FactList,
	type Metric,
	Meter,
	OverTimeCard,
} from "@/components/settings/usage/usage-primitives";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { globalHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";
import type { UsageReport } from "@/lib/rpc/procedures/usage";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { formatDate, formatMinutes, formatMoney, formatQuota } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import { SectionHeading } from "@repo/ui/section-heading";
import { UsageSkeleton } from "./usage-skeleton";

/** Renders the organization's Usage view. See the taxonomy note at the top of this file. */
export function UsagePanel() {
	const summary = useQuery(orpc.billing.summary.queryOptions({ retry: retryUnlessRefused }));

	if (summary.data === undefined) {
		if (summary.isError) {
			const refusal = refusalOf(summary.error);
			return refusal ? (
				<RegionRefusal refusal={refusal} />
			) : (
				<RegionError
					title="Couldn't load usage"
					description="Something went wrong loading this organization's plan and usage."
					onRetry={() => void summary.refetch()}
				/>
			);
		}
		return <UsageSkeleton />;
	}
	return <UsageForSummary summary={summary.data} />;
}

/** The page once the plan is known: the two non-metered states, or the report itself. */
function UsageForSummary({ summary }: { summary: BillingSummary }) {
	const [createOpen, setCreateOpen] = useState(false);

	// Self-managed / community: no Stripe metering — usage is a hosted-billing concept. This is the
	// edition gate, unchanged by #6127: it is decided by the summary, not by a refused read.
	if (!summary.hosted) {
		return (
			<Card className="p-6">
				<SectionHeading
					title="Self-managed deployment"
					description="This instance isn't connected to hosted billing, so usage isn't metered here."
				/>
			</Card>
		);
	}

	// Free user with no org yet: usage is per-organization. This is an EMPTY STATE — a thing that
	// is not here plus the single step that makes it exist — so it renders through `@repo/ui/empty`
	// rather than a Card with a heading and a loose button under it, which is the shape that
	// component exists to stop being re-derived per page.
	if (!summary.hasOrg) {
		return (
			<div>
				<EmptyState
					className="border border-dashed border-border"
					icon={<Building2 size={20} />}
					title="No organization yet"
					description="Usage is metered per organization. Create one to track seats, runner minutes, and AI against a plan."
					action={
						<Button onClick={() => setCreateOpen(true)}>Create organization</Button>
					}
				/>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		);
	}

	return <UsageReportView summary={summary} />;
}

/** The org's usage report: plan & limits, usage over time, resources, AI. */
function UsageReportView({ summary }: { summary: BillingSummary }) {
	const orgSlug = useActiveOrgSlug();
	const queryClient = useQueryClient();
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const usage = useQuery(orpc.usage.org.queryOptions({ retry: retryUnlessRefused }));
	const isCommunity = summary.plan === "community" || summary.status === "none";
	const periodEnd = usage.data?.periodEnd;

	return (
		<div className="space-y-2">
			{/* No page title: the sidebar entry and the breadcrumb both already say "Usage". What
			    neither of them says is WHICH PLAN and WHICH PERIOD every number below is measured
			    against, which is what this row carries — plus the one action a usage page has. */}
			<PageToolbar
				className="pb-2"
				description={
					<>
						{/* The plan name is its own element and the period is a quieter one beside
						    it: they are a fact and a qualifier ON that fact, not one sentence. */}
						<span>{planMeta(summary.plan).name} plan</span>
						{periodEnd ? (
							<span className="text-text-tertiary">
								{" · "}period to{" "}
								{/* The period end is a date in the VIEWER's zone: after hydration only. */}
								<ClockText sizer="30 Sept 2026" text={() => formatDate(periodEnd)} />
							</span>
						) : null}
					</>
				}
				actions={
					isCommunity ? (
						<Button size="sm" onClick={() => setUpgradeOpen(true)}>
							Upgrade to Pro
							<ArrowUpRight size={14} />
						</Button>
					) : (
						// A plain `<Link>`, not `<Button render={<Link/>} nativeButton={false}>`:
						// this is navigation to the billing page, not an action on this one. The
						// console uses the Button form for links that ARE the page's action; a
						// "go and read the other page" affordance is styled as text. (The other
						// reason this comment once gave — base-ui putting `role="button"` on the
						// anchor — is gone: `@repo/ui/button` announces an href as a link, #5444.)
						<Link
							href={globalHref(orgSlug, "settings/billing")}
							className="inline-flex items-center gap-1 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
						>
							Manage billing
							<ArrowUpRight size={13} />
						</Link>
					)
				}
			/>

			<PlanAndLimits summary={summary} usage={usage} />
			<UsageOverTimeSection />
			<ResourcesSection />

			{/* 4 · AI plan & usage — standalone metered product (daily/weekly % + top-ups). Its only
			    home (#6133); `#ai` is what the Billing page's AI-tier row links to. */}
			<div id="ai" className="scroll-mt-4">
				<AiUsageSection />
			</div>

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={(o) => {
					setUpgradeOpen(o);
					// An upgrade changes the plan, the allowance and the period: re-read every read on
					// this page that shows them (the change stream also hints, once Stripe confirms).
					if (!o) {
						void queryClient.invalidateQueries({ queryKey: orpc.billing.key() });
						void queryClient.invalidateQueries({ queryKey: orpc.usage.key() });
					}
				}}
				orgSlug={orgSlug}
			/>
		</div>
	);
}

/** The org-usage read as the plan section consumes it. */
interface UsageRead {
	data: UsageReport | undefined;
	isError: boolean;
	error: unknown;
	refetch: () => unknown;
}

/**
 * 1 · Plan & limits — point-in-time gauges vs the plan, this billing period. First because it is
 * the only section an operator can act on right now.
 */
function PlanAndLimits({ summary, usage }: { summary: BillingSummary; usage: UsageRead }) {
	// "Pause at my included minutes": an optimistic flip of the cached report, rolled back if the
	// server refuses. The checkbox IS the confirmation, so there is no success toast.
	const pause = useActionMutation(setUsageHardCap, {
		invalidates: [orpc.usage.org.key()],
		optimistic: [
			{
				key: orpc.usage.org.queryKey(),
				update: (current, variables) =>
					typeof current === "object" && current !== null && "hardCap" in current
						? { ...current, hardCap: variables.enabled }
						: current,
			},
		],
	});

	if (usage.isError && usage.data === undefined) {
		const refusal = refusalOf(usage.error);
		return (
			<SettingsSection title="Plan & limits">
				{refusal ? (
					<RegionRefusal refusal={refusal} />
				) : (
					<RegionError
						title="Couldn't load this period's usage"
						description="Something went wrong reading runner minutes and concurrency."
						onRetry={() => void usage.refetch()}
					/>
				)}
			</SettingsSection>
		);
	}

	const report = usage.data;
	// An ABSENT seat cap fills 0, not 100 — the same answer the concurrency meter below already
	// gives for the identical "the plan sets no limit" case. Filling the gauge instead made a Hobby
	// org render `3 / ∞` above a bar drawn solid to its end: "no cap" and "at the cap" stated in one
	// cell. A gauge with no denominator has no fraction to draw, and 0 is the only reading of it
	// that does not assert one.
	const seatFill =
		summary.seats != null && summary.seats > 0
			? (summary.memberCount / summary.seats) * 100
			: 0;
	const concurrencyMax = report?.maxConcurrentJobs ?? null;
	// ONE percentage, read twice. The two `sub` branches below each used to compute
	// `Math.round(usage.pct * 100)` for themselves — two expressions, two lines apart, that a
	// later edit could change independently while both claim to be "% of included".
	const pctUsed = report ? Math.round(report.pct * 100) : 0;

	return (
		<SettingsSection title="Plan & limits">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
				<div className="grid grid-cols-1 sm:grid-cols-3">
					<Meter
						label="Seats"
						// `countQuota`, not a locally assembled pair: this cell printed a bare
						// `3` when the plan set no seat cap while the concurrency cell two
						// columns right printed `2 / ∞` for the same "no limit". An absent
						// allowance is `∞` at both now.
						value={countQuota(summary.memberCount, summary.seats)}
						fill={seatFill}
						sub={
							summary.seats != null
								? `${count(Math.max(0, summary.seats - summary.memberCount))} seats available`
								: "members in this organization"
						}
					/>
					<Meter
						label="Runner minutes"
						value={
							// `formatQuota`, not a locally assembled pair. `usedMinutes` is a FLOAT
							// — rendered raw it read `0.943` here and `0` after a local Math.round
							// — and the pair around it is the second half of the same problem:
							// this file printed `47 min / 200` while the helper written for
							// exactly this readout prints `47 min / 200 min`. One function, one
							// answer; the allowance still stays the plain integer the plan and
							// the pricing page quote.
							report ? formatQuota(report.usedMinutes, report.includedMinutes) : "—"
						}
						fill={report ? report.pct * 100 : 0}
						sub={
							!report
								? "managed runner usage this period"
								: report.overLimit
									// `overageCost` is a `Money` in MINOR units and carries its own currency
									// (#4176 part b), so neither the `* 100` this line used to apply nor the
									// `"USD"` literal it used to name is written here any more. The currency
									// is decided once, where the rate is (`OVERAGE_RATE_PER_MIN`).
									? `${formatMinutes(report.overageMinutes)} over · ~${formatMoney(report.overageCost)} overage`
									: report.approaching
										? `${pctUsed}% used — approaching included`
										: `${pctUsed}% of included · self-hosted is free`
						}
					/>
					<Meter
						label="Concurrency"
						value={countQuota(report?.runningJobs ?? 0, concurrencyMax)}
						fill={
							concurrencyMax && concurrencyMax > 0
								? ((report?.runningJobs ?? 0) / concurrencyMax) * 100
								: 0
						}
						sub="jobs running right now"
					/>
				</div>

				{/* Spend control: pause at the included allowance instead of overage. Billing admins
				    only — the summary says whether this viewer may change it, so a member without
				    the permission is not offered a control the server refuses. */}
				{report && report.plan !== "community" && summary.canManageBilling && (
					<label className="flex cursor-pointer items-center gap-2 border-t border-border px-6 py-3 text-ui-sm text-text-tertiary">
						<input
							type="checkbox"
							name="usageHardCap"
							className="accent-ink"
							checked={report.hardCap}
							disabled={pause.isPending}
							onChange={(e) => pause.mutate({ enabled: e.target.checked })}
						/>
						Pause new jobs at my included minutes instead of billing overage
					</label>
				)}
			</div>
		</SettingsSection>
	);
}

/**
 * 2 · Usage over time — cumulative, and the ONLY home for a number the range picker can move. The
 * picker is this section's action, so the control and everything it changes are on screen together.
 */
function UsageOverTimeSection() {
	const picker = useUsageRange();
	const [metric, setMetric] = useState<Metric>("runnerMinutes");
	// No `keepPreviousData`: `label` changes with the picker synchronously, so keeping the previous
	// window's bars would caption seven days of data "last 30 days" for the length of the refetch.
	const overTime = useQuery(
		orpc.usage.overTime.queryOptions({
			input: { range: picker.spec },
			retry: retryUnlessRefused,
		}),
	);
	const refusal = overTime.isError ? refusalOf(overTime.error) : null;

	return (
		<SettingsSection
			title="Usage over time"
			action={
				<div className="flex flex-wrap items-center gap-2">
					<QuickRangeFilter label={picker.label} value={picker.range} onChange={picker.pickPreset} />
					<DateRangeFilter value={picker.range} onChange={picker.pickRange} />
				</div>
			}
		>
			{refusal ? (
				<RegionRefusal refusal={refusal} />
			) : (
				<OverTimeCard
					metric={metric}
					onMetricChange={setMetric}
					series={overTime.data?.series}
					totals={overTime.data?.totals}
					// `&& !overTime.data` so a refetch that fails keeps showing the window it already
					// has rather than replacing real bars with an error.
					error={overTime.isError && !overTime.data}
					onRetry={() => void overTime.refetch()}
					rangeLabel={picker.label}
				/>
			)}
		</SettingsSection>
	);
}

/**
 * 3 · Resources — what the org runs right now, and what those things cost OUTSIDE the plan:
 * Alethia meters the minutes, the cloud bills the clusters. Nothing here moves when the range
 * picker moves; the job count that did now lives in the section above, which is why this card
 * sits below it rather than above.
 */
function ResourcesSection() {
	const counts = useQuery(orpc.usage.resources.queryOptions({ retry: retryUnlessRefused }));

	if (counts.isError && counts.data === undefined) {
		const refusal = refusalOf(counts.error);
		return (
			<SettingsSection title="Resources">
				{refusal ? (
					<RegionRefusal refusal={refusal} />
				) : (
					<RegionError
						title="Couldn't load resources"
						description="Something went wrong counting this organization's projects and clusters."
						onRetry={() => void counts.refetch()}
					/>
				)}
			</SettingsSection>
		);
	}

	const data = counts.data;
	return (
		<SettingsSection title="Resources">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
				<FactList>
					<Fact label="Projects" value={data ? count(data.projects) : "—"} />
					<Fact
						label="Clusters"
						value={data ? count(data.clusters) : "—"}
						sub="under management"
					/>
					{/* Spend is a fact about what this org runs, so it is a row of the same list —
					    not a paragraph under it. It used to sit outside as a hand-rolled
					    flex row, which left a screen reader with three terms and their values
					    followed by a loose line for the fourth, and the fourth is the one that
					    costs money. The sunken band is a treatment, not a different kind of
					    thing. */}
					<Fact
						className="border-t bg-surface-sunken"
						icon={<Info size={13} />}
						label="Estimated cloud spend under management"
						value={data ? formatMonthlyRate(data.spendUnderManagement) : "—"}
					/>
				</FactList>
				{/* The footnote of the figure it qualifies. It used to close the PLAN & LIMITS
				    card — under the seats, minutes and concurrency meters, which no provider
				    bills for — a whole section away from the only cloud-spend number here. */}
				<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-ui-sm text-text-tertiary">
					<Info size={13} />
					Your cloud-resource spend is billed separately by your provider.
				</div>
			</div>
		</SettingsSection>
	);
}
