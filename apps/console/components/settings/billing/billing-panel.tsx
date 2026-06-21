"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page — a faithful port of the authored claude.ai/design panel: page
// header, a current-plan card with usage meters, payment methods + billing details
// (two-column), plan-history timeline, transaction history, and invoices. Fully
// embedded (no Stripe redirect): change/subscribe runs through PlanPicker → the
// embedded <PaymentForm>; cancel/resume + saved cards + invoices are all in-app.

import { Info } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	cancelSubscription,
	changeSubscriptionPlan,
	createSubscriptionIntent,
	getBillingSummary,
	resumeSubscription,
} from "@/app/server/actions/billing";
import { getOrgSettings, type OrgSettings } from "@/app/server/actions/org-settings";
import { PaymentForm } from "@/components/billing/payment-form";
import { PlanPicker } from "@/components/billing/plan-picker";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { planMeta } from "@/lib/billing/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { BillingDetailsCard } from "./billing-details-card";
import styles from "./billing-design.module.css";
import { InvoicesTable } from "./invoices-table";
import { PaymentMethodsCard } from "./payment-methods-card";
import { PlanHistoryTimeline } from "./plan-history-timeline";
import { TransactionsTable } from "./transactions-table";

const STATUS_LABEL: Record<BillingSummary["status"], string> = {
	none: "No subscription",
	trialing: "Trialing",
	active: "Active",
	past_due: "Past due",
	canceled: "Canceled",
};

// Display-only monthly amounts (the authoritative prices live in Stripe). Team is
// per-seat; the others are flat. Mirrors plan-catalog's display-label convention.
const MONTHLY: Record<BillingPlan, number> = {
	community: 0,
	team: 29,
	business: 999,
	enterprise: 2500,
};

/** "1 Jul 2026" */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function BillingPanel() {
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const organizations = useWorkspaceStore((s) => s.organizations);
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [org, setOrg] = useState<OrgSettings | null>(null);
	const [pending, startTransition] = useTransition();
	const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [changeOpen, setChangeOpen] = useState(false);

	// Embedded subscribe dialog (for an org with no live subscription).
	const [payOpen, setPayOpen] = useState(false);
	const [paySecret, setPaySecret] = useState<string | null>(null);
	const [payPlan, setPayPlan] = useState<BillingPlan | null>(null);

	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load billing details."));
		getOrgSettings()
			.then(setOrg)
			.catch(() => {
				/* personal scope or no org — header meta just omits slug/region */
			});
		fetchWorkspace();
	}, [fetchWorkspace]);
	useEffect(() => {
		refresh();
	}, [refresh]);

	const liveSub = summary?.status === "active" || summary?.status === "trialing";

	/** Change plan (live sub) or open the embedded subscribe dialog (no sub). */
	function handleSelectPlan(plan: BillingPlan) {
		if (plan === "community" || !summary) return;
		setPendingPlan(plan);
		startTransition(async () => {
			try {
				if (liveSub) {
					await changeSubscriptionPlan(plan);
					toast.success("Plan updated.");
					setChangeOpen(false);
					refresh();
				} else {
					const intent = await createSubscriptionIntent(plan);
					setPaySecret(intent.clientSecret);
					setPayPlan(plan);
					setChangeOpen(false);
					setPayOpen(true);
				}
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Something went wrong.");
			} finally {
				setPendingPlan(null);
			}
		});
	}

	function onSubscribed() {
		setPayOpen(false);
		setPaySecret(null);
		toast.success("Subscription active.");
		refresh();
	}

	function toggleCancel() {
		startTransition(async () => {
			try {
				if (summary?.cancelAtPeriodEnd) {
					await resumeSubscription();
					toast.success("Subscription resumed.");
				} else {
					await cancelSubscription();
					toast.success("Subscription will cancel at the period end.");
				}
				refresh();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Something went wrong.");
			}
		});
	}

	if (!summary) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// Self-managed / community: no Stripe → entitlements come from the license.
	if (!summary.hosted) {
		return (
			<Card className="p-6">
				<h2 className="text-sm font-semibold text-foreground">
					Self-managed deployment
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					This instance is not connected to hosted billing. Enterprise features are
					unlocked by your license key. See the docs for self-managed licensing.
				</p>
			</Card>
		);
	}

	// Free user with no org yet: an org is the paid, shared workspace — create one.
	if (!summary.hasOrg) {
		return (
			<>
				<Card className="p-6">
					<h2 className="text-sm font-semibold text-foreground">
						Create an organization
					</h2>
					<p className="mt-1 max-w-prose text-sm text-muted-foreground">
						Your account is a personal workspace — your Zones and Specs are all
						yours. Create an organization to collaborate with teammates on a paid plan.
					</p>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						Create organization
					</Button>
				</Card>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</>
		);
	}

	const meta = planMeta(summary.plan);
	const orgName =
		organizations.find((o) => o.id === activeOrgId)?.name ?? org?.name ?? "—";
	const seatCount = summary.seats ?? Math.max(1, summary.memberCount);
	const monthly =
		summary.plan === "team" ? MONTHLY.team * seatCount : MONTHLY[summary.plan];
	const periodLabel = summary.currentPeriodEnd
		? `${summary.cancelAtPeriodEnd ? "Cancels" : "Renews"} ${formatDate(summary.currentPeriodEnd)}`
		: null;

	return (
		<div>
			{/* page header */}
			<div className={styles.pageHead}>
				<div className={styles.l}>
					<h1>Billing</h1>
					<p>Manage your plan, payment methods, and invoices for {orgName}.</p>
				</div>
				<div className={styles.headMeta}>
					<span>Org</span>
					{org?.slug && (
						<>
							<span className={styles.dot} />
							<span>{org.slug}</span>
						</>
					)}
					{org?.region && (
						<>
							<span className={styles.dot} />
							<span>{org.region}</span>
						</>
					)}
				</div>
			</div>

			{/* current plan */}
			<section className={styles.section}>
				<div className={styles.sectionHead}>
					<h2>Current plan</h2>
					<span className={styles.rule} />
				</div>
				<div className={`${styles.card} ${styles.planCard}`}>
					<div className={styles.planTop}>
						<div className={styles.planId}>
							<div className={styles.planBadgeRow}>
								<span className={styles.planName}>{meta.name}</span>
								<span
									className={`${styles.pill} ${liveSub ? styles.solid : ""}`}
								>
									{STATUS_LABEL[summary.status]}
								</span>
								{liveSub && <span className={styles.pill}>Monthly</span>}
							</div>
							<div className={styles.planMeta}>
								<span>{meta.tagline}</span>
								{periodLabel && (
									<>
										<span className={styles.d} />
										<span>{periodLabel}</span>
									</>
								)}
							</div>
						</div>
						<div className={styles.planPrice}>
							<div className={styles.amt}>
								{monthly === 0 ? (
									"Free"
								) : (
									<>
										${monthly.toLocaleString()}
										<span className={styles.per}>/mo</span>
									</>
								)}
							</div>
							{monthly > 0 && summary.currentPeriodEnd && (
								<div className={styles.renew}>
									next charge ${monthly.toLocaleString()} ·{" "}
									{formatDate(summary.currentPeriodEnd)}
								</div>
							)}
						</div>
					</div>

					{/* usage meters — Seats is real; the rest aren't metered yet */}
					<div className={styles.meters}>
						<div className={styles.meter}>
							<div className={styles.mh}>
								<span className={styles.k}>Seats</span>
								<span className={styles.v}>
									<b>{summary.memberCount}</b>
									{summary.seats != null ? ` / ${summary.seats}` : ""}
								</span>
							</div>
							<div className={styles.track}>
								<div
									className={styles.fill}
									style={{
										width:
											summary.seats != null && summary.seats > 0
												? `${Math.min(100, (summary.memberCount / summary.seats) * 100)}%`
												: "100%",
									}}
								/>
							</div>
							<div className={styles.sub}>
								{summary.seats != null
									? `${Math.max(0, summary.seats - summary.memberCount)} seats available`
									: "members in this organization"}
							</div>
						</div>
						<div className={styles.meter}>
							<div className={styles.mh}>
								<span className={styles.k}>Zones</span>
								<span className={styles.v}>
									<b>—</b>
								</span>
							</div>
							<div className={styles.track}>
								<div className={styles.fill} style={{ width: "0%" }} />
							</div>
							<div className={styles.sub}>usage metering coming soon</div>
						</div>
						<div className={styles.meter}>
							<div className={styles.mh}>
								<span className={styles.k}>Runner-minutes</span>
								<span className={styles.v}>
									<b>—</b>
								</span>
							</div>
							<div className={styles.track}>
								<div className={styles.fill} style={{ width: "0%" }} />
							</div>
							<div className={styles.sub}>metering coming soon</div>
						</div>
					</div>

					<div className={styles.planFoot}>
						<div className={styles.note}>
							<Info size={13} />
							Your cloud-resource spend is billed separately by your provider.
						</div>
						<div className={styles.actions}>
							{liveSub && (
								<button
									type="button"
									className={`${styles.btn} ${styles.ghost} ${styles.danger}`}
									disabled={pending}
									onClick={toggleCancel}
								>
									{summary.cancelAtPeriodEnd ? "Resume plan" : "Cancel plan"}
								</button>
							)}
							<button
								type="button"
								className={`${styles.btn} ${styles.primary}`}
								disabled={pending}
								onClick={() => setChangeOpen(true)}
							>
								{liveSub ? "Change plan" : "Choose a plan"}
							</button>
						</div>
					</div>
				</div>
			</section>

			{/* payment + billing details — only once a Stripe customer exists */}
			{summary.canManage && (
				<div className={styles.grid2} style={{ marginBottom: 34 }}>
					<PaymentMethodsCard />
					<BillingDetailsCard />
				</div>
			)}

			{/* plan history */}
			<PlanHistoryTimeline />

			{/* transactions + invoices — once a customer exists */}
			{summary.canManage && (
				<>
					<TransactionsTable />
					<InvoicesTable />
				</>
			)}

			{/* change / subscribe plan dialog */}
			<Dialog open={changeOpen} onOpenChange={setChangeOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{liveSub ? "Change plan" : "Choose a plan"}</DialogTitle>
					</DialogHeader>
					<PlanPicker
						currentPlan={summary.plan}
						paidOnly
						pendingPlan={pendingPlan}
						disabled={pending}
						ctaLabel={liveSub ? "Switch" : "Subscribe"}
						onSelect={handleSelectPlan}
					/>
				</DialogContent>
			</Dialog>

			{/* embedded subscribe dialog */}
			<Dialog open={payOpen} onOpenChange={setPayOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							Subscribe to {payPlan ? planMeta(payPlan).name : ""}
						</DialogTitle>
					</DialogHeader>
					{paySecret && (
						<StripeElementsProvider clientSecret={paySecret}>
							<PaymentForm
								mode="payment"
								submitLabel="Subscribe"
								onSuccess={onSubscribed}
							/>
						</StripeElementsProvider>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
