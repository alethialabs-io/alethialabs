"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";

export type AzureConnectionStatus = {
	connected: boolean;
	tenantId?: string;
	subscriptionId?: string;
	clientId?: string;
	identityId?: string;
	name?: string;
};

/** Returns the verified Azure connection status (the org's first connected account). */
export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "azure");
}

/** Lists every connected Azure account for the org (multi-account). */
export async function listAzureIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "azure");
}

/**
 * Gets or creates a pending Azure identity (manage-gated, not activity-logged). Azure is keyless +
 * customer-side now: the customer's setup script creates a managed identity and returns its client id,
 * which the connect form collects — there is no platform Entra app id to thread through.
 */
export async function initAzureIdentity(): Promise<{
	identityId: string;
}> {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	const { identityId } = await conn.initIdentity(actor, "azure");
	return { identityId };
}

/** Validates the Azure GUIDs, persists them, and queues a connection test. */
export async function saveAzureIdentity(
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveAzureIdentity(
		actor,
		identityId,
		tenantId,
		clientId,
		subscriptionId,
	);
}

/** Resets the Azure identity to its pending state. */
export async function disconnectAzureIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "azure");
}
