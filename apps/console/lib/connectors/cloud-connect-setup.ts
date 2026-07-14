// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	getConnectorsWithStatus,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { getValidProviderToken } from "@/app/server/actions/identities";
import {
	getAwsConnectionStatus,
	initAwsIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import {
	getGcpConnectionStatus,
	initGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import {
	getAzureConnectionStatus,
	initAzureIdentity,
} from "@/app/(private)/dashboard/providers/azure-actions";
import {
	getExtraCloudStatus,
	initExtraCloudIdentity,
} from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import { currentActor } from "@/lib/authz/guard";
import { getPdp } from "@/lib/authz";
import { getAuthConfig } from "@/lib/config/auth";
import { oidcIssuerConfigured } from "@/lib/oidc/issuer";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

/** The connect-flow setup bundle shared by the connectors board and the create-project form. */
export interface CloudConnectSetup {
	canManage: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup: Record<string, { identityId: string; externalId?: string }>;
	/**
	 * Whether THIS instance is configured to support a provider's connect flow (keyed by connector
	 * slug). Managed clouds (aws/gcp/azure/alibaba) federate into the customer's role off Alethia's OIDC
	 * issuer — without the issuer configured a connect can only ever fail (Azure needs no platform app id — it
	 * authenticates as the customer's own UAMI, parity with AWS/GCP/Alibaba). Git providers
	 * (github/gitlab/bitbucket) need an OAuth app registered in Better Auth — without its
	 * client id/secret `linkSocial` rejects. In both cases the UI says "not enabled on this
	 * instance" up-front instead of offering a doomed Connect. Token clouds
	 * (hetzner/digitalocean/civo) need nothing → always true.
	 */
	platformConfigured: Record<string, boolean>;
}

/**
 * Per-provider connect-availability on this instance — mirrors what each session/health probe reads
 * (clouds) and what Better Auth has registered (git OAuth apps). Slugs absent from the map default to
 * available at the call site.
 */
export function computePlatformConfigured(): Record<string, boolean> {
	const gitProviders = getAuthConfig().providers;
	return {
		// AWS is keyless via DIRECT OIDC: the customer's IAM role trusts the Alethia issuer (an IAM OIDC
		// provider), so the console/runner federate straight in via AssumeRoleWithWebIdentity — no platform
		// AWS account, no ExternalId. Available whenever the issuer is configured.
		aws: oidcIssuerConfigured(),
		// Azure is keyless + customer-side: the customer's managed identity (its client id stored per
		// connection) authenticates via a minted OIDC assertion from the issuer — no client secret, no
		// platform Entra app. Available whenever the issuer is configured (parity with AWS/GCP/Alibaba).
		azure: oidcIssuerConfigured(),
		// Alibaba is keyless + account-free: the console assumes the customer RAM role via
		// AssumeRoleWithOIDC with a minted assertion — no Alibaba account / platform AccessKey.
		// Available whenever the issuer is configured.
		alibaba: oidcIssuerConfigured(),
		// GCP is keyless via DIRECT OIDC: the customer's Workload Identity pool trusts the Alethia issuer
		// directly (an OIDC provider), so the console/runner federate with a minted assertion — no AWS hop.
		// Available whenever the issuer is configured. (The legacy AWS-hub GCP path is retired.)
		gcp: oidcIssuerConfigured(),
		// Token clouds need no platform credentials — the customer's own API token is used.
		hetzner: true,
		digitalocean: true,
		civo: true,
		// Git providers are connectable only when their OAuth app is registered (client id + secret
		// present). Otherwise `authClient.linkSocial` rejects → the tile would toast "Failed to
		// connect". google is login-only (not a connector), so it's intentionally omitted.
		github: !!gitProviders.github,
		gitlab: !!gitProviders.gitlab,
		bitbucket: !!gitProviders.bitbucket,
	};
}

/** Whether the actor may add/edit connections (clouds + api_key connectors). */
async function resolveCanManage(): Promise<boolean> {
	try {
		const actor = await currentActor();
		const [ids, conns] = await Promise.all([
			getPdp().can(actor, "manage_identities", { type: "cloud_identity" }),
			getPdp().can(actor, "manage_connectors", { type: "connector" }),
		]);
		return ids.allowed || conns.allowed;
	} catch {
		return false;
	}
}

/**
 * Resolves the cloud connect-flow setup once, server-side: the connector catalog with live
 * connection status (git tokens auto-refreshed), and — for members who can manage connections —
 * a pending cloud identity per not-yet-connected provider so the connect sheets bind instantly.
 * Shared by the connectors board and the create-project cloud picker so both stay in lockstep.
 */
export async function getCloudConnectSetup(): Promise<CloudConnectSetup> {
	const [initialIntegrations, awsStatus, gcpStatus, azureStatus, canManage] =
		await Promise.all([
			getConnectorsWithStatus(),
			getAwsConnectionStatus(),
			getGcpConnectionStatus(),
			getAzureConnectionStatus(),
			resolveCanManage(),
		]);
	let integrations = initialIntegrations;

	// Attempt auto-refresh for expired git tokens, then re-read to reflect updated health.
	const expiredGitIntegrations = integrations.filter(
		(i) => i.category === "git" && i.token_health === "expired",
	);
	if (expiredGitIntegrations.length > 0) {
		await Promise.all(
			expiredGitIntegrations.map((i) =>
				getValidProviderToken(i.slug as PublicGitProvider).catch(() => null),
			),
		);
		integrations = await getConnectorsWithStatus();
	}

	// Pending-identity init is a manage action — only do it for members who can add connections.
	// Viewers get a read-only board (the setup is null for them).
	let awsSetup: { identityId: string } | null = null;
	let gcpSetup: { identityId: string } | null = null;
	let azureSetup: { identityId: string } | null = null;
	const extraSetup: Record<string, { identityId: string; externalId?: string }> = {};

	if (canManage) {
		if (!awsStatus.connected) {
			try {
				awsSetup = await initAwsIdentity();
			} catch {}
		}
		if (!gcpStatus.connected) {
			try {
				gcpSetup = await initGcpIdentity();
			} catch {}
		}
		if (!azureStatus.connected) {
			try {
				azureSetup = await initAzureIdentity();
			} catch {}
		}

		// Initialise pending identities for the extra clouds (so the connect sheet has an
		// identityId / Alibaba external_id to bind to). Only for clouds not yet connected.
		const EXTRA = ["alibaba", "digitalocean", "hetzner", "civo"] as const;
		await Promise.all(
			EXTRA.map(async (slug) => {
				try {
					const status = await getExtraCloudStatus(slug);
					if (status.connected) return;
					const init = await initExtraCloudIdentity(slug);
					extraSetup[slug] = {
						identityId: init.identityId,
						externalId: init.externalId,
					};
				} catch {}
			}),
		);
	}

	return {
		canManage,
		integrations,
		awsSetup,
		gcpSetup,
		azureSetup,
		extraSetup,
		platformConfigured: computePlatformConfigured(),
	};
}
