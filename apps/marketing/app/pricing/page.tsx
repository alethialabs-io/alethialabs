// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { headers } from "next/headers";
import { resolveCurrency } from "@repo/plan-catalog";
import { Pricing } from "@/components/landing/pricing";
import { getTeamPrice } from "@/lib/billing/pricing-display";

export const metadata: Metadata = {
	title: "Pricing · Alethia",
	description:
		"Alethia pricing — start free with your own Projects, upgrade for teams, governance, and enterprise SSO. You only pay your own cloud for what you provision.",
};

/**
 * Public pricing page. Mirrors the home page chrome (landing Header + Footer) and
 * renders the three tiers from PLAN_CATALOG so it stays in lockstep with the in-app
 * billing picker. The Pricing body renders its own hero. Served at /pricing.
 */
export default async function PricingPage() {
	const [teamPrice, headerList] = await Promise.all([getTeamPrice(), headers()]);
	// Default the currency from the visitor's region (Cloudflare geo); the toggle overrides.
	const initialCurrency = resolveCurrency(headerList.get("cf-ipcountry"));
	return (
		<SiteShell>
			<Pricing teamPrice={teamPrice} initialCurrency={initialCurrency} />
		</SiteShell>
	);
}
