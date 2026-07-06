"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X509Certificate } from "node:crypto";
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
	/** SAML IdP sign-on URL (entryPoint), if configured. */
	ssoUrl: string | null;
	/** SHA-256 fingerprint of the SAML signing certificate ("AB:CD:…"), if parseable. */
	certFingerprint: string | null;
	/** OIDC client id (never the secret), if configured. */
	clientId: string | null;
}

interface SamlCfg {
	entryPoint?: string;
	cert?: string;
}
interface OidcCfg {
	clientId?: string;
}

function parseJson<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

/** SHA-256 fingerprint of a SAML signing cert (PEM or bare base64), or null. */
function certFingerprint(cert?: string): string | null {
	if (!cert) return null;
	try {
		const pem = cert.includes("BEGIN CERTIFICATE")
			? cert
			: `-----BEGIN CERTIFICATE-----\n${cert.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;
		return new X509Certificate(pem).fingerprint256;
	} catch {
		return null;
	}
}

/**
 * SSO identity providers registered for the active organization. Community: the
 * sso plugin is absent so the table is empty (the page is gated anyway); Enterprise:
 * the providers an admin registered via /api/auth/sso/register. The provider type and
 * IdP details (SSO URL, signing-cert fingerprint, client id) are read from the stored
 * oidc/saml config JSON.
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
			samlConfig: ssoProvider.samlConfig,
			domainVerified: ssoProvider.domainVerified,
		})
		.from(ssoProvider)
		.where(eq(ssoProvider.organizationId, actor.orgId));

	return rows.map((r) => {
		const saml = parseJson<SamlCfg>(r.samlConfig);
		const oidc = parseJson<OidcCfg>(r.oidcConfig);
		return {
			id: r.id,
			providerId: r.providerId,
			domain: r.domain,
			issuer: r.issuer,
			type: r.oidcConfig ? "oidc" : "saml",
			domainVerified: r.domainVerified,
			ssoUrl: saml?.entryPoint ?? null,
			certFingerprint: certFingerprint(saml?.cert),
			clientId: oidc?.clientId ?? null,
		};
	});
}
