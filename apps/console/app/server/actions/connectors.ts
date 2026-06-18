"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asc, eq } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	account,
	cloudIdentities,
	type Connector,
	connectors as connectorsTable,
} from "@/lib/db/schema";

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

		return { ...connector, connected: false, connection_details: null };
	});
}
