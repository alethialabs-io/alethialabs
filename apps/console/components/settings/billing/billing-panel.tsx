"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page — the authored claude.ai/design panel composed from the shared
// settings primitives (shadcn + Tailwind tokens; no CSS module): page header, a
// current-plan card with usage meters, payment methods + billing details (two-column),
// plan-history timeline, transaction history, and invoices. Fully embedded (no Stripe
// redirect): change/subscribe runs through PlanPicker → the embedded <PaymentForm>;
// cancel/resume + saved cards + invoices are all in-app.

import { Info } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	cancelSubscription,
	changeSubscriptionPlan,
	createSubscriptionIntent,
	getBillingSummary,
	getOrgUsage,
	resumeSubscription,
	setUsageHardCap,
	type UsageReport,
} from "@/app/server/actions/billing";
import { getOrgSettings, type OrgSettings } from "@/app/server/actions/org-settings";
import { PaymentForm } from "@/components/billing/payment-form";
import { PlanPicker } from "@/components/billing/plan-picker";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import {
	SettingsPageHead,
	SettingsSection,
} from "@/components/settings/settings-ui";
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

/** One usage meter cell of the current-plan card (key, value, fill %, sub note). */
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
					style={{ width: `${fill}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-[10px] text-text-tertiary">{sub}</div>
		</div>
	);
}

export function BillingPanel() {
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const organizations = useWorkspaceStore((s) => s.organizations);
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [usage, setUsage] = useState<UsageReport | null>(null);
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
		getOrgUsage()
			.then(setUsage)
			.catch(() => {
				/* usage is best-effort; the meter just shows a dash */
			});
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
						Your account is a personal workspace — your Zones and Specs are all yours.
						Create an organization to collaborate with teammates on a paid plan.
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

	const seatFill =
		summary.seats != null && summary.seats > 0
			? Math.min(100, (summary.memberCount / summary.seats) * 100)
			: 100;

	return (
		<div>
			<SettingsPageHead
				title="Billing"
				description={`Manage your plan, payment methods, and invoices for ${orgName}.`}
				action={
					<div className="flex items-center gap-2.5 font-mono text-[11px] text-text-tertiary">
						<span>Org</span>
						{org?.slug && (
							<>
								<span className="size-1 rounded-full bg-text-disabled" />
								<span>{org.slug}</span>
							</>
						)}
						{org?.region && (
							<>
								<span className="size-1 rounded-full bg-text-disabled" />
								<span>{org.region}</span>
							</>
						)}
					</div>
				}
			/>

			{/* current plan */}
			<SettingsSection title="Current plan">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="flex flex-wrap items-start justify-between gap-5 px-6 py-[22px]">
						<div className="flex flex-col gap-[9px]">
							<div className="flex items-center gap-2.5">
								<span className="font-display text-[21px] font-semibold tracking-[-0.02em] text-text-primary">
									{meta.name}
								</span>
								<span
									className={
										liveSub
											? "rounded-full border border-ink bg-ink px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-foreground"
											: "rounded-full border border-border-strong px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-secondary"
									}
								>
									{STATUS_LABEL[summary.status]}
								</span>
								{liveSub && (
									<span className="rounded-full border border-border-strong px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-secondary">
										Monthly
									</span>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-tertiary">
								<span>{meta.tagline}</span>
								{periodLabel && (
									<>
										<span className="size-[3px] rounded-full bg-text-disabled" />
										<span>{periodLabel}</span>
									</>
								)}
							</div>
						</div>
						<div className="flex flex-col items-end gap-[3px] text-right">
							<div className="font-display text-[26px] font-semibold tracking-[-0.03em] text-text-primary">
								{monthly === 0 ? (
									"Free"
								) : (
									<>
										${monthly.toLocaleString()}
										<span className="font-mono text-[12px] font-normal text-text-tertiary">
											/mo
										</span>
									</>
								)}
							</div>
							{monthly > 0 && summary.currentPeriodEnd && (
								<div className="font-mono text-[10.5px] text-text-tertiary">
									next charge ${monthly.toLocaleString()} ·{" "}
									{formatDate(summary.currentPeriodEnd)}
								</div>
							)}
						</div>
					</div>

					{/* usage meters — Seats + Provisioning-minutes are real; Zones isn't metered yet */}
					<div className="grid grid-cols-1 border-t border-border sm:grid-cols-3">
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
							label="Zones"
							value={<b className="font-medium text-text-primary">—</b>}
							fill={0}
							sub="usage metering coming soon"
						/>
						<Meter
							label="Provisioning minutes"
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
							fill={usage ? Math.min(100, usage.pct * 100) : 0}
							sub={
								!usage
									? "managed runner usage this period"
									: usage.overLimit
										? `${Math.round(usage.overageMinutes)} min over included · ~$${usage.overageCost.toFixed(2)} overage`
										: usage.approaching
											? `${Math.round(usage.pct * 100)}% used — approaching your included minutes`
											: `${Math.round(usage.pct * 100)}% of included used · self-hosted runners are free`
							}
						/>
					</div>

					{/* Spend control: pause at the included allowance instead of overage. */}
					{summary.hasOrg && usage && usage.plan !== "community" && (
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

					<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-sunken px-6 py-[14px]">
						<div className="flex items-center gap-2 text-[12px] text-text-tertiary">
							<Info size={13} />
							Your cloud-resource spend is billed separately by your provider.
						</div>
						<div className="flex gap-2.5">
							{liveSub && (
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={toggleCancel}
								>
									{summary.cancelAtPeriodEnd ? "Resume plan" : "Cancel plan"}
								</Button>
							)}
							<Button
								size="sm"
								disabled={pending}
								onClick={() => setChangeOpen(true)}
							>
								{liveSub ? "Change plan" : "Choose a plan"}
							</Button>
						</div>
					</div>
				</div>
			</SettingsSection>

			{/* payment + billing details — only once a Stripe customer exists */}
			{summary.canManage && (
				<div className="mb-[34px] grid grid-cols-1 gap-5 md:grid-cols-2">
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
