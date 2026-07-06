// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Header } from "@/components/landing/home/header";
import { Footer } from "@/components/landing/home/footer";
import { ContactSection } from "@/components/contact/contact-page";
import { getGitHubStars } from "@/lib/github-stars";

export const metadata: Metadata = {
	title: "Set up your Enterprise trial · Alethia",
	description:
		"Start an Alethia Enterprise trial — SSO/SAML + SCIM, custom roles and granular IAM, exportable audit, and a self-managed option you can run inside your own perimeter.",
};

/** Public "Enterprise trial" page. Shares the landing Header/Footer chrome. */
export default async function ContactEnterprisePage() {
	const stars = await getGitHubStars();
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<main>
				<ContactSection
					type="enterprise"
					submitLabel="Request your trial"
					rail={{
						tag: "Enterprise · Get started",
						title: "Set up your Enterprise trial.",
						sub: "See for yourself how Alethia Enterprise tightens governance and speeds up your workflow — SSO, custom roles, audit, and a self-managed option.",
						points: [
							[
								"key",
								"SSO / SAML + SCIM",
								"Wire your identity provider over OIDC or SAML; SCIM keeps membership in sync automatically.",
							],
							[
								"sliders",
								"Custom roles & granular IAM",
								"Compose allow and deny down to a single project, evaluated by OpenFGA over Postgres RBAC.",
							],
							[
								"audit",
								"Audit you can export",
								"Every authorization decision is recorded, append-only, and streamable to your SIEM.",
							],
							[
								"building",
								"Self-managed option",
								"Run the whole control plane inside your perimeter — single-tenant or air-gapped.",
							],
						],
						foot: "We'll help you stand it up and onboard your team.",
					}}
					crossLabel="Want a guided walkthrough?"
					crossHref="/contact/sales"
					crossSub="Talk to sales for a custom demo against your stack."
				/>
			</main>
			<Footer />
		</div>
	);
}
