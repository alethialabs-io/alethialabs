// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { Reveal } from "@/components/landing/reveal";
import { EnterpriseSections } from "@/components/landing/enterprise/page-sections";

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
	return (
		<SiteShell>
			<Reveal>
				<EnterpriseSections />
			</Reveal>
		</SiteShell>
	);
}
