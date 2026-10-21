"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page — the authored claude.ai/design panel composed from the shared
// settings primitives (shadcn + Tailwind tokens; no CSS module): page header, a
// current-plan card with usage meters, payment methods + billing details (two-column),
// plan-history timeline, transaction history, and invoices. A Hobby→Pro upgrade opens the
// shared in-place UpgradeOrgSheet (via useUpgradeSheet) rather than an inline plan dialog;
// cancel/resume + saved cards + invoices are all in-app.
//
// #6127 (ADR 0005): every section reads a GET procedure the route prefetches on the server, so the
// first paint is the page, not a two-box skeleton, and each section renders its own pending,
// refused, failed and empty states. Cancel/resume go through the mutation contract. The billing-
// admin sections (cards, plan history, charges, invoices) render only for a viewer who holds the
// billing permission; anyone else gets one note saying so, instead of four sections that refuse.

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { formatDate, formatMoney, scaleMoney } from "@repo/format";
import { cancelPlan, resumePlan } from "@/app/server/actions/billing";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { RegionError } from "@/components/errors/region-error";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { AiUsageSection } from "@/components/settings/usage/ai-usage-section";
import { ClockText } from "@/components/settings/usage/clock-text";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";
import { planMeta } from "@repo/plan-catalog";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { BillingSkeleton } from "./billing-skeleton";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "./read-state";
import { RecentInvoices } from "./recent-invoices";
import { PaymentMethodsCard } from "./payment-methods-card";
import { PlanHistoryTimeline } from "./plan-history-timeline";
import { TransactionsTable } from "./transactions-table";

const STATE_LABEL: Record<BillingSummary["state"], string> = {
	none: "No subscription",
	trialing: "Trialing",
	active: "Active",
	canceling: "Canceling",
	past_due: "Past due",
	canceled: "Canceled",
};

/** The Billing page: the summary decides which page this is, then each section reads its own. */
export function BillingPanel() {
	const summary = useQuery(orpc.billing.summary.queryOptions({ retry: retryUnlessRefused }));
	const [createOpen, setCreateOpen] = useState(false);

	if (summary.data === undefined) {
		if (summary.isError) {
			const refusal = refusalOf(summary.error);
			return refusal ? (
				<RegionRefusal refusal={refusal} />
			) : (
				<RegionError
					title="Couldn't load billing"
					description="Something went wrong loading this organization's plan."
					onRetry={() => void summary.refetch()}
				/>
			);
		}
		return <BillingSkeleton />;
	}

	// Self-managed / community: no Stripe → entitlements come from the license. This is the edition
	// gate, unchanged by #6127: the summary decides it.
	if (!summary.data.hosted) {
		return (
			<Card className="p-6">
				<SectionHeading
					title="Self-managed deployment"
					description="This instance is not connected to hosted billing. Enterprise features are unlocked by your license key. See the docs for self-managed licensing."
				/>
			</Card>
		);
	}

	// Free user with no org yet: an org is the paid, shared workspace — create one.
	if (!summary.data.hasOrg) {
		return (
			<>
				<Card className="p-6">
					{/* A section heading, not a page title: these fallback cards are the whole page in
					    this state, but the billing page has never carried an `h1` and the console no
					    longer has page titles at all — the breadcrumb says "Billing". */}
					<SectionHeading
						className="max-w-prose"
						title="Create an organization"
						description="Your account is a personal scope — your Projects are all yours. Create an organization to collaborate with teammates on a paid plan."
					/>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						Create organization
					</Button>
				</Card>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</>
		);
	}

	return <BillingView summary={summary.data} />;
}

/** The hosted org's billing page. */
function BillingView({ summary }: { summary: BillingSummary }) {
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	// Cancelling asks first (#4276). Resuming does not: it RESTORES the subscription, and a
	// confirmation in front of an undo is friction with nothing behind it. The registry
	// (apps/console/destructive-actions.yaml, `billing.subscription.cancel`) records the dialog
	// this state opens.
	//
	// WHAT ACTUALLY EXERCISES IT is `e2e/flows/billing.spec.ts` ("Cancel plan opens a
	// confirmation…"), against the `team` persona's real Stripe trial. NOT the audit leg: that
	// entry's `fixture:` field is documentation, not a seeding directive, and no seeder in `e2e/`
	// materialises a subscription for the audit org — `audit/context.ts:seedRouteFixtures` writes
	// one project, one job and one support case and deliberately nothing else. So `hasSub` below
	// is false there, the trigger is never rendered, and `audit/destructive.spec.ts` records the
	// control as WITHHELD every gate. Read the other way round: delete the flows spec and this
	// dialog is measured by nothing at all.
	const [cancelOpen, setCancelOpen] = useState(false);
	// Hobby → Pro upgrades open the shared in-place upgrade sheet (no inline plan dialog).
	const { openUpgrade } = useUpgradeSheet();

	// A plan change shows on this card, on the plan history, and in the usage page's plan readout;
	// the shell's plan badge reads the workspace store, which is refreshed alongside.
	const planChanged = [
		orpc.billing.summary.key(),
		orpc.billing.planHistory.key(),
		orpc.usage.org.key(),
	];
	const resume = useActionMutation(resumePlan, {
		invalidates: planChanged,
		successMessage: "Subscription resumed.",
		onSuccess: () => void fetchWorkspace(),
	});
	const cancel = useActionMutation(cancelPlan, {
		invalidates: planChanged,
		successMessage: "Subscription will cancel at the period end.",
		onSuccess: () => void fetchWorkspace(),
	});
	const pending = resume.isPending || cancel.isPending;

	// A subscription exists to manage (show a period + Cancel/Resume) for any live-ish state.
	const hasSub =
		summary.state === "active" ||
		summary.state === "trialing" ||
		summary.state === "canceling" ||
		summary.state === "past_due";

	const meta = planMeta(summary.plan);
	// The unit price is Stripe-authoritative (summary.unitAmount = the subscription's actual
	// price), never the catalog. Per-seat plans bill unit × seats; a null unit
	// (Enterprise/custom, or community) → `monthly` is null and we show meta.priceLabel.
	const seatCount = summary.seats ?? Math.max(1, summary.memberCount);
	// NO CONVERSION AND NO CURRENCY LITERAL BELOW (#4176 part b). `unitAmount` is a `Money` in
	// minor units, which is what `formatMoney` takes, so the `* 100` this file used to apply at
	// three renders is gone along with the `/ 100` in `getBillingSummary` it existed to undo.
	// `scaleMoney` carries the currency through the seat multiplication, so the per-seat line and
	// the monthly total cannot end up rendered in different currencies.
	const unit = summary.unitAmount;
	const monthly = unit === null ? null : meta.perSeat ? scaleMoney(unit, seatCount) : unit;
	const { state } = summary;
	// The Hobby tier is the free baseline — its card shows only the plan name + tagline + an
	// Upgrade CTA (no lifecycle badge, no price figure). Only paid tiers show state + price.
	const isHobby = summary.plan === "community";
	// The plan is currently entitled (filled badge) for any live-ish state.
	const isEntitled =
		state === "active" || state === "trialing" || state === "canceling";
	// currentPeriodEnd is only populated while the sub is live, so this label is only ever
	// shown for active/trialing ("Renews") or canceling ("Cancels") — never a contradiction.
	// A date in the VIEWER's zone, so it is rendered after hydration (ClockText).
	const periodEnd = summary.currentPeriodEnd;
	const periodVerb = state === "canceling" ? "Cancels" : "Renews";
	// A future charge only exists while renewing — never when canceling / canceled / past_due.
	const showNextCharge =
		(state === "active" || state === "trialing") &&
		monthly !== null &&
		monthly.minor > 0 &&
		Boolean(summary.currentPeriodEnd);

	return (
		<div>
			{/* current plan */}
			<SettingsSection title="Current plan">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="flex flex-wrap items-start justify-between gap-5 px-6 py-[22px]">
						<div className="flex flex-col gap-[9px]">
							<div className="flex items-center gap-2.5">
								<span className="font-display text-display-xs font-semibold tracking-[-0.02em] text-text-primary">
									{meta.name}
								</span>
								{!isHobby && (
									<>
										<span
											className={
												isEntitled
													? "rounded-full border border-ink bg-ink px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-ink-foreground"
													: "rounded-full border border-border-strong px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary"
											}
										>
											{STATE_LABEL[state]}
										</span>
										{isEntitled && (
											<span className="rounded-full border border-border-strong px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary">
												Monthly
											</span>
										)}
									</>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-2 text-ui-sm text-text-tertiary">
								<span>{meta.tagline}</span>
								{periodEnd && (
									<>
										<span className="size-[3px] rounded-full bg-text-disabled" />
										<span>
											{periodVerb}{" "}
											<ClockText sizer="30 Sept 2026" text={() => formatDate(periodEnd)} />
										</span>
									</>
								)}
							</div>
						</div>
						{!isHobby && (
							<div className="flex flex-col items-end gap-[3px] text-right">
								<div className="font-display text-display-xs font-semibold tracking-[-0.03em] text-text-primary">
									{monthly === null ? (
										meta.priceLabel
									) : (
										<>
											{formatMoney(monthly)}
											<span className="font-mono text-ui-sm font-normal text-text-tertiary">
												/mo
											</span>
										</>
									)}
								</div>
								{meta.perSeat && unit !== null && monthly !== null && monthly.minor > 0 && (
									<div className="font-mono text-ui-2xs text-text-tertiary">
										{formatMoney(unit)}/seat · {seatCount} seat
										{seatCount === 1 ? "" : "s"}
									</div>
								)}
								{showNextCharge && monthly !== null && summary.currentPeriodEnd && (
									<div className="font-mono text-ui-2xs text-text-tertiary">
										next charge {formatMoney(monthly)} ·{" "}
										<ClockText sizer="30 Sept 2026" text={() => formatDate(periodEnd ?? "")} />
									</div>
								)}
							</div>
						)}
					</div>

					<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-sunken px-6 py-[14px]">
						<div className="flex items-center gap-2 text-ui-sm text-text-tertiary">
							<Info size={13} />
							Your cloud-resource spend is billed separately by your provider.
						</div>
						<div className="flex gap-2.5">
							{hasSub ? (
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={
										// The BRANCH is `cancelAtPeriodEnd`, not `state === "canceling"`,
										// because that is what the single `toggleCancel` handler this
										// replaced tested. The two disagree only for a `past_due`
										// subscription already set to cancel — where the label reads
										// "Cancel plan" and the click resumes — and that contradiction
										// is #4276's to record, not to change behind a rename.
										summary.cancelAtPeriodEnd
											? () => resume.mutate({})
											: () => setCancelOpen(true)
									}
								>
									{state === "canceling" ? "Resume plan" : "Cancel plan"}
								</Button>
							) : (
								<Button size="sm" onClick={openUpgrade}>
									Upgrade to Pro
								</Button>
							)}
						</div>
					</div>
				</div>
			</SettingsSection>

			{/* AI plan & usage — the standalone metered AI product (tier + daily/weekly %). */}
			<AiUsageSection />

			{summary.canManageBilling ? (
				<>
					{/* saved cards — once a customer exists */}
					{summary.canManage && <PaymentMethodsCard />}

					{/* plan history */}
					<PlanHistoryTimeline />

					{/* transactions + invoices — once a customer exists */}
					{summary.canManage && (
						<>
							<TransactionsTable />
							<RecentInvoices />
						</>
					)}
				</>
			) : (
				// One note for the four sections this viewer may not read, rather than four refusals.
				<SettingsSection title="Payments and invoices">
					<RegionRefusal
						refusal="forbidden"
						description="Payment methods, plan history, charges and invoices are visible to members with the billing permission."
					/>
				</SettingsSection>
			)}

			{/* Cancelling asks first. The copy states the two facts a person needs to decide:
			    entitlement runs to the period end, and the decision is reversible until then. */}
			<ConfirmDialog
				open={cancelOpen}
				onOpenChange={setCancelOpen}
				title="Cancel this subscription?"
				description={
					summary.currentPeriodEnd
						? `${meta.name} stays active until ${formatDate(summary.currentPeriodEnd)}, then this organization drops to the free plan. You can resume any time before then.`
						: `${meta.name} stays active until the end of the current billing period, then this organization drops to the free plan. You can resume any time before then.`
				}
				confirmLabel="Confirm cancellation"
				onConfirm={() => cancel.mutate({})}
			/>
		</div>
	);
}
