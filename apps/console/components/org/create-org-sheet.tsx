"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "create an organization" flow (pay-to-create model): name the org, choose a paid
// plan, and we create the org then send you to Stripe Checkout. On payment the webhook
// flips it to paid/active. A right Sheet so it can be opened from the org switcher or
// the billing page; it reuses the self-contained <PlanPicker>.

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createCheckoutSession } from "@/app/server/actions/billing";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { PlanPicker } from "@/components/billing/plan-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { authClient } from "@/lib/auth/client";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const schema = z.object({
	name: z.string().trim().min(2, "Give your organization a name"),
});
type FormData = z.infer<typeof schema>;

/** Slug from a name + a short suffix to avoid collisions on the unique org slug. */
function toSlug(name: string): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "org";
	return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "" },
	});

	/** Create the org, make it active, then start Checkout for the chosen plan. */
	const handleSelect = async (plan: BillingPlan) => {
		if (plan === "community") return; // paidOnly — defensive
		const valid = await form.trigger("name");
		if (!valid) return;
		const name = form.getValues("name").trim();

		setPendingPlan(plan);
		try {
			const { data, error } = await authClient.organization.create({
				name,
				slug: toSlug(name),
			});
			if (error || !data) {
				throw new Error(error?.message ?? "Couldn't create the organization");
			}
			// Scope the session to the new org so checkout bills it, then go to Stripe.
			await setActiveOrganization(data.id);
			await fetchWorkspace();
			const { url } = await createCheckoutSession(plan);
			window.location.href = url;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
			setPendingPlan(null);
		}
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full overflow-y-auto sm:max-w-xl"
			>
				<SheetHeader>
					<SheetTitle>Create an organization</SheetTitle>
					<SheetDescription>
						Collaborate with your team in a shared workspace — pooled Zones &amp;
						Specs, teammates, and role-based access. Pick a plan to get started.
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-6 px-4 pb-8">
					<div className="space-y-2">
						<Label htmlFor="org-name">Organization name</Label>
						<Input
							id="org-name"
							placeholder="Acme Inc."
							autoComplete="off"
							{...form.register("name")}
						/>
						{form.formState.errors.name && (
							<p className="text-xs text-destructive">
								{form.formState.errors.name.message}
							</p>
						)}
					</div>

					<div className="space-y-3">
						<p className="text-sm font-medium text-foreground">Choose a plan</p>
						<PlanPicker
							paidOnly
							pendingPlan={pendingPlan}
							disabled={pendingPlan !== null}
							ctaLabel="Continue to payment"
							onSelect={handleSelect}
						/>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
