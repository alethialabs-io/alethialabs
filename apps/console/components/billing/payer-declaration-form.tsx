"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHO is buying, and from WHERE — asked once, in the purchase sheet, at the moment of purchase.
//
// `lib/billing/eligibility.ts` refuses every paid conversion whose payer capacity is not declared,
// and says why it will not guess: `consumer` and `organization` are different legal regimes, and
// getting it wrong in the `organization` direction strips a real consumer of rights they cannot
// waive. Until #4633 nothing in the product asked, so `declarePayer` had no caller and the refusal
// was unliftable from inside the app.
//
// This is the form that asks. It renders in BOTH purchase sheets, in the slot the currency toggle
// already occupies, and it is a STEP rather than a panel beside the card fields because the
// declaration is an INPUT to creating the subscription intent — the upgrade sheet used to open the
// intent from a `useEffect` on mount, before any form could have collected anything.
//
// Nothing here is pre-selected. A default would answer the one question the gate exists to stop the
// product answering on the payer's behalf.
//
// EARLY ACCESS (#7324) adds three facts, all asked BEFORE any intent exists:
//   - for an organization billed in an EU member state, one neutral question — "Does the organization
//     have a VAT number?" — and the number on a yes. No copy hints at what either answer opens:
//     steering a VAT-registered business to withhold its number would be a misrepresentation;
//   - for a US buyer, the state (a USPS code), which the per-state thresholds count by;
//   - and, in its own step right after (`BillingAddressForm`, below), the full billing address, which
//     the sheet passes to the intent so the customer carries it before the first invoice is finalised.

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { EU_MEMBER_STATES, type PayerCapacity, type VatIdStatus } from "@repo/legal/commerce";
import { Button } from "@repo/ui/button";
import { CountrySelect } from "@repo/ui/country-select";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Field } from "@/components/org/org-purchase-ui";
import { BILLING_FIELD_CAPS, tooLongMessage } from "@/lib/billing/billing-field-caps";
import type { PaidConversionRefusal } from "@/lib/billing/eligibility";
import { EARLY_ACCESS_REQUEST_PATH, isUsStateCode, US_STATES } from "@/lib/billing/tax-ids";
import { globalHref } from "@/lib/routing";

/** The billing address collected with the declaration, in the shape the intent actions take. */
export interface DeclaredBillingAddress {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	postalCode: string;
	/** ISO 3166-1 alpha-2 — always the declared billing country. */
	country: string;
	/** The US state, when the country is the US. */
	state?: string;
}

/** The declared facts, in the shape `declarePayer` and `payerConversionStatus` both take. */
export interface PayerDeclaration {
	capacity: PayerCapacity;
	/** ISO 3166-1 alpha-2, upper-case. */
	billingCountry: string;
	/** The role binding the organization, or null for a consumer — never the empty string. */
	authorityAttestation: string | null;
	/**
	 * Whether the organization has a VAT number — asked of an organization billed in the EU, null
	 * everywhere else. Optional in the TYPE so declarations saved before #7324 still read.
	 */
	vatIdStatus?: VatIdStatus | null;
	/** The VAT number, with `given` only. */
	vatId?: string | null;
	/** USPS state code, for a US buyer only. */
	billingState?: string | null;
	/** The billing address, once the sheet's address step collected it. Not part of `declarePayer`. */
	billingAddress?: DeclaredBillingAddress | null;
}

/**
 * The facts `declarePayer` and `payerConversionStatus` take, from a declaration — everything but the
 * billing address, which goes to the intent instead.
 */
export function declaredPayerFacts(d: PayerDeclaration): {
	capacity: PayerCapacity;
	billingCountry: string;
	authorityAttestation: string | null;
	vatIdStatus: VatIdStatus | null;
	vatId: string | null;
	billingState: string | null;
} {
	return {
		capacity: d.capacity,
		billingCountry: d.billingCountry,
		authorityAttestation: d.authorityAttestation,
		vatIdStatus: d.vatIdStatus ?? null,
		vatId: d.vatId ?? null,
		billingState: d.billingState ?? null,
	};
}

/**
 * Where a gate refusal points, if anywhere: `complimentary_grant` links to the org's complimentary
 * Early Access request (EA-3, #7325). Every other refusal is the payer's to fix on this form.
 */
export function refusalActionFor(
	reason: PaidConversionRefusal,
	orgSlug: string | null,
): { href: string; label: string } | null {
	if (reason !== "complimentary_grant" || !orgSlug) return null;
	return {
		href: globalHref(orgSlug, EARLY_ACCESS_REQUEST_PATH),
		label: "Request complimentary Early Access",
	};
}

/** Whether the VAT-number question applies: an organization billed in an EU member state. */
function asksVatNumber(capacity: PayerCapacity | undefined, country: string): boolean {
	return capacity === "organization" && EU_MEMBER_STATES.includes(country.trim().toUpperCase());
}

/** A trimmed string no longer than `max`. */
function capped(max: number) {
	return z.string().trim().max(max, tooLongMessage(max));
}

/** The declaration form's schema. */
function declarationSchema() {
	return z
	.object({
		capacity: z.enum(["consumer", "organization"], {
			error: "Choose whether you are buying as an individual or for an organization.",
		}),
		billingCountry: z
			.string()
			.trim()
			.length(2, "Select the country this purchase is billed in."),
		authorityAttestation: z
			.string()
			.trim()
			.max(200, "Keep the role under 200 characters."),
		vatIdStatus: z.enum(["", "given", "not_given"]),
		vatId: capped(32),
		billingState: z.string(),
	})
	.superRefine((values, ctx) => {
		if (asksVatNumber(values.capacity, values.billingCountry)) {
			if (values.vatIdStatus === "") {
				ctx.addIssue({
					code: "custom",
					path: ["vatIdStatus"],
					message: "Say whether the organization has a VAT number.",
				});
			}
			if (values.vatIdStatus === "given" && values.vatId.length === 0) {
				ctx.addIssue({ code: "custom", path: ["vatId"], message: "Enter the VAT number." });
			}
		}
		if (values.billingCountry.trim().toUpperCase() === "US" && !isUsStateCode(values.billingState)) {
			ctx.addIssue({
				code: "custom",
				path: ["billingState"],
				message: "Select the US state this purchase is billed in.",
			});
		}
		
		// BOTH directions, because both are wrong in the same way: the record would say something
		// the payer did not. An organization purchase with no attestation binds a legal person that
		// nobody has claimed authority over; a consumer purchase carrying one describes a binding
		// that does not exist.
		if (values.capacity === "organization" && values.authorityAttestation.length < 2) {
			ctx.addIssue({
				code: "custom",
				path: ["authorityAttestation"],
				message:
					"State the role under which you can bind this organization — director, authorised signatory, procurement.",
			});
		}
		if (values.capacity === "consumer" && values.authorityAttestation.length > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["authorityAttestation"],
				message:
					"An individual purchase binds nobody but you — clear this field, or choose the organization option.",
			});
		}
	});
}

type FormData = z.infer<ReturnType<typeof declarationSchema>>;

/** The two regimes, with what each one actually means for the person choosing. */
const CAPACITY_OPTIONS: ReadonlyArray<{
	value: PayerCapacity;
	label: string;
	description: string;
}> = [
	{
		value: "consumer",
		label: "An individual",
		description:
			"You are buying for yourself, outside any trade or business. Consumer law applies, including the 14-day right to withdraw.",
	},
	{
		value: "organization",
		label: "An organization",
		description:
			"You are buying on behalf of a company or other legal person. Consumer protections do not apply.",
	},
];

interface PayerDeclarationFormProps {
	/** Disables the form while the declaration is being recorded and the intent opened. */
	busy: boolean;
	/**
	 * The gate's own sentence for a declaration it refused — `market_closed` and the rest.
	 *
	 * Rendered verbatim, and deliberately NOT paraphrased: it names the capacity and country the
	 * payer just gave, and it is the only thing that tells them whether this is theirs to fix.
	 */
	refusal: string | null;
	/**
	 * Where the refusal points, when it has somewhere to go — the complimentary Early Access request
	 * for `complimentary_grant` (#7324). Rendered as a link under the refusal.
	 */
	refusalAction?: { href: string; label: string } | null;
	
	submitLabel: string;
	/**
	 * Called whenever any declared fact changes, so a sheet can drop a refusal about the PREVIOUS
	 * answer (F031): the refusal names the capacity and country it judged, and left on screen after
	 * the payer changes them it describes a declaration nobody is making any more. Pass a stable
	 * function (`useCallback`) — the form subscribes once per identity.
	 */
	onEdit?: () => void;
	/** Back to the step before this one, when the sheet has one. */
	onBack?: () => void;
	onDeclare: (declaration: PayerDeclaration) => void;
}

/**
 * The required consumer-vs-organization declaration, plus the billing country and — for an
 * organization only — the attestation of authority to bind it.
 */
export function PayerDeclarationForm({
	busy,
	refusal,
	refusalAction,
	submitLabel,
	onEdit,
	onBack,
	onDeclare,
}: PayerDeclarationFormProps) {
	const form = useForm<FormData>({
		resolver: zodResolver(declarationSchema()),
		// No capacity, and no VAT-number answer. The point of each is that it is answered, not defaulted.
		defaultValues: {
			capacity: undefined,
			billingCountry: "",
			authorityAttestation: "",
			vatIdStatus: "",
			vatId: "",
			billingState: "",
		},
		mode: "onSubmit",
	});
	const capacity = useWatch({ control: form.control, name: "capacity" });
	const country = useWatch({ control: form.control, name: "billingCountry" });
	const vatIdStatus = useWatch({ control: form.control, name: "vatIdStatus" });
	const iso = country.trim().toUpperCase();
	const asksVat = asksVatNumber(capacity, iso);

	// Every change to a declared fact — capacity, country, attestation — tells the sheet its refusal
	// (if any) is about an answer that no longer stands.
	useEffect(() => {
		if (!onEdit) return;
		return form.subscribe({ formState: { values: true }, callback: () => onEdit() });
	}, [form, onEdit]);

	/** Normalises the validated values into the shape both server actions accept. */
	function submit(values: FormData) {
		const billingCountry = values.billingCountry.trim().toUpperCase();
		const vatAsked = asksVatNumber(values.capacity, billingCountry);
		const status = vatAsked && values.vatIdStatus !== "" ? values.vatIdStatus : null;
		const billingState = billingCountry === "US" ? values.billingState.toUpperCase() : null;
		onDeclare({
			capacity: values.capacity,
			billingCountry,
			authorityAttestation:
				values.capacity === "organization" ? values.authorityAttestation.trim() : null,
			vatIdStatus: status,
			vatId: status === "given" ? values.vatId : null,
			billingState,
			billingAddress: null,
		});
	}

	return (
		<form
			onSubmit={form.handleSubmit(submit)}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
		>
			{onBack && (
				<button
					type="button"
					onClick={onBack}
					disabled={busy}
					className="shrink-0 self-start text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
				>
					← Back
				</button>
			)}

			<fieldset className="space-y-1.5" disabled={busy}>
				<legend className="flex items-center gap-1.5 text-ui-md font-medium text-text-primary">
					Who is this purchase for?
					<span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
						required
					</span>
				</legend>
				<p className="text-ui-xs text-text-tertiary">
					The two carry different rights, so we cannot guess.
				</p>
				<div className="space-y-2 pt-1">
					{CAPACITY_OPTIONS.map((option) => (
						<label
							key={option.value}
							className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3 transition-colors hover:border-border-strong has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken"
						>
							<input
								type="radio"
								value={option.value}
								className="mt-0.5 size-4 shrink-0 accent-[var(--text-primary)]"
								{...form.register("capacity")}
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-ui-sm font-medium text-text-primary">
									{option.label}
								</span>
								<span className="text-ui-xs leading-snug text-text-tertiary">
									{option.description}
								</span>
							</span>
						</label>
					))}
				</div>
				{form.formState.errors.capacity?.message && (
					<p className="text-ui-xs text-destructive">
						{form.formState.errors.capacity.message}
					</p>
				)}
			</fieldset>

			<Field
				label="Billing country"
				required
				error={form.formState.errors.billingCountry?.message}
			>
				<Controller
					control={form.control}
					name="billingCountry"
					render={({ field }) => (
						<CountrySelect
							value={field.value}
							onChange={field.onChange}
							disabled={busy}
							invalid={Boolean(form.formState.errors.billingCountry)}
						/>
					)}
				/>
			</Field>

			{iso === "US" && (
				<Field label="State" required error={form.formState.errors.billingState?.message}>
					<Controller
						control={form.control}
						name="billingState"
						render={({ field }) => (
							<Select value={field.value} onValueChange={field.onChange} disabled={busy}>
								<SelectTrigger
									aria-label="State"
									aria-invalid={Boolean(form.formState.errors.billingState)}
									className="w-full"
								>
									<SelectValue placeholder="Select a state" />
								</SelectTrigger>
								<SelectContent>
									{US_STATES.map((s) => (
										<SelectItem key={s.code} value={s.code}>
											{s.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					/>
				</Field>
			)}

			{asksVat && (
				<fieldset className="space-y-1.5" disabled={busy}>
					<legend className="flex items-center gap-1.5 text-ui-md font-medium text-text-primary">
						Does the organization have a VAT number?
						<span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
							required
						</span>
					</legend>
					<div className="flex gap-4 pt-1">
						{(
							[
								["given", "Yes"],
								["not_given", "No"],
							] as const
						).map(([value, label]) => (
							<label key={value} className="flex items-center gap-2 text-ui-sm text-text-secondary">
								<input
									type="radio"
									value={value}
									className="size-4 accent-[var(--text-primary)]"
									{...form.register("vatIdStatus")}
								/>
								{label}
							</label>
						))}
					</div>
					{form.formState.errors.vatIdStatus?.message && (
						<p className="text-ui-xs text-destructive">
							{form.formState.errors.vatIdStatus.message}
						</p>
					)}
				</fieldset>
			)}

			{asksVat && vatIdStatus === "given" && (
				<Field label="VAT number" required error={form.formState.errors.vatId?.message}>
					{(id) => (
						<Input
							id={id}
							aria-label="VAT number" placeholder="DE123456789"
							autoComplete="off"
							disabled={busy}
							{...form.register("vatId")}
						/>
					)}
				</Field>
			)}

			{capacity === "organization" && (
				<Field
					label="Your authority to bind it"
					required
					error={form.formState.errors.authorityAttestation?.message}
				>
					{(id) => (
						<>
							<Input
								id={id}
								placeholder="Director"
								autoComplete="organization-title"
								disabled={busy}
								{...form.register("authorityAttestation")}
							/>
							<p className="pt-1 text-ui-xs text-text-tertiary">
								A purchase that binds a legal person needs someone to say they can bind it.
							</p>
						</>
					)}
				</Field>
			)}

			{refusal && (
				<div className="space-y-2 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
					<p>{refusal}</p>
					{refusalAction && (
						<a
							href={refusalAction.href}
							className="inline-flex items-center gap-1 font-medium text-text-primary underline underline-offset-2"
						>
							{refusalAction.label}
							<ArrowRight size={13} />
						</a>
					)}
				</div>
			)}

			<Button type="submit" disabled={busy} className="mt-auto w-full">
				{busy ? "Checking…" : submitLabel}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/** The address step's schema: the same fields and caps as the checkout form. */
const addressSchema = z.object({
	name: capped(BILLING_FIELD_CAPS.name).min(1, "Enter the name to bill — the organization's, or yours."),
	line1: capped(BILLING_FIELD_CAPS.line1).min(1, "Enter the address."),
	line2: capped(BILLING_FIELD_CAPS.line2),
	city: capped(BILLING_FIELD_CAPS.city).min(1, "Enter the city."),
	postalCode: capped(BILLING_FIELD_CAPS.postalCode).min(1, "Enter the postal code."),
});

type AddressFormData = z.infer<typeof addressSchema>;

interface BillingAddressFormProps {
	/** The declared billing country — the address is in it, and is not asked again. */
	country: string;
	/** The declared US state, when the country is the US. */
	state: string | null;
	busy: boolean;
	submitLabel: string;
	onBack?: () => void;
	onSubmit: (address: DeclaredBillingAddress) => void;
}

/**
 * The billing address, asked right after the declaration and BEFORE any intent exists (#7324). The
 * sheet sends it with the intent, and the server writes it to the Stripe customer before the
 * subscription is created — Stripe snapshots the customer's address onto an invoice when it finalises
 * it, and the first invoice is finalised at creation, so an address saved after the charge never
 * reached it. The country (and a US state) come from the declaration, so the two cannot disagree.
 */
export function BillingAddressForm({
	country,
	state,
	busy,
	submitLabel,
	onBack,
	onSubmit,
}: BillingAddressFormProps) {
	const form = useForm<AddressFormData>({
		resolver: zodResolver(addressSchema),
		defaultValues: { name: "", line1: "", line2: "", city: "", postalCode: "" },
		mode: "onSubmit",
	});
	const errors = form.formState.errors;

	/** Hands the validated address, with the declared country and state, to the sheet. */
	function submit(values: AddressFormData) {
		onSubmit({
			name: values.name,
			line1: values.line1,
			line2: values.line2 || undefined,
			city: values.city,
			postalCode: values.postalCode,
			country,
			state: state ?? undefined,
		});
	}

	return (
		<form
			onSubmit={form.handleSubmit(submit)}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
		>
			{onBack && (
				<button
					type="button"
					onClick={onBack}
					disabled={busy}
					className="shrink-0 self-start text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
				>
					← Back
				</button>
			)}
			<p className="text-ui-xs text-text-tertiary">
				The invoice is addressed to this name and address.
			</p>
			<Field label="Billing name" required error={errors.name?.message}>
				{(id) => (
					<Input id={id} aria-label="Billing name" placeholder="Acme GmbH" autoComplete="organization" disabled={busy} {...form.register("name")} />
				)}
			</Field>
			<Field label="Address line 1" required error={errors.line1?.message}>
				{(id) => (
					<Input id={id} aria-label="Address line 1" placeholder="123 Main St" autoComplete="address-line1" disabled={busy} {...form.register("line1")} />
				)}
			</Field>
			<Field label="Address line 2" error={errors.line2?.message}>
				{(id) => (
					<Input id={id} aria-label="Address line 2" placeholder="Suite, unit, floor" autoComplete="address-line2" disabled={busy} {...form.register("line2")} />
				)}
			</Field>
			<div className="grid grid-cols-2 gap-3">
				<Field label="City" required error={errors.city?.message}>
					{(id) => (
						<Input id={id} aria-label="City" placeholder="Berlin" autoComplete="address-level2" disabled={busy} {...form.register("city")} />
					)}
				</Field>
				<Field label="Postal code" required error={errors.postalCode?.message}>
					{(id) => (
						<Input id={id} aria-label="Postal code" placeholder="10115" autoComplete="postal-code" disabled={busy} {...form.register("postalCode")} />
					)}
				</Field>
			</div>
			<Button type="submit" disabled={busy} className="mt-auto w-full">
				{submitLabel}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}
