"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asc, eq } from "drizzle-orm";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	type Connector,
	connectors as connectorsTable,
	providerTokens,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

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
	// Auth still comes from Supabase (retired in Phase D); data is on Drizzle.
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	// Public catalog — service connection (no owner scope).
	const catalog = await getServiceDb()
		.select()
		.from(connectorsTable)
		.orderBy(asc(connectorsTable.sort_order));

	// Per-user connection state — RLS-scoped to the owner.
	const { tokenRows, cloudIdentityRows } = user
		? await withOwnerScope(user.id, async (tx) => ({
				tokenRows: await tx
					.select({
						provider: providerTokens.provider,
						expires_at: providerTokens.expires_at,
						refresh_token: providerTokens.refresh_token,
					})
					.from(providerTokens),
				cloudIdentityRows: await tx
					.select({
						id: cloudIdentities.id,
						provider: cloudIdentities.provider,
						credentials: cloudIdentities.credentials,
					})
					.from(cloudIdentities)
					.where(eq(cloudIdentities.is_verified, true)),
			}))
		: { tokenRows: [], cloudIdentityRows: [] };

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

	const identityMap = new Map<
		string,
		{ username?: string; avatar_url?: string; id?: string }
	>();
	for (const identity of user?.identities ?? []) {
		if (["github", "gitlab", "bitbucket"].includes(identity.provider)) {
			identityMap.set(identity.provider, {
				username:
					identity.identity_data?.user_name ||
					identity.identity_data?.preferred_username ||
					identity.identity_data?.name,
				avatar_url: identity.identity_data?.avatar_url,
				id: identity.id,
			});
		}
	}

	return catalog.map((connector): ConnectorWithConnection => {
		const slug = connector.slug;

		if (connector.category === "git") {
			const connected = tokens.has(slug);
			const identity = identityMap.get(slug);
			return {
				...connector,
				connected,
				connection_details:
					connected && identity
						? {
								username: identity.username,
								avatar_url: identity.avatar_url,
								identity_id: identity.id,
							}
						: null,
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
