"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create a paid Pro organization — a two-column purchase modal:
//   • LEFT (persistent): the "What's included" checklist (PlanChecklist).
//   • RIGHT (progressive): State 1 = team name → State 2 = the payer declaration → State 3 =
//     the shared BillingCheckoutForm (split-card payment). Then a fourth "invite" view after
//     the org exists.
//
// THE DECLARATION STEP EXISTS BECAUSE THIS PATH HAS NO ROW TO READ IT FROM (#4633). Every other
// conversion reads `organization_billing.payer_capacity`; here the organization does not exist
// yet, so `createNewOrgSubscriptionIntent` takes the payer facts as a PARAMETER — one this sheet
// never passed, which refused every create-a-paid-team attempt at the eligibility gate. They are
// declared before the intent, carried through payment, persisted by `linkSubscriptionToNewOrg`,
// and completed with the authority attestation by `declarePayer` once the org exists.
//
// The TRIAL branch is deliberately untouched: a card-less trial is not a paid conversion, does
// not pass the gate, and has no purchase for a declaration to be made at the moment of.
// The org is created ONLY after the card is confirmed (deferred create:
// createNewOrgSubscriptionIntent → confirmCardPayment → linkSubscriptionToNewOrg), so a
// Stripe failure can never orphan an org. If the account still holds its one trial, a
// card-less "Start trial" path creates a solo trial org instead (trials can't invite).
// The two-column shell, invite view, and small form primitives are shared with the
// upgrade-org sheet via ./org-purchase-ui.

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	attachTaxIdToCustomer,
	createNewOrgSubscriptionIntent,
	getProOffer,
	isOrgSlugAvailable,
	linkSubscriptionToNewOrg,
	type ProOffer,
	setCustomerBillingAddress,
	startProTrial,
} from "@/app/server/actions/billing";
import { declarePayer, payerConversionStatus } from "@/app/server/actions/legal";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import {
	PayerDeclarationForm,
	type PayerDeclaration,
} from "@/components/billing/payer-declaration-form";
import {
	Field,
	InviteView,
	isValidInviteEmail,
	PurchaseLayout,
	type Role,
	type SentInvite,
} from "@/components/org/org-purchase-ui";
import {
	clearPendingPaidSetup,
	readPendingPaidSetup,
	writePendingPaidSetup,
} from "@/components/org/pending-paid-setup";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { authClient } from "@/lib/auth/client";
import { useViewer } from "@/components/providers/viewer-provider";
import { track } from "@/lib/analytics/track";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { orgHost } from "@/lib/org-url";
import {
	ORG_SLUG_RESERVED_CODE,
	ORG_SLUG_RESERVED_MESSAGE,
	RESERVED_SLUGS,
} from "@/lib/routing";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";

/** The sentence for a slug that is in use — the same one `configureOnboardingOrg` returns. */
const SLUG_TAKEN = "That slug is taken — try another.";
/** The sentence for a slug a console route or sibling app owns — `configureOnboardingOrg`'s, the
 *  Settings rename's and the server-side organization hooks' too (one constant, lib/routing.ts). */
const SLUG_RESERVED = ORG_SLUG_RESERVED_MESSAGE;

const schema = z.object({
	name: z.string().trim().min(2, "Give your team a name."),
	slug: z
		.string()
		.trim()
		.min(1, "Pick a slug.")
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens.")
		// Checked HERE, not left to `isOrgSlugAvailable`: that action answers one boolean for both
		// "reserved" and "taken", so a reserved slug ("docs") used to be refused as TAKEN — a sentence
		// that sends the user looking for an organization that does not exist (#5442). RESERVED_SLUGS
		// is the same set the action and `configureOnboardingOrg` consult, so the two cannot disagree.
		.refine((s) => !RESERVED_SLUGS.has(s), SLUG_RESERVED),
});
type FormData = z.infer<typeof schema>;

type View = "name" | "declare" | "pay" | "invite";

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const { viewer } = useViewer();
	const ownerEmail = viewer?.email ?? "";
	const viewerId = viewer?.id ?? "";

	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", slug: "" },
		mode: "onChange",
	});
	const name = form.watch("name");
	const slug = form.watch("slug");

	const [slugTouched, setSlugTouched] = useState(false);
	const [showUrl, setShowUrl] = useState(false);
	const [view, setView] = useState<View>("name");
	const [offer, setOffer] = useState<ProOffer | null>(null);
	const [busy, setBusy] = useState(false);

	// Deferred-create payment refs (carried across a Back→retry so neither the customer
	// nor the incomplete subscription duplicates in Stripe).
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [customerId, setCustomerId] = useState<string | null>(null);
	const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
	// Billing currency of the open intent (Stripe locks it) + the validated org name, so the
	// currency toggle can re-create the intent for the same org.
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [switchingCurrency, setSwitchingCurrency] = useState(false);
	const [checkoutOrgName, setCheckoutOrgName] = useState("");
	// The payer facts, declared before the intent and carried all the way to the org that does not
	// exist yet. Null until the customer answers — nothing here is defaulted.
	const [declaration, setDeclaration] = useState<PayerDeclaration | null>(null);
	const [declaring, setDeclaring] = useState(false);
	/** The gate's own sentence when it refused this declaration, shown on the declaration step. */
	const [refusal, setRefusal] = useState<string | null>(null);
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
	const [createdSlug, setCreatedSlug] = useState("");
	// Payment succeeded but the org create / link then failed — offer a retry (no second
	// charge) rather than the payment form. `lastBilling` lets the retry re-run setup.
	const [needsSetupRetry, setNeedsSetupRetry] = useState(false);
	const [lastBilling, setLastBilling] = useState<CollectedBilling | null>(null);
	/**
	 * The charge went through and THEN the slug was refused at the create — claimed by another team
	 * while this one paid (#5445). The retry must not re-use the colliding slug, so it asks for a new
	 * one. No new payment intent is needed for that: the intent carries the org's NAME and the payer
	 * facts, never its slug, and the org itself is only created after the charge — so changing the
	 * slug before that create is changing nothing anyone has paid for.
	 */
	const [slugClaimedAfterPayment, setSlugClaimedAfterPayment] = useState(false);
	/**
	 * A close was asked for while a paid setup is unfinished. The sheet stays open and asks first:
	 * closing used to `reset()` the subscription and customer ids — the only link between the charge
	 * and the team it was for — so the customer was left charged with no organization, and reopening
	 * started a new purchase.
	 */
	const [confirmingClose, setConfirmingClose] = useState(false);
	/**
	 * The subscription is linked to the created org. A retry after a LATER step failed (the payer
	 * declaration) must not link again: `linkSubscriptionToNewOrg` refuses an already-linked
	 * subscription, so the retry could never succeed.
	 */
	const [linked, setLinked] = useState(false);

	// Invite step.
	const [isTrialOrg, setIsTrialOrg] = useState(false);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [sent, setSent] = useState<SentInvite[]>([]);

	const meta = planMeta("team");
	const teamPrice = useLivePlanPrice("team", currency);
	const trialAvailable = offer?.kind === "trial";

	// Resolve the account's Pro offer (trial vs pay) when the sheet opens.
	useEffect(() => {
		if (!open) return;
		let active = true;
		getProOffer()
			.then((o) => active && setOffer(o))
			.catch(() => active && setOffer({ kind: "none" }));
		return () => {
			active = false;
		};
	}, [open]);

	// A paid setup that has not finished is written to the tab's sessionStorage while it is pending,
	// so closing the sheet (or navigating away inside the console) does not lose the subscription it
	// is for. Removed once the subscription is linked — see `handlePaid`.
	useEffect(() => {
		if (!needsSetupRetry || !viewerId || linked) return;
		if (!subscriptionId || !customerId || !declaration || !lastBilling) return;
		writePendingPaidSetup(viewerId, {
			subscriptionId,
			customerId,
			name,
			slug,
			currency,
			declaration,
			billing: lastBilling,
			createdOrgId,
			createdSlug,
			slugClaimedAfterPayment,
		});
	}, [
		needsSetupRetry,
		viewerId,
		subscriptionId,
		customerId,
		declaration,
		lastBilling,
		name,
		slug,
		currency,
		createdOrgId,
		createdSlug,
		slugClaimedAfterPayment,
		linked,
	]);

	// Reopening the sheet resumes a pending paid setup on the retry screen instead of starting a new
	// purchase. Only when nothing is in flight in memory: an open intent of this session wins.
	useEffect(() => {
		if (!open || !viewerId || subscriptionId) return;
		const pending = readPendingPaidSetup(viewerId);
		if (!pending) return;
		form.reset({ name: pending.name, slug: pending.slug });
		setSlugTouched(true);
		setCheckoutOrgName(pending.name);
		setSubscriptionId(pending.subscriptionId);
		setCustomerId(pending.customerId);
		setCurrency(pending.currency);
		setDeclaration(pending.declaration);
		setLastBilling(pending.billing);
		setCreatedOrgId(pending.createdOrgId);
		setCreatedSlug(pending.createdSlug);
		setSlugClaimedAfterPayment(pending.slugClaimedAfterPayment);
		setNeedsSetupRetry(true);
		setView("pay");
		// `form` is stable for the component's life; re-running on `subscriptionId` would re-read
		// storage after every intent. The read is for the moment the sheet opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, viewerId]);

	// Closing the TAB is outside the sheet's reach and outside sessionStorage's scope, so while a paid
	// setup is unfinished the browser is asked to confirm leaving the page.
	useEffect(() => {
		if (!needsSetupRetry) return;
		/** Asks the browser to confirm leaving while a paid setup is unfinished. */
		const warn = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [needsSetupRetry]);

	function reset() {
		form.reset({ name: "", slug: "" });
		setSlugTouched(false);
		setShowUrl(false);
		setView("name");
		setBusy(false);
		setClientSecret(null);
		setCustomerId(null);
		setSubscriptionId(null);
		setCreatedOrgId(null);
		setCreatedSlug("");
		setDeclaration(null);
		setDeclaring(false);
		setRefusal(null);
		setNeedsSetupRetry(false);
		setLastBilling(null);
		setSlugClaimedAfterPayment(false);
		setConfirmingClose(false);
		setLinked(false);
		setIsTrialOrg(false);
		setInviteEmail("");
		setInviteRole("operator");
		setSent([]);
	}

	/**
	 * Opens or closes the sheet. A close while a paid setup is unfinished is held for confirmation
	 * (see `confirmingClose`); every other close resets the sheet.
	 */
	function handleOpenChange(next: boolean) {
		if (!next && needsSetupRetry && !confirmingClose) {
			setConfirmingClose(true);
			return;
		}
		if (!next) reset();
		onOpenChange(next);
	}

	/**
	 * The confirmed close of an unfinished paid setup. The setup stays in sessionStorage (written by
	 * the effect above), so reopening the sheet in this tab resumes it on the retry screen.
	 */
	function closeKeepingPaidSetup() {
		reset();
		onOpenChange(false);
	}

	/** Close the sheet and drop the user into their new organization. */
	function goToOrg() {
		fetchWorkspace();
		handleOpenChange(false);
		if (createdSlug) router.push(`/${createdSlug}`);
		else router.refresh();
	}

	/**
	 * Validate the form + slug availability before any Stripe / org work. A refused slug opens the
	 * URL editor, so the field the sentence is about is on screen to change — an auto-derived slug
	 * is otherwise only a line of preview text under the name.
	 */
	async function validate(): Promise<FormData | null> {
		if (!(await form.trigger())) {
			if (form.getFieldState("slug").invalid) setShowUrl(true);
			return null;
		}
		const data = form.getValues();
		if (!(await isOrgSlugAvailable(data.slug))) {
			form.setError("slug", { message: SLUG_TAKEN });
			setShowUrl(true);
			return null;
		}
		return data;
	}

	/**
	 * Creates the org (with the chosen slug) and scopes the session to it. Returns the
	 * id + persisted slug, or null when the slug collided (error surfaced inline).
	 */
	async function createOrg(
		data: FormData,
	): Promise<{ id: string; slug: string } | null> {
		const { data: org, error } = await authClient.organization.create({
			name: data.name,
			slug: data.slug,
		});
		if (error || !org) {
			// The server's reserved-slug hook (ee/) answers with its own code: say RESERVED, not taken.
			// Checked first because its sentence contains "slug", which the pattern below would read
			// as a collision.
			if (error?.code === ORG_SLUG_RESERVED_CODE) {
				form.setError("slug", { message: SLUG_RESERVED });
				setShowUrl(true);
				return null;
			}
			if (/slug|unique|exist|taken/i.test(error?.message ?? "")) {
				form.setError("slug", { message: SLUG_TAKEN });
				setShowUrl(true);
				return null;
			}
			throw new Error(error?.message ?? "Couldn't create the organization");
		}
		setCreatedOrgId(org.id);
		const persisted = org.slug ?? data.slug;
		setCreatedSlug(persisted);
		await setActiveOrganization(org.id);
		return { id: org.id, slug: persisted };
	}

	/**
	 * Step 1 → step 2. Trial-eligible accounts go straight to the card-less trial panel (no
	 * Stripe intent, and no declaration — a trial is not a purchase); everyone else goes to the
	 * payer declaration, which is what the intent needs. Validation (name + slug availability)
	 * runs before either branch.
	 *
	 * NO INTENT IS OPENED HERE ANY MORE. It used to be, without payer facts, and the eligibility
	 * gate refused every one of them.
	 */
	async function continueToCheckout() {
		if (busy) return;
		setBusy(true);
		try {
			const data = await validate();
			if (!data) return;
			if (trialAvailable) {
				// Card-less trial — the trial panel confirms; no payment intent needed.
				setView("pay");
				return;
			}
			setCheckoutOrgName(data.name);
			setRefusal(null);
			setView("declare");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	/**
	 * Step 2 → step 3. Asks the gate whether a sale under these declared facts is permitted, then
	 * opens the subscription intent CARRYING them.
	 *
	 * The verdict is asked for over a return value rather than inferred from a thrown intent,
	 * because `createNewOrgSubscriptionIntent` refuses by throwing and the reason does not survive
	 * the server-action boundary — the customer would get "Something went wrong" for a decision the
	 * product made on purpose and can explain.
	 *
	 * The facts are NOT written here. There is no organization yet, so there is no row to write
	 * them on; `linkSubscriptionToNewOrg` persists the capacity and country at the moment one
	 * exists, and `declarePayer` completes the record with the attestation.
	 */
	async function handleDeclare(next: PayerDeclaration) {
		if (declaring) return;
		setDeclaring(true);
		setRefusal(null);
		try {
			const verdict = await payerConversionStatus(next);
			if (!verdict.allowed) {
				setRefusal(verdict.message);
				return;
			}
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: checkoutOrgName,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
				payer: {
					capacity: next.capacity,
					billingCountry: next.billingCountry,
				},
			});
			setSubscriptionId(intent.subscriptionId);
			setCustomerId(intent.customerId);
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
			setDeclaration(next);
			setView("pay");
		} catch (e) {
			setRefusal(
				e instanceof Error ? e.message : "Couldn't start the purchase — try again.",
			);
		} finally {
			setDeclaring(false);
		}
	}

	/** Switch the checkout currency by re-creating the intent for the same org (Stripe locks
	 *  a sub's currency). Reuses the customer + cancels the prior incomplete sub. The declared
	 *  payer rides along: the new intent passes the same gate the first one did. */
	async function changeCurrency(next: SupportedCurrency) {
		if (next === currency || switchingCurrency || !checkoutOrgName || !declaration) return;
		setSwitchingCurrency(true);
		try {
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: checkoutOrgName,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
				currency: next,
				payer: {
					capacity: declaration.capacity,
					billingCountry: declaration.billingCountry,
				},
			});
			setSubscriptionId(intent.subscriptionId);
			setCustomerId(intent.customerId);
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't switch currency.");
		} finally {
			setSwitchingCurrency(false);
		}
	}

	/** Trial path: create the org now (card-less) and burn the account's one trial. If the
	 *  trial fails AFTER the org was created, roll the org back so we never leave an orphan
	 *  (no billing) behind. */
	async function startTrial() {
		if (busy) return;
		setBusy(true);
		try {
			// A slug refused here (claimed since Continue, or at the create itself) is a field error on
			// the NAME step, so go back to it — on the trial panel it rendered nowhere, and the button
			// simply stopped doing anything.
			const data = await validate();
			if (!data) {
				setView("name");
				return;
			}
			const org = await createOrg(data);
			if (!org) {
				setView("name");
				return;
			}
			try {
				// The org just created, NOT the ambient one — this sheet is open on a page inside the
				// CURRENT org, so ambient would burn the account's one trial on the wrong org and then
				// delete the new org in the catch below.
				await startProTrial({ orgId: org.id });
				track("trial_started", { plan: "team", context: "create_org" });
			} catch (trialErr) {
				// Roll back the just-created org — a failed trial must not orphan it.
				await authClient.organization
					.delete({ organizationId: org.id })
					.catch(() => {});
				setCreatedOrgId(null);
				setCreatedSlug("");
				throw trialErr;
			}
			await fetchWorkspace();
			setIsTrialOrg(true);
			toast.success("Trial started — your organization is ready.");
			setView("invite");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start the trial");
		} finally {
			setBusy(false);
		}
	}

	/**
	 * Card confirmed — persist billing details on the standalone customer, create + link
	 * the org so its entitlement is live immediately, then move to invite. Idempotent on
	 * retry via createdOrgId: if a step fails after the charge we keep the refs + offer a
	 * retry instead of re-charging. Address / tax / primary-address saves are best-effort.
	 */
	async function handlePaid(billing: CollectedBilling) {
		setBusy(true);
		setNeedsSetupRetry(false);
		setSlugClaimedAfterPayment(false);
		setLastBilling(billing);
		try {
			if (!subscriptionId || !customerId) {
				throw new Error("Missing payment reference — please retry.");
			}
			if (!declaration) {
				// Unreachable from the UI (the declaration is what opened the intent), and a throw
				// rather than a silent skip because the alternative is a paid org whose payer was
				// never recorded — refused at its very next conversion, with nothing to say why.
				throw new Error("Missing the payer declaration — please retry.");
			}
			try {
				await setCustomerBillingAddress({
					customerId,
					address: billingAddressFrom(billing),
				});
			} catch {
				// Non-fatal — Stripe still has the address from the payment method.
			}
			if (billing.taxValue.trim()) {
				try {
					await attachTaxIdToCustomer({
						customerId,
						type: billing.taxType,
						value: billing.taxValue,
					});
				} catch {
					toast.warning("Couldn't save the tax id — add it later in billing.");
				}
			}

			let orgId = createdOrgId;
			if (!orgId) {
				const org = await createOrg(form.getValues());
				if (!org) {
					// Paid, and the slug was refused at the create. This used to `return` here with the
					// customer on the payment view and nothing on screen — the refusal was written to a
					// field on the NAME step, which is not rendered here. Ask for a new slug instead.
					setSlugClaimedAfterPayment(true);
					setNeedsSetupRetry(true);
					return;
				}
				orgId = org.id;
			}
			if (!linked) {
				await linkSubscriptionToNewOrg({
					orgId,
					subscriptionId,
					customerId,
					payer: {
						capacity: declaration.capacity,
						billingCountry: declaration.billingCountry,
					},
				});
				setLinked(true);
				// Linked: the charge now belongs to an organization, so there is nothing left to resume.
				if (viewerId) clearPendingPaidSetup(viewerId);
			}
			// Completes the record with the attestation, which `linkSubscriptionToNewOrg` does not
			// carry. NAMED org, never ambient: this sheet is open on a page inside the CURRENT org,
			// so an ambient declaration would land on the old one — the #4133 failure, which is
			// silent here because both writes would succeed.
			await declarePayer(declaration, { orgId });
			await fetchWorkspace();
			if (billing.useAsPrimary) {
				try {
					// The org just created — ambient here is the page's org, and this `catch` is why
					// overwriting it was silent.
					await updateOrgPrimaryAddress(billingAddressFrom(billing), orgId);
				} catch {
					// Non-fatal — billing address is still set on the customer.
				}
			}
			setIsTrialOrg(false);
			toast.success("Subscription active — your organization is ready.");
			setView("invite");
		} catch (e) {
			setNeedsSetupRetry(true);
			toast.error(
				e instanceof Error
					? e.message
					: "Payment succeeded but setup failed — retry, you won't be charged again.",
			);
		} finally {
			setBusy(false);
		}
	}

	/**
	 * The retry after a post-payment slug refusal: re-check the NEW slug (format, reserved, taken)
	 * and finish setup with it. A slug still refused stays on screen under the field and nothing is
	 * re-run; no new charge is ever made — `handlePaid` reuses the confirmed subscription.
	 */
	async function retryWithNewSlug() {
		if (busy || !lastBilling) return;
		setBusy(true);
		let data: FormData | null = null;
		try {
			data = await validate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't check that slug — try again.");
		} finally {
			setBusy(false);
		}
		if (data) await handlePaid(lastBilling);
	}

	/** Send one invite into the created (paid) org. Trials are solo (see beforeCreate). */
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

	const heading =
		view === "pay" || view === "declare" ? `Create ${name || "team"}` : "Create a team";

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				<SheetTitle className="sr-only">Create a team</SheetTitle>
				<SheetDescription className="sr-only">
					Create a Pro team, pay, and invite your teammates.
				</SheetDescription>

				{(view === "name" || view === "declare" || view === "pay") && (
					<PurchaseLayout
						meta={meta}
						heading={heading}
						onClose={() => handleOpenChange(false)}
					>
						{view === "name" ? (
							<NamePanel
								form={form}
								slug={slug}
								showUrl={showUrl}
								setShowUrl={setShowUrl}
								slugTouched={slugTouched}
								setSlugTouched={setSlugTouched}
								busy={busy}
								ready={offer !== null}
								onContinue={() => void continueToCheckout()}
							/>
						) : view === "declare" ? (
							<PayerDeclarationForm
								busy={declaring}
								refusal={refusal}
								submitLabel="Continue to payment"
								onBack={() => setView("name")}
								onDeclare={(d) => void handleDeclare(d)}
							/>
						) : needsSetupRetry && confirmingClose ? (
							<ConfirmCloseUnfinished
								onStay={() => setConfirmingClose(false)}
								onClose={closeKeepingPaidSetup}
							/>
						) : needsSetupRetry && slugClaimedAfterPayment ? (
							<RetryWithNewSlug
								form={form}
								slug={slug}
								busy={busy}
								onRetry={() => void retryWithNewSlug()}
							/>
						) : needsSetupRetry ? (
							<RetrySetup
								busy={busy}
								onRetry={() => lastBilling && void handlePaid(lastBilling)}
							/>
						) : trialAvailable ? (
							<TrialPanel
								busy={busy}
								priceLabel={teamPrice.label}
								trialDays={offer?.trialDays ?? 30}
								onBack={() => setView("name")}
								onStart={() => void startTrial()}
							/>
						) : (
							clientSecret && (
								<div className="flex min-h-0 flex-1 flex-col gap-4">
									<div className="flex shrink-0 items-center justify-between">
										<button
											type="button"
											onClick={() => {
												// Back to the DECLARATION, not the name: it is the step
												// immediately behind this one, and re-declaring is how a
												// payer corrects a capacity or country they got wrong.
												setView("declare");
												setClientSecret(null);
											}}
											className="text-left text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
										>
											← Back
										</button>
										<CurrencyToggle
											value={currency}
											onChange={changeCurrency}
											disabled={switchingCurrency}
										/>
									</div>
									<StripeElementsProvider clientSecret={clientSecret}>
										<BillingCheckoutForm
											clientSecret={clientSecret}
											meta={meta}
											unitAmount={teamPrice.unitAmount}
											currency={currency}
											ownerEmail={ownerEmail}
											submitLabel="Create"
											scrollable
											onPaid={(b) => handlePaid(b)}
										/>
									</StripeElementsProvider>
								</div>
							)
						)}
					</PurchaseLayout>
				)}

				{view === "invite" && (
					<InviteView
						isTrialOrg={isTrialOrg}
						ownerEmail={ownerEmail}
						inviteEmail={inviteEmail}
						setInviteEmail={setInviteEmail}
						inviteRole={inviteRole}
						setInviteRole={setInviteRole}
						sent={sent}
						onAdd={() => void addInvite()}
						onFinish={goToOrg}
						onAddPayment={() => {
							handleOpenChange(false);
							router.push(
								createdSlug ? `/${createdSlug}/settings/billing` : "/dashboard",
							);
						}}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

// ── Create-specific views ──────────────────────────────────────────────────────

/** State 1 — team name (auto-slug) + a single Continue. Trial-vs-pay is decided in step 2. */
function NamePanel({
	form,
	slug,
	showUrl,
	setShowUrl,
	slugTouched,
	setSlugTouched,
	busy,
	ready,
	onContinue,
}: {
	form: UseFormReturn<FormData>;
	slug: string;
	showUrl: boolean;
	setShowUrl: (v: boolean) => void;
	slugTouched: boolean;
	setSlugTouched: (v: boolean) => void;
	busy: boolean;
	/** False until the Pro offer (trial vs pay) has resolved, so step 2 routes correctly. */
	ready: boolean;
	onContinue: () => void;
}) {
	const slugErrorId = useId();
	const slugError = form.formState.errors.slug?.message;
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onContinue();
			}}
			className="flex flex-col gap-4"
		>
			<Field label="Team name" required error={form.formState.errors.name?.message}>
				{(id) => (
					<>
						<Input
							id={id}
							placeholder="Acme Cloud"
							autoComplete="off"
							autoFocus
							{...form.register("name")}
							onChange={(e) => {
								const v = e.target.value;
								form.setValue("name", v, { shouldValidate: true });
								if (!slugTouched)
									form.setValue("slug", slugifyOrEmpty(v), { shouldValidate: true });
							}}
						/>
						<div className="flex items-center justify-between pt-1">
							<span className="font-mono text-ui-xs text-text-tertiary">
								{orgHost()}/<span className="text-text-secondary">{slug || "org"}</span>
							</span>
							<button
								type="button"
								onClick={() => setShowUrl(!showUrl)}
								className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
							>
								{showUrl ? "Done" : "Customize URL"}
							</button>
						</div>
						{showUrl && (
							<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
								<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
									{orgHost()}/
								</span>
								<input
									aria-label="URL slug"
									// Tied to the sentence below, so a screen reader landing on the field hears
									// why it was refused — the alert is announced once, the description every
									// time the field is focused (#5445).
									aria-invalid={slugError ? true : undefined}
									aria-describedby={slugError ? slugErrorId : undefined}
									className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
									placeholder="acme-cloud"
									autoComplete="off"
									value={slug}
									onChange={(e) => {
										setSlugTouched(true);
										form.setValue("slug", slugifyOrEmpty(e.target.value), {
											shouldValidate: true,
										});
									}}
								/>
							</div>
						)}
						{slugError && (
							<p id={slugErrorId} role="alert" className="text-ui-xs text-destructive">
								{slugError}
							</p>
						)}
					</>
				)}
			</Field>

			<Button type="submit" disabled={busy || !ready} className="w-full">
				{busy ? "Setting up…" : "Continue"}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/**
 * Step 2 (trial-eligible) — a card-less 30-day trial. Shows $0 due now / price after, and
 * a single "Start free trial" CTA. No payment form: a free trial has no reason to decline.
 */
function TrialPanel({
	busy,
	priceLabel,
	trialDays,
	onBack,
	onStart,
}: {
	busy: boolean;
	/** Live Stripe price label shown for "after the trial". */
	priceLabel: string;
	trialDays: number;
	onBack: () => void;
	onStart: () => void;
}) {
	return (
		<div className="space-y-4">
			<button
				type="button"
				onClick={onBack}
				className="text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				← Back
			</button>

			<div className="rounded-lg border border-border">
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<span className="text-ui-md font-medium text-text-primary">Due today</span>
					<span className="font-display text-ui-xl font-semibold text-text-primary">
						$0
					</span>
				</div>
				<div className="flex items-center justify-between px-4 py-3 text-ui-sm text-text-secondary">
					<span>After your {trialDays}-day free trial</span>
					<span className="font-mono text-ui-sm text-text-primary">
						{priceLabel}
					</span>
				</div>
			</div>

			<Button type="button" className="w-full" disabled={busy} onClick={onStart}>
				{busy ? "Setting up…" : `Start ${trialDays}-day free trial`}
				<ArrowRight size={15} />
			</Button>
			<p className="text-center font-mono text-ui-2xs text-text-tertiary">
				No charge during the trial · cancel anytime
			</p>
		</div>
	);
}

/**
 * Paid, and the slug was claimed by another team before the org could be created (#5445). Says so,
 * and asks for a new URL in place — the only field that changes; the name and the payment stand.
 */
function RetryWithNewSlug({
	form,
	slug,
	busy,
	onRetry,
}: {
	form: UseFormReturn<FormData>;
	slug: string;
	busy: boolean;
	onRetry: () => void;
}) {
	const inputId = useId();
	const errorId = useId();
	const slugError = form.formState.errors.slug?.message;
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				onRetry();
			}}
		>
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				Your payment went through, but your team couldn&apos;t be created at that URL — the
				reason is below. Choose a different URL to finish setting up; you won&apos;t be charged
				again.
			</p>
			<label htmlFor={inputId} className="block text-ui-md font-medium text-text-primary">
				Team URL
			</label>
			<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
				<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
					{orgHost()}/
				</span>
				<input
					id={inputId}
					aria-invalid={slugError ? true : undefined}
					aria-describedby={slugError ? errorId : undefined}
					className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
					autoComplete="off"
					value={slug}
					onChange={(e) =>
						form.setValue("slug", slugifyOrEmpty(e.target.value), { shouldValidate: true })
					}
				/>
			</div>
			{slugError && (
				<p id={errorId} role="alert" className="text-ui-xs text-destructive">
					{slugError}
				</p>
			)}
			<Button type="submit" className="w-full" disabled={busy}>
				{busy ? "Finishing…" : "Complete setup"}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/**
 * Asked before the sheet closes on an unfinished paid setup. States what happens to the payment and
 * where the setup can be finished; "Close for now" keeps it in this tab's sessionStorage.
 */
function ConfirmCloseUnfinished({
	onStay,
	onClose,
}: {
	onStay: () => void;
	onClose: () => void;
}) {
	return (
		<div className="space-y-3">
			<p className="text-ui-md font-medium text-text-primary">
				Close before your team is set up?
			</p>
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				Your payment went through and is kept for this team. To finish later, open Create a team
				again in this browser tab — it picks up here, and you won&apos;t be charged again.
				Closing the browser tab itself does not keep it.
			</p>
			<Button className="w-full" onClick={onStay}>
				Finish setup now
				<ArrowRight size={15} />
			</Button>
			<Button variant="outline" className="w-full" onClick={onClose}>
				Close for now
			</Button>
		</div>
	);
}

/** Paid, but org create/link failed after the charge — finish setup, no re-charge. */
function RetrySetup({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
	return (
		<div className="space-y-3">
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				Your payment went through, but we couldn&apos;t finish setting up the team. You
				won&apos;t be charged again — retry to complete setup.
			</p>
			<Button className="w-full" disabled={busy} onClick={onRetry}>
				{busy ? "Finishing…" : "Complete setup"}
				<ArrowRight size={15} />
			</Button>
		</div>
	);
}
