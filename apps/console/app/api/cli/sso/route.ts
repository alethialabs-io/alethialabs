// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { ssoProvider } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliSsoProvidersResponse } from "@/lib/validations/cli-contract";

/** Maps an sso_provider row to its client-safe CLI wire shape. The oidc/saml config
 * JSON (and any embedded client secret) is never on the wire — only the provider type
 * (derived from which config is present), the claimed domain, the issuer, and whether
 * the provider is enabled (its domain is verified). */
export function toSsoWire(row: typeof ssoProvider.$inferSelect) {
	return {
		id: row.id,
		provider_type: row.oidcConfig ? "oidc" : "saml",
		domain: row.domain,
		issuer: row.issuer,
		enabled: row.domainVerified,
	};
}

/**
 * Lists the active org's configured SSO identity providers (OIDC + SAML). Read-only:
 * registering a provider goes through Better Auth's /api/auth/sso/register, which the
 * enterprise sso plugin owns. Scoped by org_id, gated on `view` of `org`. Community
 * builds have no sso plugin, so the table is empty.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select()
			.from(ssoProvider)
			.where(eq(ssoProvider.organizationId, actor.orgId));

		return cliJson(cliSsoProvidersResponse, {
			sso_providers: rows.map(toSsoWire),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
