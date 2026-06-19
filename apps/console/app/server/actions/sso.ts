"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { ssoProvider } from "@/lib/db/schema";

export interface SsoProviderRow {
	id: string;
	providerId: string;
	domain: string;
	issuer: string;
	type: "oidc" | "saml";
	domainVerified: boolean;
}

/**
 * SSO identity providers registered for the active organization. Community: the
 * sso plugin is absent so the table is empty (the page is gated anyway); Enterprise:
 * the providers an admin registered via /api/auth/sso/register. The provider type is
 * derived from which config column is set.
 */
export async function getSsoProviders(): Promise<SsoProviderRow[]> {
	const actor = await currentActor();
	const rows = await getServiceDb()
		.select({
			id: ssoProvider.id,
			providerId: ssoProvider.providerId,
			domain: ssoProvider.domain,
			issuer: ssoProvider.issuer,
			oidcConfig: ssoProvider.oidcConfig,
			domainVerified: ssoProvider.domainVerified,
		})
		.from(ssoProvider)
		.where(eq(ssoProvider.organizationId, actor.orgId));

	return rows.map((r) => ({
		id: r.id,
		providerId: r.providerId,
		domain: r.domain,
		issuer: r.issuer,
		type: r.oidcConfig ? "oidc" : "saml",
		domainVerified: r.domainVerified,
	}));
}
