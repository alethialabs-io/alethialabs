"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE reusable embedded checkout. Renders Stripe's Payment Element (card data stays in
// Stripe's iframe — PCI SAQ-A) and confirms it. `mode="payment"` confirms a
// subscription's first PaymentIntent (create-org / upgrade); `mode="setup"` confirms a
// SetupIntent (save a card). `redirect: "if_required"` keeps 3-D Secure inline — only
// payment methods that force a redirect leave the page (return_url is the fallback).
// Must be rendered inside <StripeElementsProvider clientSecret=…>.

import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

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

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (!stripe || !elements) return;
		setSubmitting(true);
		setError(null);

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
			<PaymentElement />
			{error && <p className="text-xs text-destructive">{error}</p>}
			<Button type="submit" disabled={!stripe || submitting} className="w-full">
				{submitting ? "Processing…" : submitLabel}
			</Button>
		</form>
	);
}
