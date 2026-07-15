"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";

export type AwsConnectionStatus = {
	connected: boolean;
	accountId?: string;
	roleArn?: string;
	identityId?: string;
	externalId?: string;
	name?: string;
};

/** Returns the verified AWS connection status (the org's first connected account). */
export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "aws");
}

/** Lists every connected AWS account for the org (multi-account). */
export async function listAwsIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "aws");
}

/**
 * Gets or creates a pending AWS identity and returns its id (manage-gated, not activity-logged — this only
 * seeds the connect sheet). AWS is now keyless via DIRECT OIDC: the customer's role trusts the Alethia
 * issuer, so no ExternalId is needed — only a pending identity to bind the role ARN to.
 */
export async function initAwsIdentity() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	const { identityId } = await conn.initIdentity(actor, "aws");
	return { identityId };
}

/**
 * Re-verifies a saved cloud identity (any provider) server-side without re-entering
 * credentials — used by the "Re-verify" affordance on a degraded/disconnected connector.
 */
export async function reverifyCloudIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.reverifyConnection(actor, identityId);
	// The connectors page is the dynamic `/[org]/~/connectors` route — revalidating the literal
	// "/dashboard/connectors" matched nothing and was a silent no-op, leaving the client's
	// router.refresh() to do all the work. Revalidating a dynamic route needs its pattern + "page".
	revalidatePath("/[org]/~/connectors", "page");
	return result;
}

/** Validates a Role ARN, persists it, and verifies the connection server-side (manage-gated). */
export async function saveAwsIdentity(identityId: string, roleArn: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveAwsIdentity(actor, identityId, roleArn);
}

/** Resets the AWS identity to its pending state (manage-gated). */
export async function disconnectAwsIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "aws");
}

/** Renames a cloud account (any provider; manage-gated). */
export async function renameCloudIdentity(identityId: string, name: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.renameIdentity(actor, identityId, name);
	// The connectors page is the dynamic `/[org]/~/connectors` route — revalidating the literal
	// "/dashboard/connectors" matched nothing and was a silent no-op, leaving the client's
	// router.refresh() to do all the work. Revalidating a dynamic route needs its pattern + "page".
	revalidatePath("/[org]/~/connectors", "page");
	return result;
}
