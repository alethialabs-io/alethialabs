"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Upgrade an EXISTING Hobby organization to Pro — the sibling of the create-org sheet,
// minus the name step (the org already exists). It DECLARES the payer, opens a subscription
// intent on the ACTIVE org (createSubscriptionIntent), takes payment through the shared
// BillingCheckoutForm, then — since a paid org can now collaborate — drops into the
// shared invite view. Best-effort billing-detail persistence mirrors the create flow.
// Shares the two-column shell / invite view / primitives with the create sheet via
// ./org-purchase-ui. Owner-gated server-side; refuses if a live subscription exists.
//
// THE DECLARATION IS A STEP, AND IT COMES FIRST (#4633). This sheet used to fire
// createSubscriptionIntent from a `useEffect` the moment it opened — before its own form could
// collect anything — and the eligibility gate refused every one of those calls for an undeclared
// payer capacity. The customer then read "Billing may not be configured on this deployment",
// which blamed the operator for a rule the product enforces. The intent is not opened until the
// payer has been declared and the gate has been asked, in that order.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	createSubscriptionIntent,
	saveTaxId,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import { declarePayer, payerConversionStatus } from "@/app/server/actions/legal";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import {
	PayerDeclarationForm,
	type PayerDeclaration,
} from "@/components/billing/payer-declaration-form";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import {
	InviteView,
	isValidInviteEmail,
	PurchaseLayout,
	type Role,
	type SentInvite,
} from "@/components/org/org-purchase-ui";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { billingIntentErrorMessage } from "@/lib/billing/intent-error";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";

type View = "declare" | "pay" | "invite";

interface UpgradeOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Slug of the org being upgraded — used to route to its billing on the upsell. */
	orgSlug: string;
}

/**
 * The upgrade sheet for an existing Hobby org. Declares the payer, opens a payment intent for
 * the active org, pays through the shared checkout, then invites. The org must be the active
 * workspace (the server action is active-org-scoped).
 */
export function UpgradeOrgSheet({ open, onOpenChange, orgSlug }: UpgradeOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const { data: session } = authClient.useSession();
	const ownerEmail = session?.user?.email ?? "";

	const [view, setView] = useState<View>("declare");
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The declared payer facts. Null until the customer answers, and the intent effect below is
	// gated on it — this is what keeps the conversion from being attempted undeclared.
	const [declaration, setDeclaration] = useState<PayerDeclaration | null>(null);
	const [declaring, setDeclaring] = useState(false);
	// The gate's own sentence when it refused THIS declaration (a closed market, unaccepted terms),
	// shown on the declaration step rather than swapped in for the whole sheet: the answer may be
	// one the customer can change.
	const [refusal, setRefusal] = useState<string | null>(null);
	// `selected` is the explicit currency override (undefined = let the server geo-decide);
	// `currency` is what the created intent actually used (Stripe locks it) — drives display.
	const [selected, setSelected] = useState<SupportedCurrency | undefined>(undefined);
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");

	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [sent, setSent] = useState<SentInvite[]>([]);

	const meta = planMeta("team");
	const teamPrice = useLivePlanPrice("team", currency);

	// Announce the attempt when the sheet opens, but open NOTHING: the subscription intent is an
	// effect of the declaration, not of the sheet being visible.
	useEffect(() => {
		if (!open) return;
		track("upgrade_started", { plan: "team", context: "upgrade_sheet" });
	}, [open]);

	// Open a subscription intent once the payer has been declared (and re-open it when the
	// currency toggle changes — Stripe locks a sub's currency at creation). If a live
	// subscription already exists the action throws — surfaced inline rather than as a form.
	useEffect(() => {
		if (!open || !declaration) return;
		let active = true;
		setClientSecret(null);
		setError(null);
		createSubscriptionIntent("team", selected ? { currency: selected } : undefined)
			.then((intent) => {
				if (!active) return;
				if ("error" in intent) {
					setError(intent.error);
					return;
				}
				setClientSecret(intent.clientSecret);
				setCurrency(intent.currency);
			})
			.catch((e) => {
				if (!active) return;
				// Keep the real cause where an engineer can read it, and show the customer a
				// sentence about the product.
				console.error("[upgrade] createSubscriptionIntent failed", e);
				setError(billingIntentErrorMessage(e));
			});
		return () => {
			active = false;
		};
	}, [open, selected, declaration]);

	function reset() {
		setView("declare");
		setClientSecret(null);
		setError(null);
		setDeclaration(null);
		setDeclaring(false);
		setRefusal(null);
		setSelected(undefined);
		setCurrency("usd");
		setInviteEmail("");
		setInviteRole("operator");
		setSent([]);
	}

	/**
	 * Records the declaration, asks the gate whether it permits a sale, and only then moves to
	 * payment.
	 *
	 * The order is the point. `declarePayer` FIRST and unconditionally: the capacity and country
	 * are facts the payer gave us, and they stay true whether or not we may sell into that market
	 * today — writing them is also what lifts `capacity_not_declared` for every later conversion
	 * this org attempts. `payerConversionStatus` SECOND, because a refusal that arrives as a thrown
	 * error from `createSubscriptionIntent` reaches this component with its reason erased, and the
	 * customer would be shown the generic "billing may not be configured" sentence for a rule the
	 * product itself enforces.
	 */
	async function handleDeclare(next: PayerDeclaration) {
		if (declaring) return;
		setDeclaring(true);
		setRefusal(null);
		try {
			await declarePayer(next);
			const verdict = await payerConversionStatus(next);
			if (!verdict.allowed) {
				setRefusal(verdict.message);
				return;
			}
			setDeclaration(next);
			setView("pay");
		} catch (e) {
			setRefusal(
				e instanceof Error
					? e.message
					: "Couldn't record who this purchase is for — try again.",
			);
		} finally {
			setDeclaring(false);
		}
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
				className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				<SheetTitle className="sr-only">Upgrade to Pro</SheetTitle>
				<SheetDescription className="sr-only">
					Upgrade this organization to Pro and invite your teammates.
				</SheetDescription>

				{view === "declare" ? (
					<PurchaseLayout
						meta={meta}
						heading="Upgrade to Pro"
						subheading="Tell us who this purchase is for, then add a payment method."
						onClose={() => handleOpenChange(false)}
					>
						<PayerDeclarationForm
							busy={declaring}
							refusal={refusal}
							submitLabel="Continue to payment"
							onDeclare={(d) => void handleDeclare(d)}
						/>
					</PurchaseLayout>
				) : view === "pay" ? (
					<PurchaseLayout
						meta={meta}
						heading="Upgrade to Pro"
						subheading="Add a payment method to unlock collaboration and higher limits."
						onClose={() => handleOpenChange(false)}
					>
						{!error && (
							<div className="mb-3 flex items-center justify-between">
								<span className="text-ui-sm text-text-secondary">Billing currency</span>
								<CurrencyToggle
									value={currency}
									onChange={setSelected}
									disabled={!clientSecret}
								/>
							</div>
						)}
						{error ? (
							<div className="space-y-3">
								<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
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
									unitAmount={teamPrice.unitAmount}
									currency={currency}
									ownerEmail={ownerEmail}
									submitLabel="Upgrade"
									scrollable
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
