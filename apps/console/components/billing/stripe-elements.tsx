"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe <Elements> provider for the embedded Payment Element, themed to the Alethia
// design system: grayscale (no chroma), squared (0 radius), Geist. Light/dark follows
// next-themes. Wrap a <PaymentForm> in this with the intent's clientSecret.

import { Elements } from "@stripe/react-stripe-js";
import type { StripeElementStyle, StripeElementsOptions } from "@stripe/stripe-js";
import { RAMP_THEME } from "@repo/brand/ramp-srgb";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { getStripePromise } from "@/lib/billing/stripe-client";

/**
 * Per-element `style` for the split card elements (CardNumber/Expiry/Cvc) — the same
 * grayscale/Geist tokens as the Payment Element appearance, but in the individual-element
 * style shape (the split elements ignore the Elements-level `appearance`).
 */
export function cardElementStyle(dark: boolean): StripeElementStyle {
	const c = RAMP_THEME[dark ? "dark" : "light"];
	return {
		base: {
			color: c.textPrimary,
			fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
			fontSize: "14px",
			iconColor: c.textSecondary,
			"::placeholder": { color: c.textTertiary },
		},
		invalid: { color: c.textPrimary, iconColor: c.textPrimary },
	};
}

/** Grayscale + squared + Geist appearance for the Payment Element. */
function appearanceFor(dark: boolean): StripeElementsOptions["appearance"] {
	const c = RAMP_THEME[dark ? "dark" : "light"];
	return {
		theme: dark ? "night" : "stripe",
		variables: {
			colorPrimary: c.textPrimary,
			colorBackground: c.surface,
			colorText: c.textPrimary,
			colorTextSecondary: c.textSecondary,
			colorDanger: c.textPrimary,
			borderRadius: "0px",
			fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
			fontSizeBase: "14px",
			spacingUnit: "4px",
		},
		rules: {
			".Input": {
				borderRadius: "0px",
				border: `1px solid ${c.border}`,
				boxShadow: "none",
			},
			".Input:focus": {
				boxShadow: "none",
				border: `1px solid ${c.textPrimary}`,
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
