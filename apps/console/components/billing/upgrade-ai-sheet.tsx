"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI-plan upgrade sheet. AI is a SEPARATE metered product from the org plan
// (tiers ai_free → ai_plus → ai_max), so this is a lean chooser (no invite/seat step, unlike
// the org sheet): pick a paid tier → open its subscription intent (createAiSubscriptionIntent)
// → pay through the SHARED checkout stack (StripeElementsProvider + BillingCheckoutForm +
// CurrencyToggle) → refresh the AI tier. Only the PAID tiers render — the free tier is where
// you already are, not an option to pick. Owner-gated server-side; a non-owner (or a personal
// workspace) surfaces a friendly inline error. When the deployment hasn't minted the Stripe AI
// prices yet (`paidTiersEnabled` false) the paid tiers render disabled with a "Coming soon"
// badge — the UI ships now and lights up automatically at go-live.
//
// AND THE LAUNCH STATE COMES FIRST (#6906, REL-L3). AI Plus and AI Max are sold behind the same
// gate as Pro, so when the server says nothing is on sale (`billing.salesOpen`, which honours the
// release gate's test-mode waiver) the paid tiers render disabled with the launch state's own
// sentence — "Paid plans available from 15 Feb 2027" or "Not on sale yet" — from the shared
// `salesClosedCopy`, not "Coming soon". A failed read falls through to the old behaviour: the
// eligibility gate behind the intent is still the authority.
//
// THE PAYER IS DECLARED BEFORE THE INTENT (#7324). Choosing a tier opens the same payer declaration
// the org upgrade sheet asks — capacity, country, the VAT-number question for an EU organization, a
// US state, and the billing address — and only then the intent, which carries the address to the
// Stripe customer before the first invoice exists. Nothing about the payer is saved after the charge.

import { Check } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { toast } from "sonner";
import {
	type AiUsageSummary,
	createAiSubscriptionIntent,
	getAiUsageSummary,
} from "@/app/server/actions/billing";
import { startCheckout } from "@/app/server/actions/checkout";
import { declarePayer, payerConversionStatus } from "@/app/server/actions/legal";
import {
	BillingCheckoutForm,
	type CheckoutPrefill,
} from "@/components/billing/billing-checkout-form";
import {
	BillingAddressForm,
	declaredPayerFacts,
	PayerDeclarationForm,
	type PayerDeclaration,
	refusalActionFor,
} from "@/components/billing/payer-declaration-form";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { salesClosedCopy } from "@/components/billing/launch-copy";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { useViewer } from "@/components/providers/viewer-provider";
import { track } from "@/lib/analytics/track";
import type { PaidAiTier } from "@/lib/billing/config";
import {
	billingIntentErrorMessage,
	CHECKOUT_CLOSED_MESSAGE,
	checkoutErrorMessage,
} from "@/lib/billing/intent-error";
import { openPaddleCheckout } from "@/lib/billing/paddle-js";
import { rpcClient } from "@/lib/rpc/client";
import {
	type AiPlanCatalogEntry,
	aiPlanMeta,
	PAID_AI_PLANS,
	type SupportedCurrency,
} from "@repo/plan-catalog";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

type View = "choose" | "declare" | "address" | "pay";

interface UpgradeAiSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called after a confirmed upgrade so the caller can refetch its AI summary. */
	onUpgraded?: () => void;
}

/** Narrow a catalog id to a paid AI tier (`ai_plus`/`ai_max`), or null for the free tier. */
function paidTierOf(entry: AiPlanCatalogEntry): PaidAiTier | null {
	if (entry.id === "ai_plus") return "ai_plus";
	if (entry.id === "ai_max") return "ai_max";
	return null;
}

/**
 * The AI upgrade sheet. Self-fetches the AI summary on open (current tier + the
 * `paidTiersEnabled` gate), lets the owner pick a paid tier, then drops into the shared
 * checkout for that tier's subscription. No seat/invite step — AI is a flat product.
 */
export function UpgradeAiSheet({ open, onOpenChange, onUpgraded }: UpgradeAiSheetProps) {
	const router = useRouter();
	const params = useParams();
	const orgSlug = typeof params?.org === "string" ? params.org : null;
	const { viewer } = useViewer();
	const ownerEmail = viewer?.email ?? "";
	// The declared payer facts (#7324). Null until declared; the intent effect waits on them.
	const [declaration, setDeclaration] = useState<PayerDeclaration | null>(null);
	// The facts the gate accepted, waiting for the billing address (#7324).
	const [declared, setDeclared] = useState<PayerDeclaration | null>(null);
	const [declaring, setDeclaring] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [refusalAction, setRefusalAction] = useState<{ href: string; label: string } | null>(null);
	const clearRefusal = useCallback(() => {
		setRefusal(null);
		setRefusalAction(null);
	}, []);

	const [summary, setSummary] = useState<AiUsageSummary | null>(null);
	const [view, setView] = useState<View>("choose");
	const [tier, setTier] = useState<PaidAiTier | null>(null);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	// `selected` is the explicit currency override (undefined = let the server geo-decide);
	// `currency` is what the created intent actually used (Stripe locks it) — drives display.
	const [selected, setSelected] = useState<SupportedCurrency | undefined>(undefined);
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [error, setError] = useState<string | null>(null);
	// The purchase runs through Paddle's overlay: no card form and no currency toggle (O1).
	const [paddle, setPaddle] = useState(false);
	// Paddle reported the payment complete: the same close-out as a confirmed card. An effect event,
	// so the checkout effect does not re-run (and open a second transaction) when the close-out changes.
	const onPaddlePaid = useEffectEvent(() => void handlePaid());

	// Is anything on sale? The same server answer the org upgrade sheet reads. Asked with the plain
	// RPC client, not a query hook: this sheet is mounted by surfaces (the chat's budget card)
	// that sit outside any QueryClientProvider. `null` until answered, and on a failed read.
	const [salesOpen, setSalesOpen] = useState<boolean | null>(null);
	const notOnSale = salesOpen === false ? salesClosedCopy().notice : null;

	// Load the canonical AI summary when the sheet opens — the current tier drives the
	// "Current"/"Upgrade" affordances and `paidTiersEnabled` drives the "Coming soon" gate.
	useEffect(() => {
		if (!open) return;
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setSummary(s))
			.catch(() => {
				/* best-effort — the chooser just shows skeletons */
			});
		rpcClient.billing
			.salesOpen()
			.then((answer) => alive && setSalesOpen(answer.open))
			.catch(() => {
				/* fail through — the eligibility gate behind the intent is still the authority */
			});
		return () => {
			alive = false;
		};
	}, [open]);

	// An intent belongs to one opening of the sheet. Whatever closes it — `handleOpenChange`, or a
	// parent setting `open` itself — the secret and error made while it was open are dropped in the
	// render that sees `open` change (React's "adjust state while rendering" form, keyed on the last
	// `open` seen), so a reopening never shows the previous opening's payment form.
	const [openSeen, setOpenSeen] = useState(open);
	if (openSeen !== open) {
		setOpenSeen(open);
		setClientSecret(null);
		setError(null);
	}

	// Open (or re-open, on a currency switch) the subscription intent once a paid tier is
	// picked. Stripe locks a subscription's currency at creation, so the toggle re-creates it.
	// The previous intent's secret and error are dropped by whatever changed the request (`choose`,
	// `switchCurrency`, Back) or by the opening changing (above), so the render that asks again
	// already shows neither.
	useEffect(() => {
		if (!open || !tier || !declaration) return;
		let alive = true;
		const billingAddress = declaration.billingAddress;
		// `startCheckout` routes by provider: Paddle opens its overlay on a server-created transaction;
		// Stripe answers "stripe" and the embedded card flow continues as before.
		void (async () => {
			const started = await startCheckout({
				item: { kind: "ai_tier", tier },
				...(billingAddress ? { billingAddress } : {}),
			});
			if (!alive) return;
			if (!started.ok) {
				setError(checkoutErrorMessage(started.error));
				return;
			}
			if (started.data.provider === "paddle") {
				setPaddle(true);
				await openPaddleCheckout({
					...started.data,
					onCompleted: () => onPaddlePaid(),
					onClosed: () => setError(CHECKOUT_CLOSED_MESSAGE),
				});
				return;
			}
			const intent = await createAiSubscriptionIntent(tier, {
				...(selected ? { currency: selected } : {}),
				...(billingAddress ? { billingAddress } : {}),
			});
			if (!alive) return;
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
		})().catch((error) => alive && setError(billingIntentErrorMessage(error)));
		return () => {
			alive = false;
		};
	}, [open, tier, selected, declaration]);

	/** Reset all transient state (called on close). */
	function reset() {
		setView("choose");
		setTier(null);
		setClientSecret(null);
		setSelected(undefined);
		setCurrency("usd");
		setError(null);
		setDeclaration(null);
		setDeclared(null);
		setDeclaring(false);
		setRefusal(null);
		setRefusalAction(null);
		setPaddle(false);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Begin checkout for a paid tier — records the choice and asks who is paying first. */
	function choose(next: PaidAiTier) {
		track("upgrade_started", { plan: next, context: "ai_upgrade_sheet" });
		setClientSecret(null);
		setError(null);
		setTier(next);
		setView("declare");
	}

	/**
	 * Records the declaration, asks the gate, and only then moves to payment — the order the org
	 * upgrade sheet uses, for the same reason: a refusal thrown by the intent reaches the sheet with
	 * its reason erased.
	 */
	async function handleDeclare(next: PayerDeclaration) {
		if (declaring) return;
		setDeclaring(true);
		clearRefusal();
		try {
			const facts = declaredPayerFacts(next);
			await declarePayer(facts);
			const verdict = await payerConversionStatus(facts);
			if (!verdict.allowed) {
				setRefusal(verdict.message);
				setRefusalAction(refusalActionFor(verdict.reason, orgSlug));
				return;
			}
			// The address comes next, still before any intent (#7324).
			setDeclared(next);
			setView("address");
		} catch (e) {
			setRefusal(
				e instanceof Error ? e.message : "Couldn't record who this purchase is for — try again.",
			);
		} finally {
			setDeclaring(false);
		}
	}

	/** The billing address, after the gate said yes and before the intent, which carries it (#7324). */
	function handleAddress(address: NonNullable<PayerDeclaration["billingAddress"]>) {
		if (!declared) return;
		setClientSecret(null);
		setError(null);
		setDeclaration({ ...declared, billingAddress: address });
		setView("pay");
	}

	/** The currency toggle: drops the intent made in the old currency, then asks in the new one. */
	function switchCurrency(next: SupportedCurrency) {
		setClientSecret(null);
		setError(null);
		setSelected(next);
	}

	/**
	 * Card confirmed — the webhook flips the org's AI tier; refetch/refresh so the new tier reflects
	 * everywhere, then close. The address and any VAT number went in BEFORE the intent (#7324).
	 */
	async function handlePaid() {
		onUpgraded?.();
		router.refresh();
		toast.success(`You're on ${aiPlanMeta(tier ?? "ai_plus").name}.`);
		handleOpenChange(false);
	}

	const currentTier = summary?.tier ?? "ai_free";
	const paidTiersEnabled = summary?.paidTiersEnabled ?? false;
	const meta = tier ? aiPlanMeta(tier) : null;

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-[92vw] gap-0 sm:max-w-md">
				<SheetHeader>
					<SheetTitle>
						{view !== "choose" && meta ? `Upgrade to ${meta.name}` : "Upgrade your AI plan"}
					</SheetTitle>
					<SheetDescription>
						{view === "declare" || view === "address"
								? "Tell us who this purchase is for, then add a payment method."
								: view === "pay"
									? "Add a payment method to raise your session and weekly limits."
							: "AI is billed separately from your workspace plan. A paid plan raises your session and weekly limits and deepens what Elench can do."}
					</SheetDescription>
				</SheetHeader>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
					{view === "choose" ? (
						<ChooserView
							summary={summary}
							currentTier={currentTier}
							paidTiersEnabled={paidTiersEnabled}
							notOnSale={notOnSale}
							onChoose={choose}
						/>
					) : view === "declare" ? (
						<PayerDeclarationForm
							busy={declaring}
							refusal={refusal}
							refusalAction={refusalAction}
							onEdit={clearRefusal}
							submitLabel="Continue to payment"
							onBack={() => {
								setView("choose");
								setTier(null);
								clearRefusal();
							}}
							onDeclare={(d) => void handleDeclare(d)}
						/>
					) : view === "address" && declared ? (
						<BillingAddressForm
							country={declared.billingCountry}
							state={declared.billingState ?? null}
							busy={false}
							submitLabel="Continue to payment"
							onBack={() => {
								setDeclared(null);
								setView("declare");
							}}
							onSubmit={handleAddress}
						/>
					) : (
						<PayView
							meta={meta}
							currency={currency}
							clientSecret={clientSecret}
							error={error}
							ownerEmail={ownerEmail}
							onCurrencyChange={switchCurrency}
							showCurrency={!paddle}
							prefilled={declaration?.billingAddress ?? null}
							onBack={() => {
								setView("choose");
								setTier(null);
								setClientSecret(null);
								setError(null);
								setDeclaration(null);
							}}
							onClose={() => handleOpenChange(false)}
							onPaid={handlePaid}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

/** The plan chooser — one card per PAID tier (the free tier is where you already are, so
 *  it never renders), gated behind the launch state (`notOnSale`) and then `paidTiersEnabled`
 *  ("Coming soon" until the Stripe prices are minted). Exactly one primary button: the
 *  recommended selectable tier. */
function ChooserView({
	summary,
	currentTier,
	paidTiersEnabled,
	notOnSale,
	onChoose,
}: {
	summary: AiUsageSummary | null;
	currentTier: string;
	paidTiersEnabled: boolean;
	/** The launch state's notice when nothing is on sale, else `null`. */
	notOnSale: string | null;
	onChoose: (tier: PaidAiTier) => void;
}) {
	if (!summary) {
		return (
			<div className="space-y-3">
				{[0, 1].map((i) => (
					<Skeleton key={i} className="h-40 w-full" />
				))}
			</div>
		);
	}
	const purchasable = paidTiersEnabled && notOnSale === null;
	const selectableIds = PAID_AI_PLANS.filter(
		(entry) => entry.id !== currentTier && purchasable,
	).map((entry) => entry.id);
	// One primary CTA per view: the recommended selectable tier (else the first selectable).
	const primaryId =
		selectableIds.find(
			(id) => PAID_AI_PLANS.find((entry) => entry.id === id)?.recommended,
		) ?? selectableIds[0];
	return (
		<div className="space-y-3">
			{PAID_AI_PLANS.map((entry) => {
				const paid = paidTierOf(entry);
				const isCurrent = entry.id === currentTier;
				const comingSoon = notOnSale === null && !paidTiersEnabled;
				const selectable = paid !== null && !isCurrent && purchasable;
				return (
					<TierCard
						key={entry.id}
						entry={entry}
						isCurrent={isCurrent}
						comingSoon={comingSoon}
						notOnSale={notOnSale}
						selectable={selectable}
						primary={entry.id === primaryId}
						onChoose={() => paid && onChoose(paid)}
					/>
				);
			})}
			<p className="px-1 text-ui-xs text-text-tertiary">
				Billed monthly, cancel any time. Included usage refills on a rolling 5-hour
				session and a weekly cycle; top-up credit packs never expire.
			</p>
		</div>
	);
}

/** One paid AI plan as a selectable card — price-forward, grayscale, hairline borders. */
function TierCard({
	entry,
	isCurrent,
	comingSoon,
	notOnSale,
	selectable,
	primary,
	onChoose,
}: {
	entry: AiPlanCatalogEntry;
	isCurrent: boolean;
	comingSoon: boolean;
	/** The launch state's notice when nothing is on sale — the disabled button says it. */
	notOnSale: string | null;
	selectable: boolean;
	/** Whether this card carries the view's single primary CTA (the recommended tier). */
	primary: boolean;
	onChoose: () => void;
}) {
	// "$20 / mo" → a prominent amount + a quiet cadence ("$20" + "/ mo").
	const [amount, cadence] = entry.priceLabel.split(" / ");
	return (
		<div
			className={cn(
				"rounded-lg border bg-surface p-5 transition-colors",
				entry.recommended ? "border-border-strong" : "border-border",
				selectable && "hover:border-border-strong",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-display text-ui-lg font-semibold text-text-primary">
							{entry.name}
						</span>
						{isCurrent && (
							<Badge variant="secondary" className="font-mono text-ui-3xs uppercase">
								Current
							</Badge>
						)}
						{!isCurrent && entry.recommended && !comingSoon && notOnSale === null && (
							<Badge variant="secondary" className="font-mono text-ui-3xs uppercase">
								Recommended
							</Badge>
						)}
						{comingSoon && (
							<Badge variant="outline" className="font-mono text-ui-3xs uppercase">
								Coming soon
							</Badge>
						)}
					</div>
					<span className="text-ui-sm leading-snug text-text-secondary">
						{entry.tagline}
					</span>
				</div>
				<div className="flex shrink-0 items-baseline gap-1">
					<span className="font-display text-ui-xl font-semibold tracking-tight text-text-primary">
						{amount}
					</span>
					{cadence && (
						<span className="font-mono text-ui-xs text-text-tertiary">/ {cadence}</span>
					)}
				</div>
			</div>

			<ul className="mt-4 space-y-2 border-t border-border pt-4">
				{entry.highlights.map((h) => (
					<li key={h} className="flex gap-2 text-ui-sm text-text-secondary">
						<Check size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
						{h}
					</li>
				))}
			</ul>

			<Button
				type="button"
				size="sm"
				variant={selectable && primary ? "default" : "outline"}
				className="mt-4 w-full"
				disabled={!selectable}
				onClick={onChoose}
			>
				{isCurrent
					? "Your current plan"
					: notOnSale !== null
						? notOnSale
						: comingSoon
							? "Coming soon"
							: `Upgrade to ${entry.name}`}
			</Button>
		</div>
	);
}

/** The pay step — the shared checkout for the chosen AI tier (no seat/invite step). */
function PayView({
	meta,
	currency,
	clientSecret,
	error,
	ownerEmail,
	prefilled,
	onCurrencyChange,
	showCurrency,
	onBack,
	onClose,
	onPaid,
}: {
	meta: AiPlanCatalogEntry | null;
	currency: SupportedCurrency;
	clientSecret: string | null;
	error: string | null;
	ownerEmail: string;
	/** The address the declaration collected, shown instead of asked again. */
	prefilled: CheckoutPrefill | null;
	onCurrencyChange: (currency: SupportedCurrency) => void;
	/** False on the Paddle rail, which localises the price itself (O1). */
	showCurrency: boolean;
	onBack: () => void;
	onClose: () => void;
	onPaid: () => void | Promise<void>;
}) {
	if (!meta) return null;
	if (error) {
		return (
			<div className="space-y-3">
				<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
					{error}
				</p>
				<Button variant="outline" className="w-full" onClick={onClose}>
					Close
				</Button>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={onBack}
					className="text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
				>
					← Change plan
				</button>
				{showCurrency && (
					<CurrencyToggle
						value={currency}
						onChange={onCurrencyChange}
						disabled={!clientSecret}
					/>
				)}
			</div>
			{clientSecret ? (
				<StripeElementsProvider clientSecret={clientSecret}>
					<BillingCheckoutForm
						clientSecret={clientSecret}
						meta={meta}
						currency={currency}
						ownerEmail={ownerEmail}
						showMembers={false}
						submitLabel={`Subscribe to ${meta.name}`}
							scrollable
							prefilled={prefilled}
							collectTaxId={false}
						onPaid={onPaid}
					/>
				</StripeElementsProvider>
			) : (
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
			)}
		</div>
	);
}
