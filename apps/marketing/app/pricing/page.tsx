// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { headers } from "next/headers";
import { resolveCurrency } from "@repo/plan-catalog";
import { Header } from "@/components/landing/home/header";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/home/footer";
import { getGitHubStars } from "@/lib/github-stars";
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
	const [stars, teamPrice, headerList] = await Promise.all([
		getGitHubStars(),
		getTeamPrice(),
		headers(),
	]);
	// Default the currency from the visitor's region (Cloudflare geo); the toggle overrides.
	const initialCurrency = resolveCurrency(headerList.get("cf-ipcountry"));
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<main>
				<Pricing teamPrice={teamPrice} initialCurrency={initialCurrency} />
			</main>
			<Footer />
		</div>
	);
}
