"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	type Spec,
	specs,
	type Zone,
	zones,
} from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export type VineWithProvider = Spec & {
	cloud_provider: string | null;
};

export type VineyardWithVines = Zone & {
	vines: VineWithProvider[];
};

export type GetVineyardsData = VineyardWithVines[];

/** Fetches all zones with nested specs and each spec's cloud provider. */
export async function getVineyards() {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const zoneRows = await tx
			.select()
			.from(zones)
			.orderBy(desc(zones.created_at));

		const specRows = await tx
			.select({ spec: specs, cloud_provider: cloudIdentities.provider })
			.from(specs)
			.leftJoin(
				cloudIdentities,
				eq(specs.cloud_identity_id, cloudIdentities.id),
			);

		const byZone = new Map<string, VineWithProvider[]>();
		for (const r of specRows) {
			const vine: VineWithProvider = {
				...r.spec,
				cloud_provider: r.cloud_provider ?? null,
			};
			const key = r.spec.zone_id ?? "";
			const arr = byZone.get(key) ?? [];
			arr.push(vine);
			byZone.set(key, arr);
		}

		const vineyards: GetVineyardsData = zoneRows.map((z) => ({
			...z,
			vines: byZone.get(z.id) ?? [],
		}));

		return { vineyards };
	});
}

/** Fetches a single zone with nested specs and their cloud provider. */
export async function getVineyardById(id: string) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [zone] = await tx
			.select()
			.from(zones)
			.where(eq(zones.id, id))
			.limit(1);

		if (!zone) throw new Error("Zone not found");

		const specRows = await tx
			.select({ spec: specs, cloud_provider: cloudIdentities.provider })
			.from(specs)
			.leftJoin(
				cloudIdentities,
				eq(specs.cloud_identity_id, cloudIdentities.id),
			)
			.where(eq(specs.zone_id, id));

		const vines: VineWithProvider[] = specRows.map((r) => ({
			...r.spec,
			cloud_provider: r.cloud_provider ?? null,
		}));

		return { vineyard: { ...zone, vines } };
	});
}

export async function createVineyard(
	body: Omit<typeof zones.$inferInsert, "user_id">,
) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [zone] = await tx
			.insert(zones)
			.values({ ...body, user_id: owner })
			.returning();
		return { vineyard: zone };
	});
}

export async function updateVineyard(
	id: string,
	body: Partial<typeof zones.$inferInsert>,
) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [zone] = await tx
			.update(zones)
			.set(body)
			.where(eq(zones.id, id))
			.returning();
		return { vineyard: zone };
	});
}

export async function deleteVineyard(id: string) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		await tx.delete(zones).where(eq(zones.id, id));
		return { success: true };
	});
}
