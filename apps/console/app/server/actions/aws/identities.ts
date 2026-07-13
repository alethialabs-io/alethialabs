"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { type Scope, withScope } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";

/** Resolves the active tenancy scope, or null when there is no session. */
async function activeScope(): Promise<Scope | null> {
	try {
		const actor = await currentActor();
		return { ownerId: actor.userId, orgId: actor.orgId };
	} catch {
		return null;
	}
}

export type CloudIdentityOption = {
	id: string;
	name: string;
	displayId: string;
	provider: string;
};

type IdentityRow = Pick<
	typeof cloudIdentities.$inferSelect,
	"id" | "name" | "provider" | "credentials"
>;

/** Maps a cloud identity row to a selectable option with a human display id. */
function toOption(identity: IdentityRow): CloudIdentityOption {
	const creds = identity.credentials;
	return {
		id: identity.id,
		name: identity.name,
		displayId:
			creds?.account_id ?? creds?.project_id ?? creds?.subscription_id ?? "",
		provider: identity.provider,
	};
}

const identityColumns = {
	id: cloudIdentities.id,
	name: cloudIdentities.name,
	provider: cloudIdentities.provider,
	credentials: cloudIdentities.credentials,
};

/** Fetches all verified cloud identities for the current user across all providers. */
export async function getVerifiedCloudIdentities(): Promise<
	CloudIdentityOption[]
> {
	const scope = await activeScope();
	if (!scope) return [];

	// RLS returns the member's personal identities + the org's shared ones.
	const rows = await withScope(scope, (tx) =>
		tx
			.select(identityColumns)
			.from(cloudIdentities)
			.where(eq(cloudIdentities.is_verified, true)),
	);
	return rows.map(toOption);
}

/** Fetches verified cloud identities for a specific provider. */
export async function getVerifiedCloudIdentitiesByProvider(
	provider: "aws" | "gcp" | "azure" | "alibaba",
): Promise<CloudIdentityOption[]> {
	const scope = await activeScope();
	if (!scope) return [];

	const rows = await withScope(scope, (tx) =>
		tx
			.select(identityColumns)
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.provider, provider),
					eq(cloudIdentities.is_verified, true),
				),
			),
	);
	return rows.map(toOption);
}
