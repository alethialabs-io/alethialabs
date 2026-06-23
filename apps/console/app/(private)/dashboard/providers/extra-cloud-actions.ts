"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { getOwner, requireOwner } from "@/lib/auth/owner";
import * as conn from "@/lib/cloud-providers/connections";

/**
 * Server actions for the clouds added after AWS/GCP/Azure: Alibaba (RAM role) and
 * the token clouds DigitalOcean / Hetzner / Civo. Thin wrappers over connections.ts,
 * mirroring the per-cloud action files.
 */

type ExtraCloud = "alibaba" | "digitalocean" | "hetzner" | "civo";

/** Verified connection status for one of the extra clouds. */
export async function getExtraCloudStatus(
	provider: ExtraCloud,
): Promise<conn.ConnectionStatus> {
	const userId = await getOwner();
	if (!userId) return { connected: false };
	return conn.getStatus(userId, provider);
}

/** Gets or creates the user's pending identity (Alibaba also gets a stable external_id). */
export async function initExtraCloudIdentity(provider: ExtraCloud) {
	const userId = await requireOwner();
	return conn.initIdentity(userId, provider);
}

/** Persists a DigitalOcean/Hetzner/Civo scoped API token and queues a connection test. */
export async function saveTokenCloud(
	identityId: string,
	provider: "digitalocean" | "hetzner" | "civo",
	apiToken: string,
) {
	const userId = await requireOwner();
	return conn.saveTokenCloudIdentity(userId, identityId, provider, apiToken);
}

/**
 * Connects a token cloud in self-managed mode — Alethia stores NO token; the
 * customer's self-hosted runner supplies it from its own env. The connection test is
 * pinned to a self-hosted runner.
 */
export async function saveSelfManagedTokenCloud(
	identityId: string,
	provider: "digitalocean" | "hetzner" | "civo",
) {
	const userId = await requireOwner();
	return conn.saveSelfManagedTokenIdentity(userId, identityId, provider);
}

/** Persists an Alibaba RAM-role ARN and queues a connection test. */
export async function saveAlibaba(identityId: string, roleArn: string) {
	const userId = await requireOwner();
	return conn.saveAlibabaIdentity(userId, identityId, roleArn);
}

/** Marks an extra-cloud identity verified using the connection-test result. */
export async function verifyExtraCloudIdentity(
	identityId: string,
	jobId?: string,
) {
	const userId = await requireOwner();
	const result = await conn.verifyIdentity(userId, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets an extra-cloud identity to its pending state. */
export async function disconnectExtraCloud(
	identityId: string,
	provider: ExtraCloud,
) {
	const userId = await requireOwner();
	return conn.disconnectIdentity(userId, identityId, provider);
}
