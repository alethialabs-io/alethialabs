// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Header } from "@/components/landing/header";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
	title: "Pricing · Alethia",
	description:
		"Alethia pricing — start free with your own Zones & Specs, upgrade for teams, governance, and enterprise SSO. You only pay your own cloud for what you provision.",
};

/**
 * Public pricing page. Mirrors the home page chrome (landing Header + Footer) and
 * renders the four tiers from PLAN_CATALOG so it stays in lockstep with the in-app
 * billing picker. Served at /pricing inside the console app.
 */
export default function PricingPage() {
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header />
			<main className="pt-24">
				<Pricing />
			</main>
			<Footer />
		</div>
	);
}
