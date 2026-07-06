// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Header } from "@/components/landing/home/header";
import { Footer } from "@/components/landing/home/footer";
import { Reveal } from "@/components/landing/home/reveal";
import { EnterpriseSections } from "@/components/landing/enterprise/page-sections";
import { getGitHubStars } from "@/lib/github-stars";

export const metadata: Metadata = {
	title: "Enterprise · Alethia",
	description:
		"Govern multi-cloud infrastructure for the whole organization — single sign-on, custom roles over OpenFGA, granular IAM, a complete audit trail, and self-managed deployment. Access maps to who needs it, and every decision is on the record.",
};

/**
 * Public enterprise-governance page. Mirrors the home/pricing chrome (landing
 * Header + Footer) and renders the enterprise sections — organizations, SSO,
 * RBAC, audit, security, and the Enterprise plan band — inside the shared
 * scroll-reveal wrapper. Served at /enterprise inside the console app.
 */
export default async function EnterprisePage() {
	const stars = await getGitHubStars();
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<Reveal>
				<EnterpriseSections />
			</Reveal>
			<Footer />
		</div>
	);
}
