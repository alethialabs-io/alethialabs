"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
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

/** Gets or creates a pending GCP identity (manage-gated, not activity-logged). */
export async function initGcpIdentity() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	return conn.initIdentity(actor, "gcp");
}
