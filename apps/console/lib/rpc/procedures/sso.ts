// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type {
	SsoBootstrap,
	SsoFilter,
	SsoProviderRow,
	SsoProviderType,
} from "@/app/server/actions/sso";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { organization, ssoProvider } from "@/lib/db/schema";
import { query } from "@/lib/rpc/base";

// THE SSO READS (ADR 0005 D1, #6129). Both bodies MOVED here from `app/server/actions/sso.ts`
// (`getSsoBootstrap`, `listSsoProviders`) — not wrapped — so the page reads them over GET and its
// RSC prefetch calls the same function in-process. The authorization is the one they had as actions:
// `member:view`, asked quietly (no activity entry). A viewer without it gets a typed FORBIDDEN, which
// the page renders as its no-access state.
//
// TENANCY. The actor is the one the read router bound for the request's ADDRESS (`lib/rpc/base.ts`);
// every predicate is `organization_id = actor.orgId`. No input names an org or a row: the provider
// list's input is a filter (text, protocol, verification state) applied inside the addressed org.
//
// The plan gate (the `sso` entitlement) is not a refusal of these reads: the page decides it on the
// server and renders the upsell as its whole body, so neither read is asked for an org without it.

/** A SAML config as stored (JSON text): only the fields the page shows. */
interface SamlCfg {
	entryPoint?: string;
	cert?: string;
}

/** An OIDC config as stored (JSON text): only the client id — never the secret. */
interface OidcCfg {
	clientId?: string;
}

/** Parses a stored JSON config column, or null when it is absent or unreadable. */
export function parseSsoConfig<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** The PEM form of a SAML signing certificate stored as PEM or as bare base64. */
export function samlCertPem(cert: string): string {
	return cert.includes("BEGIN CERTIFICATE")
		? cert
		: `-----BEGIN CERTIFICATE-----\n${cert.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;
}

/** SHA-256 fingerprint of a SAML signing cert (PEM or bare base64), or null. */
function certFingerprint(cert?: string): string | null {
	if (!cert) return null;
	try {
		return new X509Certificate(samlCertPem(cert)).fingerprint256;
	} catch {
		return null;
	}
}

/**
 * Which protocol a row is configured for. A row with an oidcConfig is OIDC; with a samlConfig,
 * SAML; with NEITHER it is broken — `unknown` rather than silently claiming SAML.
 */
export function ssoProviderType(oidcConfig: string | null, samlConfig: string | null): SsoProviderType {
	if (oidcConfig) return "oidc";
	if (samlConfig) return "saml";
	return "unknown";
}

/** The public origin the SP URLs are built on. */
function publicOrigin(): string {
	return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://alethialabs.io";
}

/**
 * Everything the SSO page needs that isn't the provider list: the `sso` entitlement, a
 * non-throwing manage-permission check, the addressed org's id and slug (registration and the
 * SP-initiated start URL name THIS org, never the session's), and the public origin. `member:view`.
 */
export async function readSsoBootstrap(): Promise<SsoBootstrap> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const [[org], decision] = await Promise.all([
		getServiceDb()
			.select({ slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, actor.orgId))
			.limit(1),
		getPdp().can(actor, "manage_members", { type: "member" }),
	]);
	return {
		sso: getEntitlements(actor).sso,
		canManage: decision.allowed,
		orgId: actor.orgId,
		slug: org?.slug ?? "",
		origin: publicOrigin(),
	};
}

/**
 * The addressed org's SSO providers, filtered SERVER-SIDE by search (providerId / domain /
 * issuer), protocol and verification status, in a stable order (provider id). `member:view`.
 */
export async function readSsoProviders(filter: SsoFilter = {}): Promise<SsoProviderRow[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
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
		.where(eq(ssoProvider.organizationId, actor.orgId))
		// ORDERED: the list is re-read on every hint, and an unordered answer re-orders the rail
		// under the person reading it. `providerId` is unique, so the order is total.
		.orderBy(ssoProvider.providerId);

	const q = filter.search?.trim().toLowerCase();
	return rows
		.map((r) => {
			const saml = parseSsoConfig<SamlCfg>(r.samlConfig);
			return {
				id: r.id,
				providerId: r.providerId,
				domain: r.domain,
				issuer: r.issuer,
				type: ssoProviderType(r.oidcConfig, r.samlConfig),
				domainVerified: r.domainVerified,
				ssoUrl: saml?.entryPoint ?? null,
				certFingerprint: certFingerprint(saml?.cert),
				clientId: parseSsoConfig<OidcCfg>(r.oidcConfig)?.clientId ?? null,
			};
		})
		.filter((p) => {
			if (q && !`${p.providerId} ${p.domain} ${p.issuer}`.toLowerCase().includes(q)) return false;
			if (filter.types?.length && !filter.types.includes(p.type)) return false;
			if (filter.statuses?.length) {
				const status = p.domainVerified ? "verified" : "pending";
				if (!filter.statuses.includes(status)) return false;
			}
			return true;
		});
}

/** The provider list's filter (`normalizeSsoQuery()`), validated. */
const providersInput = z.object({
	search: z.string().max(200).optional(),
	types: z.array(z.enum(["oidc", "saml", "unknown"])).max(3).optional(),
	statuses: z.array(z.enum(["verified", "pending"])).max(2).optional(),
});

/** The SSO reads (#6129). Both answer `member:view`; a refusal is a typed FORBIDDEN. */
export const ssoRouter = {
	bootstrap: query.handler(() => readSsoBootstrap()),
	providers: query.input(providersInput).handler(({ input }) => readSsoProviders(input)),
};
