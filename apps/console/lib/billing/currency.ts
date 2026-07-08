// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing currency resolution. EU/EEA customers are billed in EUR, everyone else in USD.
// The currency must be decided BEFORE a subscription is created — Stripe locks a
// subscription's currency at creation. The default comes from Cloudflare's CF-IPCountry
// request header (self-hosted behind Cloudflare); the checkout UI may pass an explicit
// override. Server-only.

import { type SupportedCurrency, resolveCurrency } from "@repo/plan-catalog";
import { headers } from "next/headers";

/**
 * The default billing currency for the current request, from Cloudflare's `CF-IPCountry`
 * geo header (USD when absent/unresolvable). An explicit checkout selection overrides this.
 */
export async function currencyFromRequest(): Promise<SupportedCurrency> {
	try {
		const country = (await headers()).get("cf-ipcountry");
		return resolveCurrency(country);
	} catch {
		return "usd";
	}
}
