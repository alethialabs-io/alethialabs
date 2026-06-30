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

	return { canManage, integrations, awsSetup, gcpSetup, azureSetup, extraSetup };
}
