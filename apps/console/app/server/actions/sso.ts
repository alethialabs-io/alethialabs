"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SSO identity-provider WRITES (ADR 0005 D4, #6129). The page's reads — the bootstrap and the
// provider list — moved to `lib/rpc/procedures/sso.ts` and are served over GET.
//
// Every mutation is a `defineAction` returning `ActionResult<T>`, gated on `member:manage_members`
// PLUS the Enterprise `sso` entitlement — enforced HERE (not in the ee/ better-auth guard, whose body
// matcher only sees an `organizationId` on /sso/register; update/delete/verify carry a `providerId`,
// so a matcher-based guard there would fail closed and 403 every legitimate admin). The mutations
// delegate to @better-auth/sso's own endpoints (which additionally enforce org-admin), so provider
// CRUD is never hand-rolled. The provider id addresses a row of the ADDRESSED org only
// (`ownedProvider`): another org's id is answered exactly as an unknown one is.

import { X509Certificate } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { auth } from "@/lib/auth";
import { recordActivity } from "@/lib/authz/activity";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { ssoProvider } from "@/lib/db/schema";
import { safeFetch } from "@/lib/net/ssrf-guard";
import { parseSsoConfig, samlCertPem, ssoProviderType } from "@/lib/rpc/procedures/sso";

/** OIDC or SAML — `unknown` when neither config is present (a broken/partial row). */
export type SsoProviderType = "oidc" | "saml" | "unknown";

export interface SsoProviderRow {
	id: string;
	providerId: string;
	domain: string;
	issuer: string;
	type: SsoProviderType;
	domainVerified: boolean;
	/** SAML IdP sign-on URL (entryPoint), if configured. */
	ssoUrl: string | null;
	/** SHA-256 fingerprint of the SAML signing certificate ("AB:CD:…"), if parseable. */
	certFingerprint: string | null;
	/** OIDC client id (never the secret), if configured. */
	clientId: string | null;
}

export interface SsoFilter {
	search?: string;
	types?: SsoProviderType[];
	/** "verified" | "pending" — the domain-verification state. */
	statuses?: ("verified" | "pending")[];
}

export interface SsoBootstrap {
	/** Enterprise entitlement. */
	sso: boolean;
	/** Non-throwing PDP check — drives whether mutating affordances are enabled. */
	canManage: boolean;
	/**
	 * The ADDRESSED org's id: a new provider is registered for this org, never for whichever org the
	 * session or the browser's store last made active.
	 */
	orgId: string;
	/** Addressed org slug — used to build the SP-initiated start URL. */
	slug: string;
	/** Public origin, for the SP URLs shown to the IdP admin. */
	origin: string;
}

interface SamlCfg {
	entryPoint?: string;
	cert?: string;
}

/** The mint-token response from /sso/request-domain-verification. */
const domainTokenResponse = z.object({ domainVerificationToken: z.string() });

/** The OIDC discovery document — only the fields the connection test asserts on. */
const discoveryDoc = z.object({
	issuer: z.string().optional(),
	authorization_endpoint: z.string().optional(),
	token_endpoint: z.string().optional(),
	jwks_uri: z.string().optional(),
});

/** Mutations: PDP `manage_members` + the Enterprise `sso` entitlement. Both must pass. */
async function requireSsoAdmin(): Promise<Actor> {
	const actor = await authorizeQuiet("manage_members", { type: "member" });
	if (!getEntitlements(actor).sso) {
		throw new ActionRefusal("entitlement", "Single Sign-On requires an Enterprise plan.", "sso");
	}
	return actor;
}

/**
 * Dispatches a better-auth endpoint through `auth.handler`, forwarding the caller's cookies.
 *
 * A refusal the plugin (or the middleware in front of it) WROTE for the admin comes back as an
 * `ActionRefusal` carrying the plugin's own sentence (#5445): ANY 4xx (401/403 from the session /
 * access / entitlement middleware included), and any 5xx other than 500 whose body is a better-auth
 * `APIError` with a `code` — the 502 `DOMAIN_VERIFICATION_FAILED` for a TXT record that is not
 * visible yet is that case. `defineAction` hands that sentence to the page verbatim. A 500, and a
 * 5xx with no `code` in its body, is the server failing: it throws a plain Error, which
 * `defineAction` turns into an `unexpected` result whose text never reaches the browser.
 *
 * The SSO endpoints come from the `sso()` plugin, which is loaded through the ee/ seam
 * (getAuthPlugins) — so `auth.api` cannot statically know about them, and the open-core guard
 * forbids importing `@alethia/ee` here to recover the types. `auth.handler` is the typed,
 * cast-free dispatcher, and it still runs better-auth's own middleware (session resolution, the
 * plugin's org-admin `checkProviderAccess`, and the ee entitlement guard).
 */
async function callAuth(path: string, body: unknown): Promise<Response> {
	const h = await headers();
	const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
	const forwardedHeaders = new Headers(h);
	forwardedHeaders.set("content-type", "application/json");
	const res = await auth.handler(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: forwardedHeaders,
			body: JSON.stringify(body),
		}),
	);
	if (res.ok) return res;
	const text = await res.text();
	let message = text || `SSO request failed (HTTP ${res.status})`;
	// Whether the body is a better-auth `APIError` — `{ code, message }`, a refusal the plugin
	// WROTE — rather than whatever an unhandled failure produced.
	let authored = false;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string") {
			message = parsed.message;
			authored = "code" in parsed && typeof parsed.code === "string";
		}
	} catch {
		// non-JSON body — keep the raw text
	}
	// A refusal is any 4xx, AND an authored non-500. The second half is not decoration: the plugin
	// answers the commonest verification failure of all — the TXT record is not visible yet — as a
	// 502 `DOMAIN_VERIFICATION_FAILED`, and a 4xx-only rule would have hidden exactly that one.
	const refusal = (res.status >= 400 && res.status < 500) || (authored && res.status !== 500);
	if (refusal) throw new ActionRefusal("conflict", message);
	throw new Error(message);
}

/** Resolves a provider that belongs to the actor's org; any other id is not found. */
async function ownedProvider(actor: Actor, id: string) {
	const [row] = await getServiceDb()
		.select({
			id: ssoProvider.id,
			providerId: ssoProvider.providerId,
			domain: ssoProvider.domain,
			issuer: ssoProvider.issuer,
			oidcConfig: ssoProvider.oidcConfig,
			samlConfig: ssoProvider.samlConfig,
		})
		.from(ssoProvider)
		.where(and(eq(ssoProvider.id, id), eq(ssoProvider.organizationId, actor.orgId)))
		.limit(1);
	if (!row) throw new ActionRefusal("not-found", "Provider not found");
	return row;
}

/** A provider addressed by its row id. */
const providerIdInput = z.object({ id: z.string().uuid() });

/** An edit: the provider's row id and the fields to merge into its stored config. */
const updateInput = z.object({
	id: z.string().uuid(),
	/** Trust-domain the IdP asserts for. */
	domain: z.string().trim().min(1).max(253).optional(),
	issuer: z.string().trim().min(1).max(2048).optional(),
	/** OIDC. Omit clientSecret to keep the stored one (never send it back to the client). */
	clientId: z.string().trim().min(1).max(512).optional(),
	clientSecret: z.string().trim().min(1).max(4096).optional(),
	/** SAML. */
	entryPoint: z.string().trim().min(1).max(2048).optional(),
	cert: z.string().trim().min(1).max(20_000).optional(),
	/** IdP claim → user field mapping, merged into the stored config. */
	mapping: z.record(z.string().max(64), z.string().max(256)).optional(),
});

/** What the edit form sends ({@link updateSsoProvider}). */
export type SsoUpdateInput = z.input<typeof updateInput>;

/**
 * Updates a provider through @better-auth/sso's own endpoint. The plugin MERGES into the stored
 * oidc/saml config, so omitted secrets (clientSecret, cert) are preserved — a secret is never
 * round-tripped to the browser just to save it back.
 */
export async function updateSsoProvider(raw: SsoUpdateInput): Promise<ActionResult<{ updated: true }>> {
	return defineAction({
		input: updateInput,
		run: async ({ input }) => {
			const actor = await requireSsoAdmin();
			const row = await ownedProvider(actor, input.id);

			const type = ssoProviderType(row.oidcConfig, row.samlConfig);
			const body: Record<string, unknown> = { providerId: row.providerId };
			if (input.domain) body.domain = input.domain;
			if (input.issuer) body.issuer = input.issuer;
			if (type === "oidc") {
				const oidcConfig: Record<string, unknown> = {};
				if (input.clientId) oidcConfig.clientId = input.clientId;
				if (input.clientSecret) oidcConfig.clientSecret = input.clientSecret;
				if (input.mapping) oidcConfig.mapping = input.mapping;
				if (Object.keys(oidcConfig).length > 0) body.oidcConfig = oidcConfig;
			} else if (type === "saml") {
				const samlConfig: Record<string, unknown> = {};
				if (input.entryPoint) samlConfig.entryPoint = input.entryPoint;
				if (input.cert) samlConfig.cert = input.cert;
				if (input.mapping) samlConfig.mapping = input.mapping;
				if (Object.keys(samlConfig).length > 0) body.samlConfig = samlConfig;
			}

			await callAuth("/sso/update-provider", body);

			emitAlertEventSafe(actor.orgId, "authz.sso.edit", {
				title: `SSO provider updated: ${row.providerId}`,
				severity: "warning",
				actor_id: actor.userId,
				action: "edit",
				resource_type: "sso_provider",
				resource_id: row.id,
			});
			recordActivity(actor, "edit", { type: "sso_provider", id: row.id });
			return { updated: true as const };
		},
	})(raw);
}

/** Removes a provider (its users can no longer sign in through it). */
export async function deleteSsoProvider(
	raw: z.input<typeof providerIdInput>,
): Promise<ActionResult<{ deleted: true }>> {
	return defineAction({
		input: providerIdInput,
		run: async ({ input }) => {
			const actor = await requireSsoAdmin();
			const row = await ownedProvider(actor, input.id);

			await callAuth("/sso/delete-provider", { providerId: row.providerId });

			emitAlertEventSafe(actor.orgId, "authz.sso.delete", {
				title: `SSO provider removed: ${row.providerId}`,
				severity: "warning",
				actor_id: actor.userId,
				action: "delete",
				resource_type: "sso_provider",
				resource_id: row.id,
			});
			recordActivity(actor, "destroy", { type: "sso_provider", id: row.id });
			return { deleted: true as const };
		},
	})(raw);
}

/** The TXT record an admin publishes to prove control of a provider's domain. */
export interface SsoDomainToken {
	record: string;
	token: string;
}

/** Mints (or re-mints) the DNS TXT token proving control of the provider's domain. */
export async function requestSsoDomainVerification(
	raw: z.input<typeof providerIdInput>,
): Promise<ActionResult<SsoDomainToken>> {
	return defineAction({
		input: providerIdInput,
		run: async ({ input }) => {
			const actor = await requireSsoAdmin();
			const row = await ownedProvider(actor, input.id);

			const res = await callAuth("/sso/request-domain-verification", { providerId: row.providerId });
			const parsed = domainTokenResponse.safeParse(await res.json());
			if (!parsed.success) throw new Error("Could not mint a verification token.");

			// The plugin's record name is `_<tokenPrefix>-<providerId>` (RFC 8552 underscore-prefixed).
			return { record: `_alethia-sso-${row.providerId}`, token: parsed.data.domainVerificationToken };
		},
	})(raw);
}

/** Checks the DNS TXT record and, on success, flips `domain_verified`. */
export async function verifySsoDomain(
	raw: z.input<typeof providerIdInput>,
): Promise<ActionResult<{ verified: true }>> {
	return defineAction({
		input: providerIdInput,
		run: async ({ input }) => {
			const actor = await requireSsoAdmin();
			const row = await ownedProvider(actor, input.id);

			await callAuth("/sso/verify-domain", { providerId: row.providerId });

			emitAlertEventSafe(actor.orgId, "authz.sso.domain_verified", {
				title: `SSO domain verified: ${row.domain}`,
				severity: "info",
				actor_id: actor.userId,
				action: "edit",
				resource_type: "sso_provider",
				resource_id: row.id,
			});
			recordActivity(actor, "edit", { type: "sso_provider", id: row.id });
			return { verified: true as const };
		},
	})(raw);
}

export interface SsoTestCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
}
export interface SsoTestResult {
	ok: boolean;
	checks: SsoTestCheck[];
}

/**
 * A REAL connection preflight.
 *  - OIDC: fetch the issuer's discovery document and assert the endpoints + issuer match.
 *  - SAML: parse the signing certificate and assert it isn't expired, and the entryPoint is https.
 *
 * The OIDC fetch targets a TENANT-SUPPLIED url, so it goes through `safeFetch` (the repo's
 * hardened SSRF sink: https-only, DNS-resolve-then-pin against rebinding, private/loopback/
 * link-local/metadata-IP rejection, per-hop redirect re-validation).
 */
export async function testSsoProvider(raw: z.input<typeof providerIdInput>): Promise<ActionResult<SsoTestResult>> {
	return defineAction({
		input: providerIdInput,
		run: async ({ input }) => {
			const actor = await requireSsoAdmin();
			const row = await ownedProvider(actor, input.id);
			return runConnectionTest(row);
		},
	})(raw);
}

/** The checks {@link testSsoProvider} reports, for one owned provider row. */
async function runConnectionTest(row: {
	issuer: string;
	oidcConfig: string | null;
	samlConfig: string | null;
}): Promise<SsoTestResult> {
	const type = ssoProviderType(row.oidcConfig, row.samlConfig);
	const checks: SsoTestCheck[] = [];

	if (type === "oidc") {
		const url = `${row.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
		try {
			const res = await safeFetch(url, { headers: { accept: "application/json" } });
			checks.push({
				id: "discovery",
				label: "Discovery document",
				ok: res.ok,
				detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} from ${url}`,
			});
			if (res.ok) {
				const parsed = discoveryDoc.safeParse(await res.json());
				const doc = parsed.success ? parsed.data : {};
				for (const [key, label] of [
					["authorization_endpoint", "Authorization endpoint"],
					["token_endpoint", "Token endpoint"],
					["jwks_uri", "JWKS URI"],
				] as const) {
					const value = doc[key];
					checks.push({ id: key, label, ok: Boolean(value), detail: value ?? "missing from the discovery document" });
				}
				const matches = doc.issuer?.replace(/\/$/, "") === row.issuer.replace(/\/$/, "");
				checks.push({
					id: "issuer",
					label: "Issuer matches",
					ok: matches,
					detail: matches ? row.issuer : `document says "${doc.issuer ?? "—"}", provider says "${row.issuer}"`,
				});
			}
		} catch (err) {
			checks.push({
				id: "discovery",
				label: "Discovery document",
				ok: false,
				detail: err instanceof Error ? err.message : "request failed",
			});
		}
	} else if (type === "saml") {
		const saml = parseSsoConfig<SamlCfg>(row.samlConfig);
		try {
			const cert = new X509Certificate(samlCertPem(saml?.cert ?? ""));
			const notAfter = new Date(cert.validTo);
			const valid = notAfter.getTime() > Date.now();
			checks.push({
				id: "cert",
				label: "Signing certificate",
				ok: valid,
				detail: valid
					? `valid until ${notAfter.toISOString().slice(0, 10)}`
					: `EXPIRED on ${notAfter.toISOString().slice(0, 10)}`,
			});
		} catch {
			checks.push({ id: "cert", label: "Signing certificate", ok: false, detail: "could not be parsed" });
		}
		const entry = saml?.entryPoint ?? "";
		const https = entry.startsWith("https://");
		checks.push({ id: "entrypoint", label: "IdP sign-on URL", ok: https, detail: https ? entry : "must be an https:// URL" });
	} else {
		checks.push({
			id: "config",
			label: "Provider configuration",
			ok: false,
			detail: "neither an OIDC nor a SAML config is stored — re-register this provider",
		});
	}

	return { ok: checks.every((c) => c.ok), checks };
}
