"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "create an organization" flow (pay-to-create), fully embedded: name the org, pick
// a paid plan, then pay with the in-sheet Payment Element (no Stripe redirect). We
// create the org, open an incomplete subscription, and confirm its first payment inline;
// the webhook then activates the org. A right Sheet, opened from the org switcher or the
// billing page.

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createSubscriptionIntent } from "@/app/server/actions/billing";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { PaymentForm } from "@/components/billing/payment-form";
import { PlanPicker } from "@/components/billing/plan-picker";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { Button } from "@/components/ui/button";
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
import { planMeta } from "@/lib/billing/plan-catalog";
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
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
	const [step, setStep] = useState<"details" | "payment">("details");
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [selectedPlan, setSelectedPlan] = useState<BillingPlan | null>(null);
	// The org is created once (on first plan-continue); kept so going Back never
	// creates a duplicate org.
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "" },
	});

	function reset() {
		setStep("details");
		setClientSecret(null);
		setSelectedPlan(null);
		setPendingPlan(null);
		setCreatedOrgId(null);
		form.reset();
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Create the org (once), open a subscription, and move to the in-sheet payment step. */
	async function handleSelect(plan: BillingPlan) {
		if (plan === "community") return; // paidOnly — defensive
		const valid = await form.trigger("name");
		if (!valid) return;
		const name = form.getValues("name").trim();

		setPendingPlan(plan);
		try {
			let orgId = createdOrgId;
			if (!orgId) {
				const { data, error } = await authClient.organization.create({
					name,
					slug: toSlug(name),
				});
				if (error || !data) {
					throw new Error(error?.message ?? "Couldn't create the organization");
				}
				orgId = data.id;
				setCreatedOrgId(orgId);
				await setActiveOrganization(orgId);
				await fetchWorkspace();
			}
			const intent = await createSubscriptionIntent(plan);
			setSelectedPlan(plan);
			setClientSecret(intent.clientSecret);
			setStep("payment");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setPendingPlan(null);
		}
	}

	function handlePaid() {
		toast.success("Subscription active — your organization is ready.");
		fetchWorkspace();
		handleOpenChange(false);
		router.refresh();
	}

	const planLabel = selectedPlan ? planMeta(selectedPlan) : null;

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>Create an organization</SheetTitle>
					<SheetDescription>
						{step === "details"
							? "Collaborate with your team in a shared workspace — pooled Zones & Specs, teammates, and role-based access. Pick a plan to get started."
							: `Enter your card to start the ${planLabel?.name ?? ""} plan.`}
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-6 px-4 pb-8">
					{step === "details" && (
						<>
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
									ctaLabel="Continue"
									onSelect={handleSelect}
								/>
							</div>
						</>
					)}

					{step === "payment" && clientSecret && planLabel && (
						<div className="space-y-4">
							<div className="flex items-center justify-between border-b border-border/40 pb-3">
								<div>
									<p className="text-sm font-semibold text-foreground">
										{planLabel.name}
									</p>
									<p className="text-xs text-muted-foreground">
										{planLabel.priceLabel}
									</p>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setStep("details");
										setClientSecret(null);
									}}
								>
									Back
								</Button>
							</div>
							<StripeElementsProvider clientSecret={clientSecret}>
								<PaymentForm
									mode="payment"
									submitLabel={`Subscribe — ${planLabel.priceLabel}`}
									onSuccess={handlePaid}
								/>
							</StripeElementsProvider>
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
