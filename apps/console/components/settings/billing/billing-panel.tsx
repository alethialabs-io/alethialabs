"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	createBillingPortalSession,
	createCheckoutSession,
	getBillingSummary,
} from "@/app/server/actions/billing";
import { PlanPicker } from "@/components/billing/plan-picker";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { planMeta } from "@/lib/billing/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";

const STATUS_LABEL: Record<BillingSummary["status"], string> = {
	none: "No subscription",
	trialing: "Trialing",
	active: "Active",
	past_due: "Past due",
	canceled: "Canceled",
};

export function BillingPanel() {
	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [pending, startTransition] = useTransition();
	const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const params = useSearchParams();

	useEffect(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load billing details."));
	}, []);

	// Surface the Checkout return state once.
	useEffect(() => {
		const checkout = params.get("checkout");
		if (checkout === "success") {
			toast.success("Subscription updated — your plan is active.");
		} else if (checkout === "cancelled") {
			toast.info("Checkout cancelled — no changes made.");
		}
	}, [params]);

	/** Upgrade the active org to a paid plan via Stripe Checkout. */
	function handleUpgrade(plan: BillingPlan) {
		if (plan === "community") return;
		setPendingPlan(plan);
		startTransition(async () => {
			try {
				const { url } = await createCheckoutSession(plan);
				window.location.href = url;
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Something went wrong.");
				setPendingPlan(null);
			}
		});
	}

	/** Open the Stripe Customer Portal. */
	function openPortal() {
		startTransition(async () => {
			try {
				const { url } = await createBillingPortalSession();
				window.location.href = url;
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Something went wrong.");
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
						<Badge
							variant={
								summary.status === "active" || summary.status === "trialing"
									? "default"
									: "secondary"
							}
						>
							{STATUS_LABEL[summary.status]}
						</Badge>
					</div>
					{summary.currentPeriodEnd && (
						<p className="text-sm text-muted-foreground">
							Renews {new Date(summary.currentPeriodEnd).toLocaleDateString()}
						</p>
					)}
				</div>
				{summary.canManage && (
					<Button variant="outline" disabled={pending} onClick={openPortal}>
						Manage subscription
					</Button>
				)}
			</Card>

			{/* Upgrade / change plan */}
			<PlanPicker
				currentPlan={summary.plan}
				paidOnly
				pendingPlan={pendingPlan}
				disabled={pending}
				ctaLabel="Upgrade"
				onSelect={handleUpgrade}
			/>
		</div>
	);
}
