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

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import type { PayerCapacity } from "@repo/legal/commerce";
import { Button } from "@repo/ui/button";
import { CountrySelect } from "@repo/ui/country-select";
import { Input } from "@repo/ui/input";
import { Field } from "@/components/org/org-purchase-ui";

/** The declared facts, in the shape `declarePayer` and `payerConversionStatus` both take. */
export interface PayerDeclaration {
	capacity: PayerCapacity;
	/** ISO 3166-1 alpha-2, upper-case. */
	billingCountry: string;
	/** The role binding the organization, or null for a consumer — never the empty string. */
	authorityAttestation: string | null;
}

const schema = z
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
	})
	.superRefine((values, ctx) => {
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

type FormData = z.infer<typeof schema>;

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
			"You are buying on behalf of a company or other legal person. Consumer protections do not apply, and a VAT or tax id can be added at payment.",
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
	submitLabel: string;
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
	submitLabel,
	onBack,
	onDeclare,
}: PayerDeclarationFormProps) {
	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		// No capacity. The whole point of the field is that it is answered, not defaulted.
		defaultValues: {
			capacity: undefined,
			billingCountry: "",
			authorityAttestation: "",
		},
		mode: "onSubmit",
	});
	const capacity = form.watch("capacity");

	/** Normalises the validated values into the shape both server actions accept. */
	function submit(values: FormData) {
		onDeclare({
			capacity: values.capacity,
			billingCountry: values.billingCountry.trim().toUpperCase(),
			authorityAttestation:
				values.capacity === "organization" ? values.authorityAttestation.trim() : null,
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

			{capacity === "organization" && (
				<Field
					label="Your authority to bind it"
					required
					error={form.formState.errors.authorityAttestation?.message}
				>
					<Input
						placeholder="Director"
						autoComplete="organization-title"
						disabled={busy}
						{...form.register("authorityAttestation")}
					/>
					<p className="pt-1 text-ui-xs text-text-tertiary">
						A purchase that binds a legal person needs someone to say they can bind it.
					</p>
				</Field>
			)}

			{refusal && (
				<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
					{refusal}
				</p>
			)}

			<Button type="submit" disabled={busy} className="mt-auto w-full">
				{busy ? "Checking…" : submitLabel}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}
