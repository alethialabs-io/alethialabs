"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";

export type GcpConnectionStatus = {
	connected: boolean;
	projectId?: string;
	serviceAccountEmail?: string;
	identityId?: string;
	name?: string;
};

/** Returns the verified GCP connection status (the org's first connected account). */
export async function getGcpConnectionStatus(): Promise<GcpConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "gcp");
}

/** Lists every connected GCP account for the org (multi-account). */
export async function listGcpIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "gcp");
}

/** Gets or creates a pending GCP identity (manage-gated, not activity-logged). */
export async function initGcpIdentity() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	return conn.initIdentity(actor, "gcp");
}

/** Validates a WIF config JSON, persists it, and verifies the connection server-side. */
export async function saveGcpIdentity(identityId: string, wifConfigJson: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveGcpIdentity(actor, identityId, wifConfigJson);
}

/** Resets the GCP identity to its pending state. */
export async function disconnectGcpIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "gcp");
}
