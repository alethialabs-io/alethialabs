"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNull } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { openSensitive } from "@/lib/cloud-providers/inventory/upsert";
import {
	cloudIdentities,
	cloudNetworks,
	cloudRegions,
	cloudSubnets,
} from "@/lib/db/schema";

/**
 * A cloud identity's LIVE asset inventory (networks + subnets + regions) from the normalized cloud_*
 * tables — the canvas's "use an existing VPC instead of creating one" source and the elench agent's
 * real-state read. Replaces the retired `cached_resources` JSONB reader + the runner FETCH_RESOURCES
 * job (inventory is now kept fresh server-side by the reconciliation sweep + event ingester).
 * PDP-gated; soft-removed rows excluded; never returns credentials.
 */
export async function getCloudIdentityInventory(cloudIdentityId: string) {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	return withActorScope(actor, async (tx) => {
		// Defence in depth: every inventory row for an identity is that identity's provider by
		// construction, so this predicate should never change a result — which is exactly why it is
		// worth having. A mis-scoped sweeper write would otherwise surface another cloud's networks in
		// this account's picker, and the standing rule is that provider is always in the predicate.
		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloudIdentityId))
			.limit(1);
		if (!identity) return { networks: [], subnets: [], regions: [] };

		const networks = await tx
			.select()
			.from(cloudNetworks)
			.where(
				and(
					eq(cloudNetworks.cloud_identity_id, cloudIdentityId),
					eq(cloudNetworks.provider, identity.provider),
					isNull(cloudNetworks.removed_at),
				),
			)
			.orderBy(cloudNetworks.region);
		const subnets = await tx
			.select()
			.from(cloudSubnets)
			.where(
				and(
					eq(cloudSubnets.cloud_identity_id, cloudIdentityId),
					eq(cloudSubnets.provider, identity.provider),
					isNull(cloudSubnets.removed_at),
				),
			);
		const regions = await tx
			.select({ name: cloudRegions.native_id })
			.from(cloudRegions)
			.where(
				and(
					eq(cloudRegions.cloud_identity_id, cloudIdentityId),
					eq(cloudRegions.provider, identity.provider),
					isNull(cloudRegions.removed_at),
				),
			)
			.orderBy(cloudRegions.native_id);
		// Decrypt the sealed sensitive attrs (CIDRs) back onto each row and strip the ciphertext — the
		// consumer sees `cidr_block`, never the `sensitive` blob.
		return {
			networks: networks.map(({ sensitive, ...n }) => ({
				...n,
				cidr_block: openSensitive(sensitive).cidr_block ?? null,
			})),
			subnets: subnets.map(({ sensitive, ...s }) => ({
				...s,
				cidr_block: openSensitive(sensitive).cidr_block ?? null,
			})),
			regions: regions.map((r) => r.name),
		};
	});
}
