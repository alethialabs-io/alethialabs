"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing panel — fully embedded (no Stripe redirect). Shows the current plan +
// cancel/resume, lets you change/subscribe to a plan (PlanPicker → embedded
// <PaymentForm> for a new subscription, or changeSubscriptionPlan when already
// subscribed), and manages saved cards, invoices, and billing details/VAT.

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
import { BillingDetails } from "@/components/billing/billing-details";
import { InvoicesList } from "@/components/billing/invoices-list";
import { PaymentForm } from "@/components/billing/payment-form";
import { PlanPicker } from "@/components/billing/plan-picker";
import { SavedCards } from "@/components/billing/saved-cards";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { planMeta } from "@/lib/billing/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const STATUS_LABEL: Record<BillingSummary["status"], string> = {
	none: "No subscription",
	trialing: "Trialing",
	active: "Active",
	past_due: "Past due",
	canceled: "Canceled",
};

export function BillingPanel() {
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [pending, startTransition] = useTransition();
	const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
	const [createOpen, setCreateOpen] = useState(false);

	// Embedded subscribe dialog (for an org with no live subscription).
	const [payOpen, setPayOpen] = useState(false);
	const [paySecret, setPaySecret] = useState<string | null>(null);
	const [payPlan, setPayPlan] = useState<BillingPlan | null>(null);

	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load billing details."));
		fetchWorkspace();
	}, [fetchWorkspace]);
	useEffect(() => {
		refresh();
	}, [refresh]);

	const liveSub =
		summary?.status === "active" || summary?.status === "trialing";

	/** Change plan (live sub) or open the embedded subscribe dialog (no sub). */
	function handleSelectPlan(plan: BillingPlan) {
		if (plan === "community" || !summary) return;
		setPendingPlan(plan);
		startTransition(async () => {
			try {
				if (liveSub) {
					await changeSubscriptionPlan(plan);
					toast.success("Plan updated.");
					refresh();
				} else {
					const intent = await createSubscriptionIntent(plan);
					setPaySecret(intent.clientSecret);
					setPayPlan(plan);
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

	return (
		<div className="space-y-6">
			{/* Current plan */}
			<Card className="flex flex-wrap items-center justify-between gap-4 p-6">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-semibold text-foreground">
							{planMeta(summary.plan).name} plan
						</span>
						<Badge variant={liveSub ? "default" : "secondary"}>
							{STATUS_LABEL[summary.status]}
						</Badge>
					</div>
					{summary.currentPeriodEnd && (
						<p className="text-sm text-muted-foreground">
							{summary.cancelAtPeriodEnd ? "Cancels" : "Renews"}{" "}
							{new Date(summary.currentPeriodEnd).toLocaleDateString()}
						</p>
					)}
				</div>
				{liveSub && (
					<Button
						variant="outline"
						disabled={pending}
						onClick={toggleCancel}
						className={summary.cancelAtPeriodEnd ? "" : "text-destructive"}
					>
						{summary.cancelAtPeriodEnd ? "Resume subscription" : "Cancel subscription"}
					</Button>
				)}
			</Card>

			{/* Change / subscribe */}
			<div className="space-y-3">
				<p className="text-sm font-medium text-foreground">
					{liveSub ? "Change plan" : "Choose a plan"}
				</p>
				<PlanPicker
					currentPlan={summary.plan}
					paidOnly
					pendingPlan={pendingPlan}
					disabled={pending}
					ctaLabel={liveSub ? "Switch" : "Subscribe"}
					onSelect={handleSelectPlan}
				/>
			</div>

			{/* Payment methods, invoices, billing details — once a customer exists */}
			{summary.canManage && (
				<>
					<Separator />
					<SavedCards />
					<Separator />
					<InvoicesList />
					<Separator />
					<BillingDetails />
				</>
			)}

			{/* Embedded subscribe dialog */}
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
