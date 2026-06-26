"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE reusable embedded checkout. Renders Stripe's native Address Element (billing
// address) + Payment Element (card data stays in Stripe's iframe — PCI SAQ-A), both
// themed to the app via the <StripeElementsProvider> appearance (light/dark). On
// submit it saves the billing address to the Stripe customer (so `automatic_tax`
// computes) then confirms. `mode="payment"` confirms a subscription's first
// PaymentIntent; `mode="setup"` confirms a SetupIntent (no address). `redirect:
// "if_required"` keeps 3-D Secure inline. Render inside <StripeElementsProvider>.

import {
	AddressElement,
	PaymentElement,
	useElements,
	useStripe,
} from "@stripe/react-stripe-js";
import { type FormEvent, useState } from "react";
import { updateBillingAddress } from "@/app/server/actions/billing";
import { Button } from "@repo/ui/button";

interface PaymentFormProps {
	mode: "payment" | "setup";
	/** Called after the intent is confirmed (the parent closes / refetches). */
	onSuccess: () => void;
	onError?: (message: string) => void;
	submitLabel?: string;
	/** Fallback URL for payment methods that force a full redirect. */
	returnUrl?: string;
}

export function PaymentForm({
	mode,
	onSuccess,
	onError,
	submitLabel = "Pay",
	returnUrl,
}: PaymentFormProps) {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Persist the Address Element's value to the Stripe customer (best-effort) so
	 * `automatic_tax` can compute VAT/sales tax from the billing country. */
	async function saveBillingAddress() {
		const addressEl = elements?.getElement("address");
		if (!addressEl) return;
		const { complete, value } = await addressEl.getValue();
		if (!complete || !value.address) return;
		try {
			await updateBillingAddress({
				name: value.name ?? "",
				line1: value.address.line1,
				line2: value.address.line2 || undefined,
				city: value.address.city,
				state: value.address.state || undefined,
				postalCode: value.address.postal_code,
				country: value.address.country,
			});
		} catch {
			// Non-fatal — Stripe still attaches the address to the payment method.
		}
	}

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (!stripe || !elements) return;
		setSubmitting(true);
		setError(null);

		if (mode === "payment") await saveBillingAddress();

		const confirmParams = { return_url: returnUrl ?? window.location.href };
		const result =
			mode === "payment"
				? await stripe.confirmPayment({
						elements,
						confirmParams,
						redirect: "if_required",
					})
				: await stripe.confirmSetup({
						elements,
						confirmParams,
						redirect: "if_required",
					});

		if (result.error) {
			const message = result.error.message ?? "Something went wrong with payment.";
			setError(message);
			onError?.(message);
			setSubmitting(false);
			return;
		}
		// Confirmed (no redirect needed). Leave submitting on — the parent closes/refetches.
		onSuccess();
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			{mode === "payment" && (
				<AddressElement
					options={{ mode: "billing", display: { name: "organization" } }}
				/>
			)}
			<PaymentElement />
			{error && <p className="text-xs text-destructive">{error}</p>}
			<Button type="submit" disabled={!stripe || submitting} className="w-full">
				{submitting ? "Processing…" : submitLabel}
			</Button>
		</form>
	);
}
