// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/cloud-identities/:id/inventory — the discovered networking (networks + subnets) and
// regions for a connected cloud identity. Gated on cloud_identity `view`; org-scoped by loading the
// identity by (id, org_id) first (the tenancy wall — the inventory tables key only on
// cloud_identity_id). Mirrors getCloudIdentityInventory (web). The sealed CIDRs are opened and the
// ciphertext stripped, exactly as the web read does.

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { openSensitive } from "@/lib/cloud-providers/inventory/upsert";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	cloudNetworks,
	cloudRegions,
	cloudSubnets,
} from "@/lib/db/schema";
import { cliCloudInventoryResponse } from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const auth = await authorizeCli(req, "view", { type: "cloud_identity", id });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		// Tenancy wall: the identity must belong to the caller's org before we read its inventory
		// (the inventory tables key only on cloud_identity_id, not org).
		const [identity] = await db
			.select({ id: cloudIdentities.id })
			.from(cloudIdentities)
			.where(and(eq(cloudIdentities.id, id), eq(cloudIdentities.org_id, actor.orgId)))
			.limit(1);
		if (!identity) {
			return NextResponse.json(
				{ error: "Cloud identity not found" },
				{ status: 404 },
			);
		}

		const [networks, subnets, regions] = await Promise.all([
			db
				.select()
				.from(cloudNetworks)
				.where(and(eq(cloudNetworks.cloud_identity_id, id), isNull(cloudNetworks.removed_at)))
				.orderBy(cloudNetworks.region),
			db
				.select()
				.from(cloudSubnets)
				.where(and(eq(cloudSubnets.cloud_identity_id, id), isNull(cloudSubnets.removed_at))),
			db
				.select({ name: cloudRegions.native_id })
				.from(cloudRegions)
				.where(and(eq(cloudRegions.cloud_identity_id, id), isNull(cloudRegions.removed_at)))
				.orderBy(cloudRegions.native_id),
		]);

		return cliJson(cliCloudInventoryResponse, {
			networks: networks.map((n) => ({
				native_id: n.native_id,
				name: n.name,
				region: n.region,
				provider: n.provider,
				cidr_block: openSensitive(n.sensitive).cidr_block ?? null,
				is_default: n.is_default ?? false,
			})),
			subnets: subnets.map((s) => ({
				native_id: s.native_id,
				name: s.name,
				region: s.region,
				availability_zone: s.availability_zone,
				cidr_block: openSensitive(s.sensitive).cidr_block ?? null,
				is_public: s.is_public ?? false,
			})),
			regions: regions.map((r) => r.name),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
