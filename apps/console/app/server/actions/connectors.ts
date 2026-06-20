"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	account,
	cloudIdentities,
	type Connector,
	connectorCredentials,
	connectors as connectorsTable,
} from "@/lib/db/schema";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getIntegrationProviderBySlug } from "@/lib/integrations/registry.generated";
import { verifyConnectorCredential as pingConnector } from "@/lib/integrations/verify";
import type { ConnectorCredentials } from "@/types/database-custom.types";

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

export type ConnectorWithConnection = Connector & {
	connected: boolean;
	connection_details: ConnectorConnectionDetails | null;
	token_health?: GitTokenHealth;
};

/** Connectors catalog + the current user's connection status per connector. */
export async function getConnectorsWithStatus(): Promise<
	ConnectorWithConnection[]
> {
	const userId = await getOwner();

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
	const cloudIdentityRows = userId
		? await withOwnerScope(userId, (tx) =>
				tx
					.select({
						id: cloudIdentities.id,
						provider: cloudIdentities.provider,
						credentials: cloudIdentities.credentials,
					})
					.from(cloudIdentities)
					.where(eq(cloudIdentities.is_verified, true)),
			)
		: [];

	// api_key connector credentials (dns/secrets/registry/observability), keyed by
	// connector slug. Secrets stay encrypted here — only `is_verified` is needed.
	const credentialRows = userId
		? await withOwnerScope(userId, (tx) =>
				tx
					.select({
						slug: connectorsTable.slug,
						is_verified: connectorCredentials.is_verified,
					})
					.from(connectorCredentials)
					.innerJoin(
						connectorsTable,
						eq(connectorsTable.id, connectorCredentials.connector_id),
					),
			)
		: [];
	const credentialBySlug = new Map(
		credentialRows.map((c) => [c.slug, c.is_verified ?? false]),
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

	return catalog.map((connector): ConnectorWithConnection => {
		const slug = connector.slug;

		if (connector.category === "git") {
			const connected = tokens.has(slug);
			// Username/avatar enrichment is rebuilt from the Better Auth `account`
			// table in D6; connected + token_health drive the UI meanwhile.
			return {
				...connector,
				connected,
				connection_details: null,
				token_health: connected ? tokenHealth.get(slug) : undefined,
			};
		}

		if (connector.category === "cloud") {
			const cloud = cloudIdentityRows.find((ci) => ci.provider === slug);
			if (cloud) {
				const creds = cloud.credentials;
				return {
					...connector,
					connected: true,
					connection_details: {
						account_id: creds?.account_id ?? undefined,
						role_arn: creds?.role_arn ?? undefined,
						project_id: creds?.project_id ?? undefined,
						service_account_email: creds?.service_account_email ?? undefined,
						tenant_id: creds?.tenant_id ?? undefined,
						subscription_id: creds?.subscription_id ?? undefined,
						cloud_identity_id: cloud.id,
					},
				};
			}
		}

		// api_key pluggable providers (dns/secrets/registry/observability).
		if (connector.auth_method === "api_key" && credentialBySlug.has(slug)) {
			return {
				...connector,
				connected: true,
				connection_details: null,
				token_health: credentialBySlug.get(slug)
					? "healthy"
					: "refresh_failed",
			};
		}

		return { ...connector, connected: false, connection_details: null };
	});
}

export type ConnectorCredentialResult =
	| { ok: true; verified: boolean; message?: string }
	| { ok: false; error: string };

/**
 * Splits submitted fields into non-secret (plaintext) + secret (encrypted)
 * groups per the provider's registry credential spec, builds the stored envelope,
 * pings the provider to verify, and upserts the connector_credentials row. Returns
 * whether the credential verified; an unverified credential is still saved.
 */
export async function saveConnectorCredential(
	slug: string,
	fields: Record<string, string>,
): Promise<ConnectorCredentialResult> {
	const userId = await getOwner();
	if (!userId) return { ok: false, error: "Not authenticated." };

	const provider = getIntegrationProviderBySlug(slug);
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

	await withOwnerScope(userId, (tx) =>
		tx
			.insert(connectorCredentials)
			.values({
				user_id: userId,
				connector_id: connector.id,
				credentials,
				is_verified: verdict.ok,
			})
			.onConflictDoUpdate({
				target: [
					connectorCredentials.user_id,
					connectorCredentials.connector_id,
				],
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
	const userId = await getOwner();
	if (!userId) return { ok: false, error: "Not authenticated." };

	const [connector] = await getServiceDb()
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) return { ok: false, error: `Connector not in catalog: ${slug}` };

	await withOwnerScope(userId, (tx) =>
		tx
			.delete(connectorCredentials)
			.where(
				and(
					eq(connectorCredentials.user_id, userId),
					eq(connectorCredentials.connector_id, connector.id),
				),
			),
	);
	return { ok: true };
}
