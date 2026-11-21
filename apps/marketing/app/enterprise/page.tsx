// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { EnterpriseSections } from "@/components/landing/enterprise/page-sections";

export const metadata: Metadata = {
	title: "Enterprise",
	description:
		"Every cloud account, every team, every change, governed in one place: single sign-on with OIDC or SAML 2.0, custom roles where a deny always wins, every change on the record, hosted or inside your own perimeter.",
};

/** The public enterprise page: statement, what you get, who can do what, the trial, contact. */
export default function EnterprisePage() {
	return (
		<SiteShell>
			<EnterpriseSections />
		</SiteShell>
	);
}
