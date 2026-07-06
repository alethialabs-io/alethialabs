// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Header } from "@/components/landing/home/header";
import { Footer } from "@/components/landing/home/footer";
import { ContactSection } from "@/components/contact/contact-page";
import { getGitHubStars } from "@/lib/github-stars";

export const metadata: Metadata = {
	title: "Talk to sales · Alethia",
	description:
		"Get a custom demo of Alethia against your own stack — console, CLI, and AI agent on the clouds you run. Governance, SSO, and self-managed options mapped to your organization.",
};

/** Public "Talk to sales" page. Shares the landing Header/Footer chrome. */
export default async function ContactSalesPage() {
	const stars = await getGitHubStars();
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<main>
				<ContactSection
					type="sales"
					submitLabel="Talk to sales"
					rail={{
						tag: "Contact · Sales",
						title: "Talk to our sales team.",
						sub: "Get a custom demo. See what Alethia does for your organization, and explore a plan built around your fleet.",
						points: [
							[
								"grid",
								"A demo against your stack",
								"We provision a real Project and walk the console, the CLI, and the agent — on the clouds you actually run.",
							],
							[
								"shield",
								"Governance mapped to your org",
								"SSO, custom roles, granular IAM, and a full audit trail — fitted to how your teams are structured.",
							],
							[
								"building",
								"Deploy where your data lives",
								"Hosted, single-tenant, or fully self-managed inside your own VPC. Zero credentials stored, either way.",
							],
						],
					}}
					crossLabel="Just want to try it?"
					crossHref="/contact/enterprise"
					crossSub="Set up an Enterprise trial and explore it yourself."
				/>
			</main>
			<Footer />
		</div>
	);
}
