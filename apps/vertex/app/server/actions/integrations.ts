"use server";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";
import type {
	PublicIntegrationsRow,
	PublicIntegrationCategory,
	PublicIntegrationAuthMethod,
	PublicIntegrationStatus,
} from "@/lib/validations/db.schemas";

export type IntegrationConnectionDetails = {
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

export type IntegrationWithConnection = PublicIntegrationsRow & {
	connected: boolean;
	connection_details: IntegrationConnectionDetails | null;
	token_health?: GitTokenHealth;
};

export type { PublicIntegrationCategory, PublicIntegrationAuthMethod, PublicIntegrationStatus };

export async function getIntegrationsWithStatus(): Promise<
	IntegrationWithConnection[]
> {
	const supabase = await createClient();

	const [integrationsResult, tokensResult, cloudResult, userResult] =
		await Promise.all([
			supabase.from("integrations").select("*").order("sort_order"),
			supabase.from("provider_tokens").select("provider, expires_at, refresh_token"),
			supabase
				.from("cloud_identities")
				.select("id, provider, credentials, is_verified")
				.eq("is_verified", true),
			supabase.auth.getUser(),
		]);

	const integrations = integrationsResult.data ?? [];
	const tokenRows = tokensResult.data ?? [];
	const tokens = new Set<string>(tokenRows.map((t) => t.provider));
	const tokenHealthMap = new Map<string, GitTokenHealth>();
	for (const t of tokenRows) {
		if (!t.expires_at || new Date(t.expires_at) > new Date()) {
			tokenHealthMap.set(t.provider, "healthy");
		} else if (t.refresh_token) {
			tokenHealthMap.set(t.provider, "expired");
		} else {
			tokenHealthMap.set(t.provider, "refresh_failed");
		}
	}
	const cloudIdentities = cloudResult.data ?? [];
	const user = userResult.data?.user;

	const identityMap = new Map<
		string,
		{ username?: string; avatar_url?: string; id?: string }
	>();
	if (user?.identities) {
		for (const identity of user.identities) {
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
	}

	return integrations.map((integration) => {
		const slug = integration.slug;
		let connected = false;
		let connection_details: IntegrationConnectionDetails | null = null;

		if (integration.category === "git") {
			connected = tokens.has(slug);
			const identity = identityMap.get(slug);
			if (connected && identity) {
				connection_details = {
					username: identity.username,
					avatar_url: identity.avatar_url,
					identity_id: identity.id,
				};
			}
			return {
				...integration,
				connected,
				connection_details,
				token_health: connected ? tokenHealthMap.get(slug) : undefined,
			};
		} else if (integration.category === "cloud") {
			const cloudIdentity = cloudIdentities.find(
				(ci) => ci.provider === slug,
			);
			if (cloudIdentity) {
				connected = true;
				const creds = cloudIdentity.credentials;
				connection_details = {
					account_id: creds?.account_id ?? undefined,
					role_arn: creds?.role_arn ?? undefined,
					project_id: creds?.project_id ?? undefined,
					service_account_email: creds?.service_account_email ?? undefined,
					tenant_id: creds?.tenant_id ?? undefined,
					subscription_id: creds?.subscription_id ?? undefined,
					cloud_identity_id: cloudIdentity.id,
				};
			}
		}

		return {
			...integration,
			connected,
			connection_details,
		};
	});
}
