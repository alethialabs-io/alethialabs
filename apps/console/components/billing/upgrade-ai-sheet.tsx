"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI-tier upgrade sheet. AI is a SEPARATE metered product from the org plan
// (tiers ai_free → ai_plus → ai_max), so this is a lean chooser (no invite/seat step, unlike
// the org sheet): pick a paid tier → open its subscription intent (createAiSubscriptionIntent)
// → pay through the SHARED checkout stack (StripeElementsProvider + BillingCheckoutForm +
// CurrencyToggle) → refresh the AI tier. Owner-gated server-side; a non-owner (or a personal
// workspace) surfaces a friendly inline error. When the deployment hasn't minted the Stripe AI
// prices yet (`paidTiersEnabled` false) the paid tiers render disabled with a "Coming soon"
// badge — the UI ships now and lights up automatically at go-live.

import { Check, Sparkles, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type AiUsageSummary,
	createAiSubscriptionIntent,
	getAiUsageSummary,
	saveTaxId,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import type { PaidAiTier } from "@/lib/billing/config";
import {
	AI_PLAN_CATALOG,
	type AiPlanCatalogEntry,
	aiPlanMeta,
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

type View = "choose" | "pay";

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
	const { data: session } = authClient.useSession();
	const ownerEmail = session?.user?.email ?? "";

	const [summary, setSummary] = useState<AiUsageSummary | null>(null);
	const [view, setView] = useState<View>("choose");
	const [tier, setTier] = useState<PaidAiTier | null>(null);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	// `selected` is the explicit currency override (undefined = let the server geo-decide);
	// `currency` is what the created intent actually used (Stripe locks it) — drives display.
	const [selected, setSelected] = useState<SupportedCurrency | undefined>(undefined);
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [error, setError] = useState<string | null>(null);

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
		return () => {
			alive = false;
		};
	}, [open]);

	// Open (or re-open, on a currency switch) the subscription intent once a paid tier is
	// picked. Stripe locks a subscription's currency at creation, so the toggle re-creates it.
	useEffect(() => {
		if (!open || !tier) return;
		let alive = true;
		setClientSecret(null);
		setError(null);
		createAiSubscriptionIntent(tier, selected ? { currency: selected } : undefined)
			.then((intent) => {
				if (!alive) return;
				setClientSecret(intent.clientSecret);
				setCurrency(intent.currency);
			})
			.catch(
				(e) =>
					alive &&
					setError(e instanceof Error ? e.message : "Couldn't start the upgrade."),
			);
		return () => {
			alive = false;
		};
	}, [open, tier, selected]);

	/** Reset all transient state (called on close). */
	function reset() {
		setView("choose");
		setTier(null);
		setClientSecret(null);
		setSelected(undefined);
		setCurrency("usd");
		setError(null);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Begin checkout for a paid tier — records the intent and swaps to the pay view. */
	function choose(next: PaidAiTier) {
		track("upgrade_started", { plan: next, context: "ai_upgrade_sheet" });
		setTier(next);
		setView("pay");
	}

	/**
	 * Card confirmed — the webhook flips the org's AI tier; persist billing details
	 * (best-effort), refetch/refresh so the new tier reflects everywhere, then close.
	 */
	async function handlePaid(billing: CollectedBilling) {
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
						{view === "pay" && meta ? `Upgrade to ${meta.name}` : "Upgrade your AI plan"}
					</SheetTitle>
					<SheetDescription>
						{view === "pay"
							? "Add a payment method to raise your AI limits and advisor model."
							: "AI is billed separately from your workspace plan. Pick a tier — credit packs stack on top of any tier."}
					</SheetDescription>
				</SheetHeader>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
					{view === "choose" ? (
						<ChooserView
							summary={summary}
							currentTier={currentTier}
							paidTiersEnabled={paidTiersEnabled}
							onChoose={choose}
						/>
					) : (
						<PayView
							meta={meta}
							currency={currency}
							clientSecret={clientSecret}
							error={error}
							ownerEmail={ownerEmail}
							onCurrencyChange={setSelected}
							onBack={() => {
								setView("choose");
								setTier(null);
								setClientSecret(null);
								setError(null);
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

/** The tier chooser — a card per AI tier, with the current tier marked and paid tiers
 *  gated behind `paidTiersEnabled` ("Coming soon" when the Stripe prices aren't minted). */
function ChooserView({
	summary,
	currentTier,
	paidTiersEnabled,
	onChoose,
}: {
	summary: AiUsageSummary | null;
	currentTier: string;
	paidTiersEnabled: boolean;
	onChoose: (tier: PaidAiTier) => void;
}) {
	if (!summary) {
		return (
			<div className="space-y-3">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-28 w-full" />
				))}
			</div>
		);
	}
	return (
		<div className="space-y-3">
			{AI_PLAN_CATALOG.map((entry) => {
				const paid = paidTierOf(entry);
				const isCurrent = entry.id === currentTier;
				// A paid tier is choosable only when it's not the current tier and the deployment
				// has the Stripe AI prices (else it's a "Coming soon" preview).
				const comingSoon = paid !== null && !paidTiersEnabled;
				const selectable = paid !== null && !isCurrent && paidTiersEnabled;
				return (
					<TierCard
						key={entry.id}
						entry={entry}
						isCurrent={isCurrent}
						comingSoon={comingSoon}
						selectable={selectable}
						onChoose={() => paid && onChoose(paid)}
					/>
				);
			})}
			<p className="px-1 text-[11px] text-text-tertiary">
				Prices are billed monthly and can be canceled any time. Included AI usage resets on a
				fixed schedule; top-up credit packs never expire.
			</p>
		</div>
	);
}

/** One AI tier as a selectable card (grayscale/squared). */
function TierCard({
	entry,
	isCurrent,
	comingSoon,
	selectable,
	onChoose,
}: {
	entry: AiPlanCatalogEntry;
	isCurrent: boolean;
	comingSoon: boolean;
	selectable: boolean;
	onChoose: () => void;
}) {
	const Icon = entry.id === "ai_max" ? Sparkles : Zap;
	return (
		<div
			className={cn(
				"rounded-lg border border-border bg-surface p-4 transition-colors",
				selectable && "hover:border-border-strong",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<div className="flex items-center gap-2">
						{entry.paid && <Icon size={14} className="text-text-secondary" />}
						<span className="font-display text-[14px] font-semibold text-text-primary">
							{entry.name}
						</span>
						{isCurrent && (
							<Badge variant="secondary" className="font-mono text-[9px] uppercase">
								Current
							</Badge>
						)}
						{comingSoon && (
							<Badge variant="outline" className="font-mono text-[9px] uppercase">
								Coming soon
							</Badge>
						)}
					</div>
					<span className="font-mono text-[10.5px] text-text-tertiary">{entry.advisor}</span>
				</div>
				<span className="shrink-0 font-mono text-[12px] text-text-secondary">
					{entry.priceLabel}
				</span>
			</div>

			<ul className="mt-3 space-y-1.5">
				{entry.highlights.map((h) => (
					<li key={h} className="flex gap-2 text-[12px] text-text-secondary">
						<Check size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
						{h}
					</li>
				))}
			</ul>

			{entry.paid && (
				<Button
					type="button"
					size="sm"
					variant={selectable ? "default" : "outline"}
					className="mt-3 w-full"
					disabled={!selectable}
					onClick={onChoose}
				>
					{isCurrent
						? "Your current plan"
						: comingSoon
							? "Coming soon"
							: `Upgrade to ${entry.name}`}
				</Button>
			)}
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
	onCurrencyChange,
	onBack,
	onClose,
	onPaid,
}: {
	meta: AiPlanCatalogEntry | null;
	currency: SupportedCurrency;
	clientSecret: string | null;
	error: string | null;
	ownerEmail: string;
	onCurrencyChange: (currency: SupportedCurrency) => void;
	onBack: () => void;
	onClose: () => void;
	onPaid: (billing: CollectedBilling) => void | Promise<void>;
}) {
	if (!meta) return null;
	if (error) {
		return (
			<div className="space-y-3">
				<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-[12.5px] text-text-secondary">
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
					className="text-[12px] text-text-secondary transition-colors hover:text-text-primary"
				>
					← Change plan
				</button>
				<CurrencyToggle
					value={currency}
					onChange={onCurrencyChange}
					disabled={!clientSecret}
				/>
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
