// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { Reveal } from "@/components/landing/reveal";
import { EnterpriseSections } from "@/components/landing/enterprise/page-sections";

export const metadata: Metadata = {
	title: "Enterprise",
	description:
		"Govern multi-cloud infrastructure for the whole organization — single sign-on over OIDC or SAML, custom roles where deny wins, an exportable audit trail, and hosted or self-managed deployment.",
};

/**
 * Public enterprise-governance page: hero, clouds, organizations, one grid of
 * governance points, close.
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
