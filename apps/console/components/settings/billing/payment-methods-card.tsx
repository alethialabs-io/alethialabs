"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Native, in-app payment-methods + billing-details management (replaces the Stripe
// Customer Portal deep-link). Card data never touches our code — adding a card confirms
// a Stripe SetupIntent inside the embedded Payment Element (PCI SAQ-A). Cards can be set
// default, promoted to / demoted from ordered dunning backups (and reordered), and
// removed. Billing details (name / address / VAT id) are read from the Stripe customer
// and edited via a react-hook-form + zod form. Data loads with useEffect/useState (this
// area does not use TanStack Query — matches billing-panel.tsx).

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	type BillingDetails,
	createSetupIntent,
	detachPaymentMethod,
	getBillingDetails,
	listPaymentMethods,
	type PaymentMethodInfo,
	saveTaxId,
	setBackupCards,
	setDefaultPaymentMethod,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import {
	SettingsCardFoot,
	SettingsField,
	SettingsPanel,
	SettingsSection,
} from "@/components/settings/settings-ui";
import {
	DEFAULT_TAX_ID_TYPE,
	TAX_ID_TYPES,
	type TaxIdType,
} from "@/lib/billing/tax-ids";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { CountrySelect } from "@repo/ui/country-select";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Skeleton } from "@repo/ui/skeleton";

/** Title-case a Stripe card brand (e.g. "visa" → "Visa", "amex" → "Amex"). */
function formatBrand(brand: string): string {
	if (!brand) return "Card";
	return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** Zero-padded `MM/YYYY` expiry label for a saved card. */
function formatExpiry(month: number, year: number): string {
	return `${String(month).padStart(2, "0")}/${year}`;
}

/** The ordered list of backup payment-method ids (ranked backups, in rank order). */
function backupIds(cards: PaymentMethodInfo[]): string[] {
	return cards.filter((c) => c.backupRank !== null).map((c) => c.id);
}

export function PaymentMethodsCard() {
	const [cards, setCards] = useState<PaymentMethodInfo[] | null>(null);
	const [details, setDetails] = useState<BillingDetails | null>(null);
	const [detailsLoaded, setDetailsLoaded] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [addingIntent, setAddingIntent] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<PaymentMethodInfo | null>(
		null,
	);

	/** Reload the saved cards + billing details from Stripe. */
	const refresh = useCallback(() => {
		listPaymentMethods()
			.then(setCards)
			.catch(() => {
				setCards([]);
				toast.error("Couldn't load saved cards.");
			});
		getBillingDetails()
			.then(setDetails)
			.catch(() => toast.error("Couldn't load billing details."))
			.finally(() => setDetailsLoaded(true));
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	/** Open the add-card dialog after creating a SetupIntent for the embedded form. */
	async function openAddCard() {
		if (addingIntent) return;
		setAddingIntent(true);
		try {
			const { clientSecret: cs } = await createSetupIntent();
			setClientSecret(cs);
			setAddOpen(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start adding a card.");
		} finally {
			setAddingIntent(false);
		}
	}

	/** Card saved in Stripe — close the dialog and refetch the list. */
	function handleCardAdded() {
		setAddOpen(false);
		setClientSecret(null);
		toast.success("Card saved.");
		refresh();
	}

	/** Run a per-card mutation with a busy marker + refetch, surfacing errors as toasts. */
	async function runCardAction(id: string, fn: () => Promise<unknown>) {
		setPendingId(id);
		try {
			await fn();
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong.");
		} finally {
			setPendingId(null);
		}
	}

	/** Make a card the default (primary) payment method. */
	function makeDefault(card: PaymentMethodInfo) {
		void runCardAction(card.id, () => setDefaultPaymentMethod(card.id));
	}

	/** Append a card to the end of the ordered backup list. */
	function makeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		const next = [...backupIds(cards).filter((id) => id !== card.id), card.id];
		void runCardAction(card.id, () => setBackupCards(next));
	}

	/** Drop a card from the ordered backup list. */
	function removeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		const next = backupIds(cards).filter((id) => id !== card.id);
		void runCardAction(card.id, () => setBackupCards(next));
	}

	/** Swap a backup card with its neighbour (dir −1 = up, +1 = down) and persist. */
	function moveBackup(card: PaymentMethodInfo, dir: -1 | 1) {
		if (!cards) return;
		const ids = backupIds(cards);
		const i = ids.indexOf(card.id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		void runCardAction(card.id, () => setBackupCards(ids));
	}

	/** Detach the confirmed card from the customer. */
	function removeCard(card: PaymentMethodInfo) {
		setConfirmRemove(null);
		void runCardAction(card.id, () => detachPaymentMethod(card.id));
	}

	const backupCount = cards ? backupIds(cards).length : 0;

	return (
		<>
			<SettingsSection
				title="Payment methods"
				action={
					<Button size="sm" onClick={() => void openAddCard()} disabled={addingIntent}>
						<Plus size={14} />
						{addingIntent ? "Loading…" : "Add payment method"}
					</Button>
				}
			>
				<SettingsPanel>
					{cards === null ? (
						<div className="space-y-3 p-5">
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
						</div>
					) : cards.length === 0 ? (
						<p className="px-[22px] py-6 text-[12.5px] text-text-tertiary">
							No saved cards — add one to keep your subscription active.
						</p>
					) : (
						cards.map((card) => {
							const rank = card.backupRank;
							const isBackup = rank !== null;
							return (
								<div
									key={card.id}
									className="flex items-center justify-between gap-4 border-b border-border px-[22px] py-[14px] last:border-b-0"
								>
									<div className="flex min-w-0 items-center gap-3">
										<span className="text-[13px] font-medium text-text-primary">
											{formatBrand(card.brand)}
										</span>
										<span className="font-mono text-[12.5px] text-text-secondary">
											•••• {card.last4}
										</span>
										<span className="font-mono text-[11.5px] text-text-tertiary">
											exp {formatExpiry(card.expMonth, card.expYear)}
										</span>
										{card.isDefault && (
											<Badge className="px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em]">
												Default
											</Badge>
										)}
										{isBackup && (
											<Badge
												variant="outline"
												className="border-border-strong px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-secondary"
											>
												Backup {rank + 1}
											</Badge>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{isBackup && backupCount > 1 && (
											<>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup up"
													disabled={rank === 0 || pendingId === card.id}
													onClick={() => moveBackup(card, -1)}
												>
													<ChevronUp size={14} />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup down"
													disabled={rank === backupCount - 1 || pendingId === card.id}
													onClick={() => moveBackup(card, 1)}
												>
													<ChevronDown size={14} />
												</Button>
											</>
										)}
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Card actions"
													disabled={pendingId === card.id}
												>
													<MoreHorizontal size={15} />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												{!card.isDefault && (
													<DropdownMenuItem onSelect={() => makeDefault(card)}>
														Set as default
													</DropdownMenuItem>
												)}
												{!card.isDefault && !isBackup && (
													<DropdownMenuItem onSelect={() => makeBackup(card)}>
														Make backup
													</DropdownMenuItem>
												)}
												{isBackup && (
													<DropdownMenuItem onSelect={() => removeBackup(card)}>
														Remove backup
													</DropdownMenuItem>
												)}
												<DropdownMenuSeparator />
												<DropdownMenuItem
													variant="destructive"
													onSelect={() => setConfirmRemove(card)}
												>
													Remove card
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
								</div>
							);
						})
					)}
				</SettingsPanel>
			</SettingsSection>

			<BillingDetailsSection
				details={details}
				loaded={detailsLoaded}
				onSaved={refresh}
			/>

			{/* Add-card dialog — confirms a SetupIntent (card data stays in Stripe's iframe). */}
			<Dialog
				open={addOpen}
				onOpenChange={(o) => {
					setAddOpen(o);
					if (!o) setClientSecret(null);
				}}
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

			<AlertDialog
				open={confirmRemove !== null}
				onOpenChange={(o) => !o && setConfirmRemove(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove this card?</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmRemove
								? `${formatBrand(confirmRemove.brand)} •••• ${confirmRemove.last4} will be detached from your billing account. This can't be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => confirmRemove && removeCard(confirmRemove)}
						>
							Remove card
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

const addressSchema = z.object({
	name: z.string().trim().min(1, "Enter a billing name."),
	line1: z.string().trim().min(1, "Enter an address."),
	line2: z.string().trim().optional(),
	city: z.string().trim().min(1, "Enter a city."),
	state: z.string().trim().optional(),
	postalCode: z.string().trim().min(1, "Enter a postal code."),
	country: z.string().trim().min(2, "Select a country."),
});
type AddressFormData = z.infer<typeof addressSchema>;

/** Read-only address one-liner from the customer's billing details. */
function addressLine(d: BillingDetails): string {
	return [d.line1, d.line2, d.city, d.state, d.postalCode, d.country]
		.filter((p) => p.trim())
		.join(", ");
}

/**
 * The "Billing details" section — shows the customer's current name / email / address /
 * VAT id, with an Edit toggle that reveals a react-hook-form address + VAT form. Saving
 * writes the address (and, when present, the tax id) back to the Stripe customer.
 */
function BillingDetailsSection({
	details,
	loaded,
	onSaved,
}: {
	details: BillingDetails | null;
	loaded: boolean;
	onSaved: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [taxType, setTaxType] = useState<TaxIdType>(DEFAULT_TAX_ID_TYPE);
	const [taxValue, setTaxValue] = useState("");

	const form = useForm<AddressFormData>({
		resolver: zodResolver(addressSchema),
		defaultValues: {
			name: "",
			line1: "",
			line2: "",
			city: "",
			state: "",
			postalCode: "",
			country: "",
		},
	});

	/** Populate the form from the current customer details and open the editor. */
	function startEdit() {
		form.reset({
			name: details?.name ?? "",
			line1: details?.line1 ?? "",
			line2: details?.line2 ?? "",
			city: details?.city ?? "",
			state: details?.state ?? "",
			postalCode: details?.postalCode ?? "",
			country: details?.country ?? "",
		});
		setTaxValue(details?.taxId ?? "");
		setTaxType(DEFAULT_TAX_ID_TYPE);
		setEditing(true);
	}

	/** Save the address (+ tax id when entered) back to the Stripe customer. */
	async function onSubmit(data: AddressFormData) {
		try {
			await updateBillingAddress({
				name: data.name,
				line1: data.line1,
				line2: data.line2?.trim() ? data.line2 : undefined,
				city: data.city,
				state: data.state?.trim() ? data.state : undefined,
				postalCode: data.postalCode,
				country: data.country,
			});
			if (taxValue.trim()) {
				await saveTaxId(taxType, taxValue.trim());
			}
			toast.success("Billing details updated.");
			setEditing(false);
			onSaved();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save billing details.");
		}
	}

	/** Narrow a raw select value back to a TaxIdType (no cast) before storing it. */
	function selectTaxType(value: string) {
		const opt = TAX_ID_TYPES.find((t) => t.value === value);
		if (opt) setTaxType(opt.value);
	}

	const taxExample =
		TAX_ID_TYPES.find((t) => t.value === taxType)?.example ?? "";

	return (
		<SettingsSection
			title="Billing details"
			action={
				!editing && details ? (
					<Button variant="ghost" size="sm" onClick={startEdit}>
						Edit
					</Button>
				) : undefined
			}
		>
			<SettingsPanel>
				{!loaded ? (
					<div className="space-y-3 p-5">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : !details ? (
					<p className="px-[22px] py-6 text-[12.5px] text-text-tertiary">
						No billing account yet — add a payment method to set your billing details.
					</p>
				) : !editing ? (
					<div>
						<DetailRow label="Name" value={details.name || "—"} />
						<DetailRow label="Email" value={details.email || "—"} />
						<DetailRow label="Address" value={addressLine(details) || "—"} />
						<DetailRow label="VAT ID" value={details.taxId ?? "—"} mono />
					</div>
				) : (
					<form onSubmit={form.handleSubmit(onSubmit)}>
						<SettingsField label="Name" hint={form.formState.errors.name?.message}>
							<Input placeholder="Acme Inc." {...form.register("name")} />
						</SettingsField>
						<SettingsField label="Email">
							<Input value={details.email} disabled readOnly />
						</SettingsField>
						<SettingsField
							label="Address line 1"
							hint={form.formState.errors.line1?.message}
						>
							<Input placeholder="123 Example St" {...form.register("line1")} />
						</SettingsField>
						<SettingsField label="Address line 2">
							<Input placeholder="Suite 100 (optional)" {...form.register("line2")} />
						</SettingsField>
						<SettingsField label="City" hint={form.formState.errors.city?.message}>
							<Input placeholder="Berlin" {...form.register("city")} />
						</SettingsField>
						<SettingsField label="State / Province">
							<Input placeholder="Optional" {...form.register("state")} />
						</SettingsField>
						<SettingsField
							label="Postal code"
							hint={form.formState.errors.postalCode?.message}
						>
							<Input placeholder="10115" {...form.register("postalCode")} />
						</SettingsField>
						<SettingsField
							label="Country"
							hint={form.formState.errors.country?.message}
						>
							<Controller
								control={form.control}
								name="country"
								render={({ field }) => (
									<CountrySelect
										value={field.value}
										onChange={field.onChange}
										invalid={Boolean(form.formState.errors.country)}
									/>
								)}
							/>
						</SettingsField>
						<SettingsField label="VAT ID" hint="Optional — for tax-exempt invoicing.">
							<div className="flex flex-col gap-2 sm:flex-row">
								<Select value={taxType} onValueChange={selectTaxType}>
									<SelectTrigger className="w-full sm:w-[180px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{TAX_ID_TYPES.map((t) => (
											<SelectItem key={t.value} value={t.value}>
												{t.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Input
									className="flex-1"
									placeholder={taxExample}
									value={taxValue}
									onChange={(e) => setTaxValue(e.target.value)}
									aria-label="VAT ID"
								/>
							</div>
						</SettingsField>
						<SettingsCardFoot>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setEditing(false)}
								disabled={form.formState.isSubmitting}
							>
								Cancel
							</Button>
							<Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
								{form.formState.isSubmitting ? "Saving…" : "Save"}
							</Button>
						</SettingsCardFoot>
					</form>
				)}
			</SettingsPanel>
		</SettingsSection>
	);
}

/** One read-only label/value row in the billing-details view. */
function DetailRow({
	label,
	value,
	mono,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="grid grid-cols-[140px_1fr] items-start gap-4 border-b border-border px-[22px] py-[13px] last:border-b-0">
			<Label className="text-[12.5px] text-text-tertiary">{label}</Label>
			<span
				className={
					mono
						? "font-mono text-[12.5px] text-text-primary"
						: "text-[13px] text-text-primary"
				}
			>
				{value}
			</span>
		</div>
	);
}
