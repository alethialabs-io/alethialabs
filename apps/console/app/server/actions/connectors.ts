"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb, withScope } from "@/lib/db";
import {
	account,
	cloudIdentities,
	type Connector,
	connectorCredentials,
	connectors as connectorsTable,
} from "@/lib/db/schema";
import type { CredentialScope } from "@/lib/db/schema/enums";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { verifyConnectorCredential as pingConnector } from "@/lib/connectors/verify";
import type { ConnectorCredentials } from "@/types/jsonb.types";

export type ConnectorCategory = Connector["category"];
export type ConnectorAuthMethod = Connector["auth_method"];
export type ConnectorStatus = Connector["status"];

export type ConnectorConnectionDetails = {
	username?: string;
	avatar_url?: string;
	identity_id?: string;
	account_id?: string;
	role_arn?: string;
	project_id?: string;
	service_account_email?: string;
	tenant_id?: string;
	subscription_id?: string;
	cloud_identity_id?: string;
};

export type GitTokenHealth = "healthy" | "expired" | "refresh_failed";

/** The four presentation groups the connectors page renders (from the design). */
export type ConnectorGroup = "clouds" | "secrets" | "registries" | "apps";

/** One connected cloud account (a verified cloud_identity row). */
export type CloudAccount = {
	identityId: string;
	name: string;
	/** Short descriptor — account id / project / subscription. */
	label?: string;
};

/** Maps a catalog category to its presentation group on the connectors page. */
function groupForCategory(category: ConnectorCategory): ConnectorGroup {
	switch (category) {
		case "cloud":
			return "clouds";
		case "secrets":
			return "secrets";
		case "registry":
			return "registries";
		default:
			// git, observability, dns → external app/service connections
			return "apps";
	}
}

export type ConnectorWithConnection = Connector & {
	connected: boolean;
	connection_details: ConnectorConnectionDetails | null;
	token_health?: GitTokenHealth;
	/** Visibility of the backing credential (cloud / api_key). Undefined for git. */
	scope?: CredentialScope;
	/** The presentation group (clouds / secrets / registries / apps). */
	group: ConnectorGroup;
	/** Connected accounts for cloud connectors (a provider can hold several). */
	accounts?: CloudAccount[];
	/**
	 * For a not-yet-connected cloud connector whose latest verification is in flight
	 * or failed — drives the "Verifying…" / "Verification failed → Re-verify" states.
	 */
	cloud_health?: "testing" | "failed";
	/** The last verification error (set when `cloud_health === "failed"`). */
	last_error?: string;
	/** The cloud identity to re-verify (for a failed/testing cloud connector). */
	reverify_identity_id?: string;
};

/** Connectors catalog + the current user's connection status per connector. */
export async function getConnectorsWithStatus(): Promise<
	ConnectorWithConnection[]
> {
	// Resolve the active tenancy scope so org-shared credentials (scope='org') show up
	// for every member, not just the author. Git tokens stay per-user (account table).
	let scope: { userId: string; orgId: string } | null = null;
	try {
		const actor = await currentActor();
		scope = { userId: actor.userId, orgId: actor.orgId };
	} catch {
		scope = null;
	}
	const userId = scope?.userId ?? null;

	// Public catalog — service connection (no owner scope).
	const catalog = await getServiceDb()
		.select()
		.from(connectorsTable)
		.orderBy(asc(connectorsTable.sort_order));

	// Git provider tokens live in Better Auth's `account` table (service-managed —
	// read via serviceDb scoped by user_id). Cloud identities stay RLS-scoped.
	const tokenRows = userId
		? await getServiceDb()
				.select({
					provider: account.providerId,
					expires_at: account.accessTokenExpiresAt,
					refresh_token: account.refreshToken,
				})
				.from(account)
				.where(eq(account.userId, userId))
		: [];
	const cloudIdentityRows = scope
		? await withScope({ ownerId: scope.userId, orgId: scope.orgId }, (tx) =>
				tx
					.select({
						id: cloudIdentities.id,
						name: cloudIdentities.name,
						provider: cloudIdentities.provider,
						credentials: cloudIdentities.credentials,
						scope: cloudIdentities.scope,
					})
					.from(cloudIdentities)
					.where(eq(cloudIdentities.is_verified, true)),
			)
		: [];

	// Latest non-verified cloud identity per provider — drives the "Verifying…" /
	// "Verification failed → Re-verify" treatment for connectors with no connected
	// account yet. Newest first so the first seen per provider is the latest attempt.
	const cloudHealthRows = scope
		? await withScope({ ownerId: scope.userId, orgId: scope.orgId }, (tx) =>
				tx
					.select({
						id: cloudIdentities.id,
						provider: cloudIdentities.provider,
						status: cloudIdentities.status,
						last_error: cloudIdentities.last_error,
					})
					.from(cloudIdentities)
					.where(eq(cloudIdentities.is_verified, false))
					.orderBy(desc(cloudIdentities.updated_at)),
			)
		: [];
	const cloudHealthByProvider = new Map<
		string,
		{ status: string; last_error: string | null; identityId: string }
	>();
	for (const r of cloudHealthRows) {
		if (!cloudHealthByProvider.has(r.provider)) {
			cloudHealthByProvider.set(r.provider, {
				status: r.status,
				last_error: r.last_error,
				identityId: r.id,
			});
		}
	}

	// api_key connector credentials (dns/secrets/registry/observability), keyed by
	// connector slug. Secrets stay encrypted here — only `is_verified` is needed.
	// RLS returns the member's personal creds + the org's shared creds.
	const credentialRows = scope
		? await withScope({ ownerId: scope.userId, orgId: scope.orgId }, (tx) =>
				tx
					.select({
						slug: connectorsTable.slug,
						is_verified: connectorCredentials.is_verified,
						scope: connectorCredentials.scope,
					})
					.from(connectorCredentials)
					.innerJoin(
						connectorsTable,
						eq(connectorsTable.id, connectorCredentials.connector_id),
					),
			)
		: [];
	const credentialBySlug = new Map(
		credentialRows.map((c) => [
			c.slug,
			{ verified: c.is_verified ?? false, scope: c.scope },
		]),
	);

	const tokens = new Set<string>(tokenRows.map((t) => t.provider));
	const tokenHealth = new Map<string, GitTokenHealth>();
	for (const t of tokenRows) {
		if (!t.expires_at || new Date(t.expires_at) > new Date()) {
			tokenHealth.set(t.provider, "healthy");
		} else if (t.refresh_token) {
			tokenHealth.set(t.provider, "expired");
		} else {
			tokenHealth.set(t.provider, "refresh_failed");
		}
	}

	/** Builds the short account descriptor shown on a cloud account row. */
	const accountLabel = (creds: typeof cloudIdentityRows[number]["credentials"]) =>
		creds?.account_id ??
		creds?.project_id ??
		creds?.subscription_id ??
		undefined;

	return catalog.map((connector): ConnectorWithConnection => {
		const slug = connector.slug;
		const group = groupForCategory(connector.category);

		if (connector.category === "git") {
			const connected = tokens.has(slug);
			// Username/avatar enrichment is rebuilt from the Better Auth `account`
			// table in D6; connected + token_health drive the UI meanwhile.
			return {
				...connector,
				group,
				connected,
				connection_details: null,
				token_health: connected ? tokenHealth.get(slug) : undefined,
			};
		}

		if (connector.category === "cloud") {
			// A provider can hold several accounts — collect them all (org-scoped).
			const rows = cloudIdentityRows.filter((ci) => ci.provider === slug);
			if (rows.length > 0) {
				const accounts: CloudAccount[] = rows.map((ci) => ({
					identityId: ci.id,
					name: ci.name,
					label: accountLabel(ci.credentials),
				}));
				const primary = rows[0];
				const creds = primary.credentials;
				return {
					...connector,
					group,
					connected: true,
					scope: primary.scope,
					accounts,
					connection_details: {
						account_id: creds?.account_id ?? undefined,
						role_arn: creds?.role_arn ?? undefined,
						project_id: creds?.project_id ?? undefined,
						service_account_email: creds?.service_account_email ?? undefined,
						tenant_id: creds?.tenant_id ?? undefined,
						subscription_id: creds?.subscription_id ?? undefined,
						cloud_identity_id: primary.id,
					},
				};
			}
			const health = cloudHealthByProvider.get(slug);
			// A disconnected identity (auth lost) surfaces like a failed verification — Re-verify.
			const cloud_health =
				health?.status === "failed" || health?.status === "disconnected"
					? "failed"
					: health?.status === "testing"
						? "testing"
						: undefined;
			return {
				...connector,
				group,
				connected: false,
				accounts: [],
				connection_details: null,
				cloud_health,
				last_error:
					cloud_health === "failed"
						? (health?.last_error ?? undefined)
						: undefined,
				reverify_identity_id: cloud_health ? health?.identityId : undefined,
			};
		}

		// api_key pluggable providers (dns/secrets/registry/observability).
		if (connector.auth_method === "api_key" && credentialBySlug.has(slug)) {
			const cred = credentialBySlug.get(slug);
			return {
				...connector,
				group,
				connected: true,
				scope: cred?.scope,
				connection_details: null,
				token_health: cred?.verified ? "healthy" : "refresh_failed",
			};
		}

		return { ...connector, group, connected: false, connection_details: null };
	});
}

export type ConnectorCredentialResult =
	| { ok: true; verified: boolean; message?: string }
	| { ok: false; error: string };

/**
 * Splits submitted fields into non-secret (plaintext) + secret (encrypted)
 * groups per the provider's registry credential project, builds the stored envelope,
 * pings the provider to verify, and upserts the connector_credentials row. Returns
 * whether the credential verified; an unverified credential is still saved.
 */
export async function saveConnectorCredential(
	slug: string,
	fields: Record<string, string>,
): Promise<ConnectorCredentialResult> {
	const actor = await authorize("manage_connectors", { type: "connector" });

	const provider = getConnectorProviderBySlug(slug);
	if (!provider) return { ok: false, error: `Unknown connector: ${slug}` };

	// Validate required fields up front.
	for (const f of provider.credentialFields) {
		if (f.required && !fields[f.key]?.trim()) {
			return { ok: false, error: `${f.label} is required.` };
		}
	}

	const [connector] = await getServiceDb()
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) return { ok: false, error: `Connector not in catalog: ${slug}` };

	// Partition into non-secret (stored plaintext) and secret (AEAD-encrypted).
	const plain: Record<string, string> = {};
	const secret: Record<string, string> = {};
	for (const f of provider.credentialFields) {
		const value = fields[f.key];
		if (value === undefined || value === "") continue;
		if (f.secret) secret[f.key] = value;
		else plain[f.key] = value;
	}

	// Verify against the live provider with the full (decrypted) field set.
	const verdict = await pingConnector(slug, fields);

	let credentials: ConnectorCredentials;
	try {
		credentials = {
			fields: plain,
			secret: Object.keys(secret).length ? encryptSecret(secret) : null,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error
					? err.message
					: "Failed to encrypt the credential.",
		};
	}

	// Connectors are org-scoped: a saved credential is shared with the whole org (subject
	// to the manage_connectors permission, enforced above). The conflict target is the
	// org partial-unique index, so the targetWhere mirrors its predicate.
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.insert(connectorCredentials)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
				connector_id: connector.id,
				scope: "org",
				credentials,
				is_verified: verdict.ok,
			})
			.onConflictDoUpdate({
				target: [
					connectorCredentials.org_id,
					connectorCredentials.connector_id,
				],
				targetWhere: sql`scope = 'org'`,
				set: {
					credentials,
					is_verified: verdict.ok,
					updated_at: new Date(),
				},
			}),
	);

	return { ok: true, verified: verdict.ok, message: verdict.message };
}

/** Removes a stored api_key credential for the given connector slug. */
export async function deleteConnectorCredential(
	slug: string,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_connectors", { type: "connector" });

	const [connector] = await getServiceDb()
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) return { ok: false, error: `Connector not in catalog: ${slug}` };

	// Tenancy is enforced by withScope + RLS (scoped_all); filter by the resource key
	// only — an explicit org_id predicate is redundant and trips check:authz-scope.
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.delete(connectorCredentials)
			.where(eq(connectorCredentials.connector_id, connector.id)),
	);
	return { ok: true };
}

/**
 * Shares an api_key connector credential with the whole org (scope='org') or pulls it
 * back to personal. Managing org credentials is a PDP `manage_connectors` action — so
 * it also flows through the activity/alert chokepoint. Promotes the caller's personal row;
 * demotes the org row back to its author.
 */
export async function setConnectorCredentialScope(
	slug: string,
	scope: CredentialScope,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_connectors", { type: "connector" });
	const db = getServiceDb();

	const [connector] = await db
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) return { ok: false, error: `Connector not in catalog: ${slug}` };

	try {
		const updated =
			scope === "org"
				? await db
						.update(connectorCredentials)
						.set({ scope: "org", org_id: actor.orgId, updated_at: new Date() })
						.where(
							and(
								eq(connectorCredentials.connector_id, connector.id),
								eq(connectorCredentials.user_id, actor.userId), // authz-scope-ok: actor's own personal credential (personal→org promotion)
								eq(connectorCredentials.scope, "personal"),
							),
						)
						.returning({ id: connectorCredentials.id })
				: await db
						.update(connectorCredentials)
						// Back to personal: org_id follows the author so personal RLS holds.
						.set({
							scope: "personal",
							org_id: sql`user_id`,
							updated_at: new Date(),
						})
						.where(
							and(
								eq(connectorCredentials.connector_id, connector.id),
								eq(connectorCredentials.org_id, actor.orgId),
								eq(connectorCredentials.scope, "org"),
							),
						)
						.returning({ id: connectorCredentials.id });

		if (updated.length === 0) {
			return {
				ok: false,
				error:
					scope === "org"
						? "No personal credential to share."
						: "No shared credential to make personal.",
			};
		}
		return { ok: true };
	} catch {
		return {
			ok: false,
			error: `An ${scope === "org" ? "org" : "personal"} credential already exists for this connector.`,
		};
	}
}

/**
 * Shares a cloud identity with the org (scope='org') or pulls it back to personal.
 * Guarded by the PDP `manage_identities` action.
 */
export async function setCloudIdentityScope(
	identityId: string,
	scope: CredentialScope,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const db = getServiceDb();

	try {
		const updated =
			scope === "org"
				? await db
						.update(cloudIdentities)
						.set({ scope: "org", org_id: actor.orgId, updated_at: new Date() })
						.where(
							and(
								eq(cloudIdentities.id, identityId),
								eq(cloudIdentities.user_id, actor.userId), // authz-scope-ok: actor's own personal cloud identity (personal→org promotion)
								eq(cloudIdentities.scope, "personal"),
							),
						)
						.returning({ id: cloudIdentities.id })
				: await db
						.update(cloudIdentities)
						.set({
							scope: "personal",
							org_id: sql`user_id`,
							updated_at: new Date(),
						})
						.where(
							and(
								eq(cloudIdentities.id, identityId),
								eq(cloudIdentities.org_id, actor.orgId),
								eq(cloudIdentities.scope, "org"),
							),
						)
						.returning({ id: cloudIdentities.id });

		if (updated.length === 0) {
			return { ok: false, error: "Cloud identity not found for this action." };
		}
		return { ok: true };
	} catch {
		return { ok: false, error: "Could not change the credential's scope." };
	}
}
