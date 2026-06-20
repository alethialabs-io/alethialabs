"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe <Elements> provider for the embedded Payment Element, themed to the Alethia
// design system: grayscale (no chroma), squared (0 radius), Geist. Light/dark follows
// next-themes. Wrap a <PaymentForm> in this with the intent's clientSecret.

import { Elements } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { getStripePromise } from "@/lib/billing/stripe-client";

/** Grayscale + squared + Geist appearance for the Payment Element. */
function appearanceFor(dark: boolean): StripeElementsOptions["appearance"] {
	return {
		theme: dark ? "night" : "stripe",
		variables: {
			colorPrimary: dark ? "#fafafa" : "#171717",
			colorBackground: dark ? "#0a0a0a" : "#ffffff",
			colorText: dark ? "#fafafa" : "#171717",
			colorTextSecondary: dark ? "#a3a3a3" : "#737373",
			colorDanger: dark ? "#fafafa" : "#171717",
			borderRadius: "0px",
			fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
			fontSizeBase: "14px",
			spacingUnit: "4px",
		},
		rules: {
			".Input": {
				borderRadius: "0px",
				border: dark ? "1px solid #262626" : "1px solid #e5e5e5",
				boxShadow: "none",
			},
			".Input:focus": {
				boxShadow: "none",
				border: dark ? "1px solid #fafafa" : "1px solid #171717",
			},
			".Tab, .Block, .CheckboxInput, .Label": { borderRadius: "0px" },
		},
	};
}

export function StripeElementsProvider({
	clientSecret,
	children,
}: {
	clientSecret: string;
	children: ReactNode;
}) {
	const { resolvedTheme } = useTheme();
	const options: StripeElementsOptions = {
		clientSecret,
		appearance: appearanceFor(resolvedTheme === "dark"),
	};
	return (
		<Elements stripe={getStripePromise()} options={options}>
			{children}
		</Elements>
	);
}
