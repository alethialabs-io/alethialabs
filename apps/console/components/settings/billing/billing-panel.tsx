"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page — the authored claude.ai/design panel composed from the shared
// settings primitives (shadcn + Tailwind tokens; no CSS module): a current-plan card (with
// one AI-tier row that links to Usage), payment methods + billing details (two-column),
// plan-history timeline, transaction history, and invoices. A Hobby→Pro upgrade opens the
// shared in-place UpgradeOrgSheet (via useUpgradeSheet) rather than an inline plan dialog;
// cancel/resume + saved cards + invoices are all in-app.
//
// #6133 (design decision A): Billing is the page for MONEY INSTRUMENTS. The AI plan, its meters,
// credits and the admin spend limits all live on the Usage page, beside the runner hard cap, which
// is the same kind of control. Billing states the AI tier as one fact on the plan card and links
// there; it never renders the AI card itself, so the spend limits have exactly one home. The
// "cloud-resource spend is billed separately" note is Usage's too: there it is the footnote of the
// cloud-spend figure, and on this card it qualified nothing.
//
// #6127 (ADR 0005): every section reads a GET procedure the route prefetches on the server, so the
// first paint is the page, not a two-box skeleton, and each section renders its own pending,
// refused, failed and empty states. Cancel/resume go through the mutation contract. The billing-
// admin sections (cards, plan history, charges, invoices) render only for a viewer who holds the
// billing permission; anyone else gets one note saying so, instead of four sections that refuse.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { formatDate, formatMoney, scaleMoney } from "@repo/format";
import { cancelPlan, resumePlan } from "@/app/server/actions/billing";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { manageReason } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { ClockText } from "@/components/settings/usage/clock-text";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { globalHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import type { BillingSummary } from "@/lib/rpc/procedures/billing";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { aiPlanMeta, planMeta } from "@repo/plan-catalog";
import { useActiveOrgSlug, useWorkspaceStore } from "@/lib/stores/use-workspace-store";
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

/**
 * The status tier each subscription state draws (R6 F-24). Billing's words are not in the shared
 * `STATUS_TIER` vocabulary, so the tier is explicit rather than falling to the silent `idle`.
 */
const STATE_TIER: Record<BillingSummary["state"], StatusTier> = {
	none: "disabled",
	trialing: "active",
	active: "active",
	canceling: "pending",
	past_due: "failed",
	canceled: "disabled",
};

/** Where the self-managed licensing mechanism is documented (R6 F-38). */
const SELF_MANAGED_LICENSING_DOCS = "/docs/editions/licensing";

/**
 * The plan card's lifecycle button label (R6 F-36). It is derived from `cancelAtPeriodEnd`, the
 * same field that decides what the click does, so a `past_due` subscription already set to cancel
 * reads "Resume plan" and resumes — the label and the action can no longer disagree.
 */
function lifecycleLabel(cancelAtPeriodEnd: boolean): string {
	return cancelAtPeriodEnd ? "Resume plan" : "Cancel plan";
}

/** The element id of the Payment methods section, which the past-due notice links to. */
export const PAYMENT_METHODS_ANCHOR = "payment-methods";

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
					description="This instance is not connected to hosted billing. Enterprise features are unlocked by your license key."
				/>
				<a
					href={SELF_MANAGED_LICENSING_DOCS}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-3 inline-flex items-center gap-1 text-ui-sm font-medium text-text-primary underline underline-offset-4"
				>
					Read how self-managed licensing works
					<ArrowUpRight size={13} aria-hidden />
					<span className="sr-only">(opens in a new tab)</span>
				</a>
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
	// CON-L3 (R6 F-03): changing the plan is the billing permission's, the same `manage_billing` the
	// write asks for. A viewer without it sees the control disabled with the reason, never an
	// enabled button that the server then refuses.
	const planReason = manageReason({ canManage: summary.canManageBilling });

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
										<StatusBadge
											status={state}
											tier={STATE_TIER[state]}
											label={STATE_LABEL[state]}
										/>
										{isEntitled && (
											<span className="font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary">
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

					<AiPlanRow />

					<div className="flex flex-wrap items-center justify-end gap-4 border-t border-border bg-surface-sunken px-6 py-[14px]">
						<div className="flex gap-2.5">
							{hasSub ? (
								<DisabledReason reason={planReason}>
									<Button
										variant="ghost"
										size="sm"
										disabled={pending}
										onClick={
											// The label and the branch read the SAME field (R6 F-36):
											// a `past_due` subscription already set to cancel used to
											// read "Cancel plan" while the click resumed it.
											summary.cancelAtPeriodEnd
												? () => resume.mutate({})
												: () => setCancelOpen(true)
										}
									>
										{lifecycleLabel(summary.cancelAtPeriodEnd)}
									</Button>
								</DisabledReason>
							) : (
								<DisabledReason reason={planReason}>
									<Button size="sm" onClick={openUpgrade}>
										Upgrade to Pro
									</Button>
								</DisabledReason>
							)}
						</div>
					</div>
				</div>
			</SettingsSection>

			{state === "past_due" && (
				<PastDueNotice
					planName={meta.name}
					canUpdate={summary.canManageBilling && summary.canManage}
				/>
			)}

			{summary.canManageBilling ? (
				<>
					{/* saved cards — once a customer exists */}
					{summary.canManage && (
						<div id={PAYMENT_METHODS_ANCHOR} className="scroll-mt-4">
							<PaymentMethodsCard />
						</div>
					)}

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
			<ConfirmAction
				open={cancelOpen}
				onOpenChange={setCancelOpen}
				title="Cancel this subscription?"
				description={
					summary.currentPeriodEnd
						? `${meta.name} stays active until ${formatDate(summary.currentPeriodEnd)}, then this organization moves to the Hobby plan. You can resume any time before then.`
						: `${meta.name} stays active until the end of the current billing period, then this organization moves to the Hobby plan. You can resume any time before then.`
				}
				confirmLabel="Confirm cancellation"
				pendingLabel="Cancelling…"
				severity={{ level: "confirm" }}
				mutation={cancel}
				variables={{}}
			/>
		</div>
	);
}

/**
 * What a `past_due` subscription means, and what to do about it (CON-L3, R6 F-06). The card used to
 * show a "Past due" pill beside "Cancel plan" and nothing else, so the one action that fixes it —
 * a working card — was never offered. A past-due org-plan subscription is not in the paid set
 * (`lib/billing/org-plan-row.ts`), which is why the copy says the paid features are paused. A viewer
 * who can update the card gets the link to it; anyone else is told who can.
 */
function PastDueNotice({ planName, canUpdate }: { planName: string; canUpdate: boolean }) {
	return (
		<Alert variant="destructive" className="mb-[18px]" data-testid="billing-past-due">
			<AlertTriangle />
			<AlertTitle>Payment failed</AlertTitle>
			<AlertDescription>
				<p>
					The last payment for {planName} didn&apos;t go through, so this organization&apos;s
					paid features are paused until a payment succeeds.
				</p>
				{canUpdate ? (
					<a
						href={`#${PAYMENT_METHODS_ANCHOR}`}
						className="font-medium text-text-primary underline underline-offset-4"
					>
						Update the payment method
					</a>
				) : (
					<p>Ask a member with the billing permission to update the payment method.</p>
				)}
			</AlertDescription>
		</Alert>
	);
}

/**
 * The plan card's AI row: the org's AI tier as one fact, and the link to the Usage page's AI
 * section, which owns the meters, credits and spend limits (#6133). Reads `usage.ai` — the same
 * cache entry the Usage page's AI card reads, prefetched by this route — and shows no price, so it
 * cannot disagree with the AI card's live one. A failed or refused read says so in the row; the
 * link stays, because the AI section renders that read's full error or refusal.
 */
function AiPlanRow() {
	const orgSlug = useActiveOrgSlug();
	const ai = useQuery(orpc.usage.ai.queryOptions({ retry: retryUnlessRefused }));

	let tier: ReactNode;
	if (ai.data !== undefined) {
		tier = <span className="text-text-primary">{aiPlanMeta(ai.data.tier).name}</span>;
	} else if (ai.isError) {
		tier = (
			<span className="text-text-secondary">
				{refusalOf(ai.error) ? "Not available to you" : "Couldn't load the AI plan"}
			</span>
		);
	} else {
		// The height of one `text-ui-sm` line, so the row does not move when the tier arrives.
		tier = <Skeleton aria-busy="true" className="h-4 w-16" />;
	}

	return (
		<div
			data-testid="billing-ai-plan-row"
			className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-6 py-3 text-ui-sm"
		>
			<span className="text-text-tertiary">AI plan</span>
			<div className="min-w-0 flex-1">{tier}</div>
			<Link
				href={`${globalHref(orgSlug, "usage")}#ai`}
				className="inline-flex items-center gap-1 text-text-secondary transition-colors hover:text-text-primary"
			>
				Usage &amp; limits
				<ArrowUpRight size={13} />
			</Link>
		</div>
	);
}
