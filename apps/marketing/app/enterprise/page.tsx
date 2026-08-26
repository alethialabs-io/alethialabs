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
 * Public enterprise-governance page: organizations, identity, roles, audit,
 * deployment, and the trial form.
 *
 * `Reveal` selects `:scope > section` and skips the first, so
 * `EnterpriseSections` must return a flat fragment of `<section>` elements with
 * the hero first — a wrapper div here would silently kill every scroll
 * animation on the page. The plan band is gone: it duplicated /pricing's
 * Enterprise tier with a different and partly wrong feature list.
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
