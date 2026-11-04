"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";

/**
 * Server actions for the clouds added after AWS/GCP/Azure: Alibaba (RAM role) and
 * the token clouds DigitalOcean / Hetzner / Civo. Thin wrappers over connections.ts,
 * mirroring the per-cloud action files. Connections are org-scoped and gated by the
 * `manage_identities` permission.
 */

type ExtraCloud = "alibaba" | "digitalocean" | "hetzner" | "civo";

/** Verified connection status for one of the extra clouds (first connected account). */
export async function getExtraCloudStatus(
	provider: ExtraCloud,
): Promise<conn.ConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, provider);
}

/**
 * Gets or creates a pending identity (Alibaba also gets a stable external_id).
 * Manage-gated but not activity-logged — this only seeds the connect sheet.
 */
export async function initExtraCloudIdentity(provider: ExtraCloud) {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	return conn.initIdentity(actor, provider);
}
