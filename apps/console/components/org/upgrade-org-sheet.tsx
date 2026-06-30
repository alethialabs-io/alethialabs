"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Upgrade an EXISTING Hobby organization to Pro — the sibling of the create-org sheet,
// minus the name step (the org already exists). It opens a subscription intent on the
// ACTIVE org (createSubscriptionIntent), takes payment through the shared
// BillingCheckoutForm, then — since a paid org can now collaborate — drops into the
// shared invite view. Best-effort billing-detail persistence mirrors the create flow.
// Shares the two-column shell / invite view / primitives with the create sheet via
// ./org-purchase-ui. Owner-gated server-side; refuses if a live subscription exists.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	createSubscriptionIntent,
	saveTaxId,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import {
	InviteView,
	isValidInviteEmail,
	PurchaseLayout,
	type Role,
	type SentInvite,
} from "@/components/org/org-purchase-ui";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { authClient } from "@/lib/auth/client";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";

type View = "pay" | "invite";

interface UpgradeOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Slug of the org being upgraded — used to route to its billing on the upsell. */
	orgSlug: string;
}

/**
 * The upgrade sheet for an existing Hobby org. Opens a payment intent for the active org
 * as soon as it's shown, pays through the shared checkout, then invites. The org must be
 * the active workspace (the server action is active-org-scoped).
 */
export function UpgradeOrgSheet({ open, onOpenChange, orgSlug }: UpgradeOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const { data: session } = authClient.useSession();
	const ownerEmail = session?.user?.email ?? "";

	const [view, setView] = useState<View>("pay");
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [sent, setSent] = useState<SentInvite[]>([]);

	const meta = planMeta("team");
	const teamPrice = useLivePlanPrice("team");

	// Open a subscription intent for the active org the moment the sheet opens. If a live
	// subscription already exists the action throws — surfaced inline rather than as a form.
	useEffect(() => {
		if (!open) return;
		let active = true;
		setView("pay");
		setClientSecret(null);
		setError(null);
		createSubscriptionIntent("team")
			.then((intent) => active && setClientSecret(intent.clientSecret))
			.catch(
				(e) =>
					active &&
					setError(
						e instanceof Error ? e.message : "Couldn't start the upgrade.",
					),
			);
		return () => {
			active = false;
		};
	}, [open]);

	function reset() {
		setView("pay");
		setClientSecret(null);
		setError(null);
		setInviteEmail("");
		setInviteRole("operator");
		setSent([]);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/**
	 * Card confirmed — the webhook activates the entitlement; persist billing details
	 * (best-effort) on the active org's customer, refresh the workspace so Pro features
	 * unlock immediately, then move to invite (a paid org can collaborate).
	 */
	async function handlePaid(billing: CollectedBilling) {
		try {
			try {
				await updateBillingAddress(billingAddressFrom(billing));
			} catch {
				// Non-fatal — Stripe already has the address from the payment method.
			}
			if (billing.taxValue.trim()) {
				try {
					await saveTaxId(billing.taxType, billing.taxValue);
				} catch {
					toast.warning("Couldn't save the tax id — add it later in billing.");
				}
			}
			if (billing.useAsPrimary) {
				try {
					await updateOrgPrimaryAddress(billingAddressFrom(billing));
				} catch {
					// Non-fatal — billing address is still set on the customer.
				}
			}
			await fetchWorkspace();
			toast.success("You're on Pro — invite your team.");
			setView("invite");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		}
	}

	/** Send one invite into the now-paid org. */
	async function addInvite() {
		const email = inviteEmail.trim();
		if (!isValidInviteEmail(email)) {
			toast.error("Enter a valid email to invite.");
			return;
		}
		try {
			await authClient.organization.inviteMember({ email, role: inviteRole });
			setSent((p) => [...p, { email, role: inviteRole }]);
			setInviteEmail("");
			toast.success(`Invitation sent to ${email}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't send the invite");
		}
	}

	/** Close + refresh so the upgraded plan/entitlements reflect everywhere. */
	function finish() {
		fetchWorkspace();
		handleOpenChange(false);
		router.refresh();
	}

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[92vw] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
			>
				<SheetTitle className="sr-only">Upgrade to Pro</SheetTitle>
				<SheetDescription className="sr-only">
					Upgrade this organization to Pro and invite your teammates.
				</SheetDescription>

				{view === "pay" ? (
					<PurchaseLayout
						meta={meta}
						heading="Upgrade to Pro"
						subheading="Add a payment method to unlock collaboration and higher limits."
						onClose={() => handleOpenChange(false)}
					>
						{error ? (
							<div className="space-y-3">
								<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-[12.5px] text-text-secondary">
									{error}
								</p>
								<Button
									variant="outline"
									className="w-full"
									onClick={() => handleOpenChange(false)}
								>
									Close
								</Button>
							</div>
						) : clientSecret ? (
							<StripeElementsProvider clientSecret={clientSecret}>
								<BillingCheckoutForm
									clientSecret={clientSecret}
									meta={meta}
									unitAmountUsd={teamPrice.unitAmountUsd}
									ownerEmail={ownerEmail}
									submitLabel="Upgrade"
									onPaid={(b) => handlePaid(b)}
								/>
							</StripeElementsProvider>
						) : (
							<div className="space-y-3">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-24 w-full" />
							</div>
						)}
					</PurchaseLayout>
				) : (
					<InviteView
						isTrialOrg={false}
						ownerEmail={ownerEmail}
						inviteEmail={inviteEmail}
						setInviteEmail={setInviteEmail}
						inviteRole={inviteRole}
						setInviteRole={setInviteRole}
						sent={sent}
						onAdd={() => void addInvite()}
						onFinish={finish}
						onAddPayment={() => {
							handleOpenChange(false);
							router.push(`/${orgSlug}/settings/billing`);
						}}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}
