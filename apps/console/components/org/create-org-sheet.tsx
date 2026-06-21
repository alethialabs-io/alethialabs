"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "create an organization" flow (pay-to-create), fully embedded. Name-first: you
// name the org, then the plan chooser + prices reveal; pick a plan, Continue, and pay
// with the in-sheet Payment Element (no Stripe redirect). We create the org, open an
// incomplete subscription, and confirm its first payment inline; the webhook activates
// the org. A right Sheet, opened from the org switcher or the billing page.

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createSubscriptionIntent } from "@/app/server/actions/billing";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { PaymentForm } from "@/components/billing/payment-form";
import { PlanChooser } from "@/components/billing/plan-chooser";
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
import { PAID_PLANS, planMeta } from "@/lib/billing/plan-catalog";
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
	const [busy, setBusy] = useState(false);
	const [step, setStep] = useState<"details" | "payment">("details");
	const [selectedPlan, setSelectedPlan] = useState<BillingPlan>("team");
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	// The org is created once (on first Continue); kept so going Back never duplicates it.
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "" },
	});

	const nameValid = form.watch("name").trim().length >= 2;
	const planLabel = planMeta(selectedPlan);

	function reset() {
		setStep("details");
		setSelectedPlan("team");
		setClientSecret(null);
		setCreatedOrgId(null);
		setBusy(false);
		form.reset();
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Create the org (once), open a subscription, and move to the in-sheet payment step. */
	async function handleContinue() {
		if (selectedPlan === "community") return; // chooser is paid-only — defensive
		const valid = await form.trigger("name");
		if (!valid) return;
		const name = form.getValues("name").trim();

		setBusy(true);
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
			const intent = await createSubscriptionIntent(selectedPlan);
			setClientSecret(intent.clientSecret);
			setStep("payment");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	function handlePaid() {
		toast.success("Subscription active — your organization is ready.");
		fetchWorkspace();
		handleOpenChange(false);
		router.refresh();
	}

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>Create an organization</SheetTitle>
					<SheetDescription>
						{step === "details"
							? "Name your organization, then choose a plan to collaborate with your team."
							: `Enter your card to start the ${planLabel.name} plan.`}
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

							{/* Plans + prices reveal once the org has a name. */}
							{nameValid && (
								<div className="space-y-5">
									<PlanChooser
										plans={PAID_PLANS}
										value={selectedPlan}
										onChange={setSelectedPlan}
									/>
									<Button
										className="w-full"
										disabled={busy}
										onClick={handleContinue}
									>
										{busy ? "Setting up…" : `Continue · ${planLabel.priceLabel}`}
									</Button>
								</div>
							)}
						</>
					)}

					{step === "payment" && clientSecret && (
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
