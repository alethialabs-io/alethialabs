"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Native, in-app payment-methods management (replaces the Stripe Customer Portal deep-link).
// Card data never touches our code — adding a card confirms a Stripe SetupIntent inside the
// embedded Payment Element (PCI SAQ-A). A card can be made default, promoted to / demoted
// from ordered dunning backups (and reordered), and removed — all via inline row actions.
//
// #6127: the cards are the `billing.paymentMethods` GET read, prefetched by the route, and every
// row action goes through the mutation contract (`useActionMutation`): the row is busy while its
// action is in flight (the double-submit guard), a refusal comes back as its own sentence, and a
// success invalidates the cards. A failed read is an error with a retry — it used to be set to
// `[]` and rendered as "No saved cards", which told a paying customer they had none.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	makeDefaultCard,
	recordCardSaved,
	removeCard as removeCardAction,
	saveBackupCards,
	startAddCard,
} from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { RegionError } from "@repo/ui/region-error";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import type { PaymentMethodInfo } from "@/lib/rpc/procedures/billing";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import {
	SettingsPanel,
	SettingsSection,
} from "@/components/settings/settings-ui";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

// `formatBrand` and `formatExpiry` deliberately stay local rather than moving to
// @repo/format: neither renders a QUANTITY. A card brand is a label to title-case, and a
// card expiry is the `MM/YYYY` convention printed on the card itself — not one of the
// package's date styles, which would turn "07/2027" into "July 2027".

/** Title-case a Stripe card brand (e.g. "visa" → "Visa", "amex" → "Amex"). */
function formatBrand(brand: string): string {
	if (!brand) return "Card";
	return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** Zero-padded `MM/YYYY` expiry label for a saved card. */
function formatExpiry(month: number, year: number): string {
	return `${String(month).padStart(2, "0")}/${year}`;
}

/** What a 3-D Secure redirect's return says, read from the URL Stripe sends the browser back to. */
type SetupReturn =
	| { kind: "none" }
	| { kind: "succeeded"; setupIntentId: string }
	| { kind: "processing" }
	| { kind: "failed"; clientSecret: string | null };

/**
 * Reads Stripe's return parameters (`setup_intent`, `setup_intent_client_secret`,
 * `redirect_status`) off a query string. `redirect_status` is `succeeded`, `processing` or
 * `failed`; an unknown value is read as a failure, because the one thing a person must not be told
 * is that a card was saved when it was not.
 */
export function readSetupReturn(search: string): SetupReturn {
	const params = new URLSearchParams(search);
	const setupIntentId = params.get("setup_intent");
	if (!setupIntentId) return { kind: "none" };
	const status = params.get("redirect_status");
	if (status === "succeeded") return { kind: "succeeded", setupIntentId };
	if (status === "processing") return { kind: "processing" };
	return { kind: "failed", clientSecret: params.get("setup_intent_client_secret") };
}

/** The toast a failed 3-D Secure return shows; the add-card dialog reopens under it. */
export const SETUP_FAILED_MESSAGE =
	"Your bank didn't confirm the card, so it wasn't saved. Try again or use another card.";

/** The toast a 3-D Secure return still being confirmed shows. */
export const SETUP_PROCESSING_MESSAGE =
	"Your bank is still confirming the card. It appears here once that finishes.";

/** The ordered list of backup payment-method ids (ranked backups, in rank order). */
function backupIds(cards: PaymentMethodInfo[]): string[] {
	return cards.filter((c) => c.backupRank !== null).map((c) => c.id);
}

/** A compact, always-visible inline row action (replaces the old ⋯ dropdown). */
function RowAction({
	onClick,
	disabled,
	destructive,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	destructive?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded-sm px-2 py-1 text-ui-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
				destructive
					? "text-destructive hover:bg-destructive/10"
					: "text-text-secondary hover:bg-surface-sunken hover:text-text-primary",
			)}
		>
			{children}
		</button>
	);
}

/** The Payment methods section: the saved cards, their row actions, and the add-card dialog. */
export function PaymentMethodsCard() {
	const queryClient = useQueryClient();
	const read = useQuery(orpc.billing.paymentMethods.queryOptions({ retry: retryUnlessRefused }));
	const cards = read.data ?? null;
	const [addOpen, setAddOpen] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<PaymentMethodInfo | null>(
		null,
	);

	// Every card mutation changes what this list shows, and only this list.
	const invalidates = [orpc.billing.paymentMethods.key()];
	const addIntent = useActionMutation(startAddCard, {
		invalidates: [],
		onSuccess: ({ clientSecret: cs }) => {
			setClientSecret(cs);
			setAddOpen(true);
		},
	});
	const setDefault = useActionMutation(makeDefaultCard, {
		invalidates,
		successMessage: "Default card updated.",
	});
	const setBackups = useActionMutation(saveBackupCards, {
		invalidates,
		successMessage: "Backup cards updated.",
	});
	const remove = useActionMutation(removeCardAction, {
		invalidates,
		successMessage: "Card removed.",
	});
	// While ANY card action is in flight, every row's actions are disabled: the backup order is one
	// list, so two reorders racing from two rows would each persist an order built from a stale one.
	const busy = setDefault.isPending || setBackups.isPending || remove.isPending;

	/**
	 * Open the add-card dialog. The SetupIntent is created on the first open and REUSED until a card
	 * is saved with it, so opening and closing the dialog does not leave a trail of unconfirmed
	 * SetupIntents in Stripe (#6733). Opening it records nothing; saving does.
	 */
	function openAddCard() {
		if (clientSecret) {
			setAddOpen(true);
			return;
		}
		if (addIntent.isPending) return;
		addIntent.mutate({});
	}

	// A card whose 3-D Secure step needed a FULL-PAGE redirect comes back here (the form's `return_url`
	// is this page) with Stripe's `setup_intent` / `redirect_status` params, and the inline success
	// path above never ran. This is the only place that save can be recorded: the webhook endpoint
	// is not subscribed to SetupIntent events (scripts/stripe-setup.ts WEBHOOK_EVENTS), and could
	// not name who saved the card. The server checks the SetupIntent with Stripe and records it at
	// most once, so a reload of this URL records nothing twice. The params are then removed.
	//
	// A return that did NOT succeed used to strip the params and say nothing, so a person whose bank
	// declined the challenge saw the page they left and no card (CON-L3, R6 F-09). It now says so and
	// reopens the add-card dialog. The failed SetupIntent goes back to `requires_payment_method`, so
	// the same client secret takes another card: reusing it is what `openAddCard` does anyway (#6733).
	useEffect(() => {
		const outcome = readSetupReturn(window.location.search);
		if (outcome.kind === "none") return;
		const params = new URLSearchParams(window.location.search);
		for (const key of ["setup_intent", "setup_intent_client_secret", "redirect_status"]) {
			params.delete(key);
		}
		const query = params.toString();
		window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
		if (outcome.kind === "failed") {
			toast.error(SETUP_FAILED_MESSAGE);
			const retrySecret = outcome.clientSecret;
			// Deferred one microtask rather than set in the effect body (react-hooks/set-state-in-effect).
			// Not a timer: the params are already stripped, so StrictMode's second run of this effect
			// sees `none`, and a cleanup that cancelled a timer would lose the reopen altogether.
			if (retrySecret) {
				queueMicrotask(() => {
					setClientSecret(retrySecret);
					setAddOpen(true);
				});
			}
			return;
		}
		if (outcome.kind === "processing") {
			toast.message(SETUP_PROCESSING_MESSAGE);
			void queryClient.invalidateQueries({ queryKey: orpc.billing.paymentMethods.key() });
			return;
		}
		toast.success("Card saved.");
		void recordCardSaved({ setupIntentId: outcome.setupIntentId }).catch(() => undefined);
		void queryClient.invalidateQueries({ queryKey: orpc.billing.paymentMethods.key() });
	}, [queryClient]);

	/** Card saved in Stripe — record it, close the dialog and re-read the list. */
	function handleCardAdded(setupIntentId: string | null) {
		setAddOpen(false);
		setClientSecret(null);
		toast.success("Card saved.");
		// The Activity record of the save. The card is saved whatever this answers, so a failure is
		// not shown as one: telling the user "something went wrong" would read as the card failing.
		if (setupIntentId) void recordCardSaved({ setupIntentId }).catch(() => undefined);
		void queryClient.invalidateQueries({ queryKey: orpc.billing.paymentMethods.key() });
	}

	/** Make a card the default (primary) payment method. */
	function makeDefault(card: PaymentMethodInfo) {
		setDefault.mutate({ pmId: card.id });
	}

	/** Persists a new backup order. */
	function persistBackups(pmIds: string[]) {
		setBackups.mutate({ pmIds });
	}

	/** Append a card to the end of the ordered backup list. */
	function makeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		persistBackups([...backupIds(cards).filter((id) => id !== card.id), card.id]);
	}

	/** Drop a card from the ordered backup list. */
	function removeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		persistBackups(backupIds(cards).filter((id) => id !== card.id));
	}

	/** Swap a backup card with its neighbour (dir −1 = up, +1 = down) and persist. */
	function moveBackup(card: PaymentMethodInfo, dir: -1 | 1) {
		if (!cards) return;
		const ids = backupIds(cards);
		const i = ids.indexOf(card.id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		persistBackups(ids);
	}

	const backupCount = cards ? backupIds(cards).length : 0;

	return (
		<>
			<SettingsSection
				title="Payment methods"
				action={
					<Button size="sm" onClick={openAddCard} disabled={addIntent.isPending || cards === null}>
						<Plus size={14} />
						{addIntent.isPending ? "Loading…" : "Add payment method"}
					</Button>
				}
			>
				<SettingsPanel>
					{cards === null && read.isError ? (
						refusalOf(read.error) ? (
							<RegionRefusal
								className="border-0"
								refusal={refusalOf(read.error) ?? "forbidden"}
							/>
						) : (
							<RegionError
								title="Couldn't load saved cards"
								description="Something went wrong reading this organization's payment methods."
								onRetry={() => void read.refetch()}
							/>
						)
					) : cards === null ? (
						<div className="space-y-3 p-5">
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
						</div>
					) : cards.length === 0 ? (
						<p className="px-[22px] py-6 text-ui-sm text-text-tertiary">
							No saved cards — add one to keep your subscription active.
						</p>
					) : (
						cards.map((card) => {
							const rank = card.backupRank;
							const isBackup = rank !== null;
							return (
								<div
									key={card.id}
									className={cn(
										"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-[22px] py-[14px] last:border-b-0",
										// The default card is visually distinct (subtle tint).
										card.isDefault && "bg-surface-sunken",
									)}
								>
									<div className="flex min-w-0 items-center gap-3">
										<span className="text-ui-md font-medium text-text-primary">
											{formatBrand(card.brand)}
										</span>
										<span className="font-mono text-ui-sm text-text-secondary">
											•••• {card.last4}
										</span>
										<span className="font-mono text-ui-xs text-text-tertiary">
											exp {formatExpiry(card.expMonth, card.expYear)}
										</span>
										{card.isDefault && (
											<Badge className="px-2 py-[2px] font-mono text-ui-3xs uppercase tracking-[0.1em]">
												Default
											</Badge>
										)}
										{isBackup && (
											<Badge
												variant="outline"
												className="border-border-strong px-2 py-[2px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary"
											>
												Backup {rank + 1}
											</Badge>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-0.5">
										{isBackup && backupCount > 1 && (
											<>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup up"
													disabled={rank === 0 || busy}
													onClick={() => moveBackup(card, -1)}
												>
													<ChevronUp size={14} />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup down"
													disabled={rank === backupCount - 1 || busy}
													onClick={() => moveBackup(card, 1)}
												>
													<ChevronDown size={14} />
												</Button>
											</>
										)}
										{!card.isDefault && (
											<RowAction disabled={busy} onClick={() => makeDefault(card)}>
												Set default
											</RowAction>
										)}
										{!card.isDefault &&
											(isBackup ? (
												<RowAction disabled={busy} onClick={() => removeBackup(card)}>
													Remove backup
												</RowAction>
											) : (
												<RowAction disabled={busy} onClick={() => makeBackup(card)}>
													Make backup
												</RowAction>
											))}
										<RowAction
											destructive
											disabled={busy}
											onClick={() => setConfirmRemove(card)}
										>
											Remove
										</RowAction>
									</div>
								</div>
							);
						})
					)}
				</SettingsPanel>
			</SettingsSection>

			{/* Add-card dialog — confirms a SetupIntent (card data stays in Stripe's iframe). */}
			<Dialog
				open={addOpen}
				// Closing keeps the SetupIntent: the next open reuses it rather than minting another.
				onOpenChange={setAddOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add payment method</DialogTitle>
						<DialogDescription>
							Your card is stored securely by Stripe — we never see the number.
						</DialogDescription>
					</DialogHeader>
					{clientSecret && (
						<StripeElementsProvider clientSecret={clientSecret}>
							<PaymentForm
								mode="setup"
								submitLabel="Save card"
								onSuccess={handleCardAdded}
								onError={(m) => toast.error(m)}
							/>
						</StripeElementsProvider>
					)}
				</DialogContent>
			</Dialog>

			{/* The console's one confirmation: it runs the removal, stays open with the button busy
			    while it is in flight, and closes only when it has succeeded — a refusal leaves it up
			    beside its toast instead of closing as if the card were gone. */}
			<ConfirmAction
				open={confirmRemove !== null}
				onOpenChange={(o) => {
					if (!o) setConfirmRemove(null);
				}}
				title="Remove this card?"
				description={
					confirmRemove
						? `${formatBrand(confirmRemove.brand)} •••• ${confirmRemove.last4} will be detached from your billing account. This can't be undone.`
						: ""
				}
				confirmLabel="Remove card"
				pendingLabel="Removing…"
				severity={{ level: "confirm" }}
				mutation={remove}
				variables={confirmRemove ? { pmId: confirmRemove.id } : null}
			/>
		</>
	);
}
