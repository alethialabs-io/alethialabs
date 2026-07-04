// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	getConnectorsWithStatus,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { getValidProviderToken } from "@/app/server/actions/identities";
import {
	getAwsConnectionStatus,
	getAwsExternalId,
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
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

/** The connect-flow setup bundle shared by the connectors board and the create-project form. */
export interface CloudConnectSetup {
	canManage: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup: Record<string, { identityId: string; externalId?: string }>;
	/**
	 * Whether THIS instance has the platform credentials a provider's server-side health
	 * probe needs (keyed by connector slug). Managed clouds (aws/gcp/azure/alibaba) assume
	 * the customer's role using Alethia's platform identity — without those creds a connect
	 * can only ever fail, so the UI says "not enabled on this instance" up-front instead of
	 * a generic failure. Token clouds (hetzner/digitalocean/civo) need none → always true.
	 */
	platformConfigured: Record<string, boolean>;
}

/** Per-provider platform-credential presence — mirrors what each session/health probe reads. */
function computePlatformConfigured(): Record<string, boolean> {
	const has = (...keys: string[]) => keys.every((k) => !!process.env[k]);
	return {
		aws: has("ALETHIA_AWS_ACCESS_KEY_ID", "ALETHIA_AWS_SECRET_ACCESS_KEY"),
		azure: has(
			"ALETHIA_AZURE_TENANT_ID",
			"ALETHIA_AZURE_CLIENT_ID",
			"ALETHIA_AZURE_CLIENT_SECRET",
		),
		alibaba: has(
			"ALETHIA_ALIBABA_ACCESS_KEY_ID",
			"ALETHIA_ALIBABA_ACCESS_KEY_SECRET",
		),
		// GCP federates via Alethia's own workload-identity OIDC source (a hosted-env
		// setup, not a simple secret). Gate on an explicit marker so it reads "not enabled"
		// until that's wired.
		gcp: has("ALETHIA_GCP_WORKLOAD_IDENTITY_PROVIDER"),
		// Token clouds need no platform credentials — the customer's own API token is used.
		hetzner: true,
		digitalocean: true,
		civo: true,
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
	let awsSetup: { externalId: string; identityId: string } | null = null;
	let gcpSetup: { identityId: string } | null = null;
	let azureSetup: { identityId: string } | null = null;
	const extraSetup: Record<string, { identityId: string; externalId?: string }> = {};

	if (canManage) {
		if (!awsStatus.connected) {
			try {
				awsSetup = await getAwsExternalId();
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
