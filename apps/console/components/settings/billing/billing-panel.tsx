"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	createBillingPortalSession,
	createCheckoutSession,
	getBillingSummary,
} from "@/app/server/actions/billing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { BillingPlan } from "@/lib/db/schema/enums";

/** Paid plans, in upgrade order, with the value each unlocks (the entitlement ladder). */
const PLANS: { id: Exclude<BillingPlan, "community">; name: string; price: string; unlocks: string[] }[] = [
	{
		id: "team",
		name: "Team",
		price: "per seat",
		unlocks: ["Organizations & teams", "Invite teammates", "Shared workspace"],
	},
	{
		id: "business",
		name: "Business",
		price: "per workspace",
		unlocks: ["Everything in Team", "Custom roles (granular RBAC)", "Audit log export"],
	},
	{
		id: "enterprise",
		name: "Enterprise",
		price: "annual",
		unlocks: ["Everything in Business", "SSO / SAML", "Priority support & SLA"],
	},
];

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

	function redirectTo(action: () => Promise<{ url: string }>) {
		startTransition(async () => {
			try {
				const { url } = await action();
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
				<h2 className="text-sm font-semibold text-foreground">Self-managed deployment</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					This instance is not connected to hosted billing. Enterprise features are
					unlocked by your license key. See the docs for self-managed licensing.
				</p>
			</Card>
		);
	}

	// Free user with no workspace yet: create one before subscribing.
	if (!summary.hasOrg) {
		return (
			<Card className="p-6">
				<h2 className="text-sm font-semibold text-foreground">Create a workspace</h2>
				<p className="mt-1 max-w-prose text-sm text-muted-foreground">
					Your account is a personal workspace — your Zones and Specs are all yours.
					Create a shared workspace to invite teammates and manage a subscription.
				</p>
				<Button asChild className="mt-4">
					<Link href="/dashboard/settings/general">Create a workspace</Link>
				</Button>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* Current plan */}
			<Card className="flex flex-wrap items-center justify-between gap-4 p-6">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-semibold capitalize text-foreground">
							{summary.plan} plan
						</span>
						<Badge variant={summary.status === "active" || summary.status === "trialing" ? "default" : "secondary"}>
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
					<Button
						variant="outline"
						disabled={pending}
						onClick={() => redirectTo(createBillingPortalSession)}
					>
						Manage subscription
					</Button>
				)}
			</Card>

			{/* Upgrade options */}
			<div className="grid gap-4 md:grid-cols-3">
				{PLANS.map((plan) => {
					const isCurrent = summary.plan === plan.id;
					return (
						<Card key={plan.id} className="flex flex-col p-5">
							<div className="flex items-baseline justify-between">
								<h3 className="text-sm font-semibold text-foreground">{plan.name}</h3>
								<span className="text-xs text-muted-foreground">{plan.price}</span>
							</div>
							<ul className="mt-3 flex-1 space-y-1.5 text-sm text-muted-foreground">
								{plan.unlocks.map((f) => (
									<li key={f}>• {f}</li>
								))}
							</ul>
							<Button
								className="mt-4"
								variant={isCurrent ? "outline" : "default"}
								disabled={isCurrent || pending}
								onClick={() => redirectTo(() => createCheckoutSession(plan.id))}
							>
								{isCurrent ? "Current plan" : "Upgrade"}
							</Button>
						</Card>
					);
				})}
			</div>
		</div>
	);
}
