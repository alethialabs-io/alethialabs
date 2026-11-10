"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeQuiet, currentActor } from "@/lib/authz/guard";
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
