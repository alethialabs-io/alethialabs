"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize } from "@/lib/authz/guard";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	resourceHierarchy,
	type Spec,
	specEnvironments,
	specs,
	type Zone,
	zones,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { pickFreeSlug, slugify } from "@/lib/routing";

// M1: the environment identity (name) + provisioning status moved off specs into
// spec_environments. These derived fields surface the spec's DEFAULT environment so
// single-value UI (zone list, sidebar, dashboard) reads `spec.environment_stage` /
// `spec.status` unchanged. `default_environment_id` lets actions target that env.
export type SpecWithProvider = Spec & {
	cloud_provider: string | null;
	environment_stage: string;
	status: string;
	default_environment_id: string | null;
};

export type ZoneWithSpecs = Zone & {
	specs: SpecWithProvider[];
};

export type GetZonesData = ZoneWithSpecs[];

/** Fetches all zones with nested specs and each spec's cloud provider. */
export async function getZones() {
	const actor = await authorize("view", { type: "zone" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const zoneRows = await tx
			.select()
			.from(zones)
			.orderBy(desc(zones.created_at));

		const specRows = await tx
			.select({
				spec: specs,
				cloud_provider: cloudIdentities.provider,
				env_id: specEnvironments.id,
				env_name: specEnvironments.name,
				env_status: specEnvironments.status,
			})
			.from(specs)
			.leftJoin(
				cloudIdentities,
				eq(specs.cloud_identity_id, cloudIdentities.id),
			)
			.leftJoin(
				specEnvironments,
				and(
					eq(specEnvironments.spec_id, specs.id),
					eq(specEnvironments.is_default, true),
				),
			);

		const byZone = new Map<string, SpecWithProvider[]>();
		for (const r of specRows) {
			const spec: SpecWithProvider = {
				...r.spec,
				cloud_provider: r.cloud_provider ?? null,
				environment_stage: r.env_name ?? "development",
				status: r.env_status ?? "DRAFT",
				default_environment_id: r.env_id ?? null,
			};
			const key = r.spec.zone_id ?? "";
			const arr = byZone.get(key) ?? [];
			arr.push(spec);
			byZone.set(key, arr);
		}

		const zoneList: GetZonesData = zoneRows.map((z) => ({
			...z,
			specs: byZone.get(z.id) ?? [],
		}));

		return { zones: zoneList };
	});
}

/** Fetches a single zone with nested specs and their cloud provider. */
export async function getZoneById(id: string) {
	const actor = await authorize("view", { type: "zone", id });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [zone] = await tx
			.select()
			.from(zones)
			.where(eq(zones.id, id))
			.limit(1);

		if (!zone) throw new Error("Zone not found");

		const specRows = await tx
			.select({
				spec: specs,
				cloud_provider: cloudIdentities.provider,
				env_id: specEnvironments.id,
				env_name: specEnvironments.name,
				env_status: specEnvironments.status,
			})
			.from(specs)
			.leftJoin(
				cloudIdentities,
				eq(specs.cloud_identity_id, cloudIdentities.id),
			)
			.leftJoin(
				specEnvironments,
				and(
					eq(specEnvironments.spec_id, specs.id),
					eq(specEnvironments.is_default, true),
				),
			)
			.where(eq(specs.zone_id, id));

		const specList: SpecWithProvider[] = specRows.map((r) => ({
			...r.spec,
			cloud_provider: r.cloud_provider ?? null,
			environment_stage: r.env_name ?? "development",
			status: r.env_status ?? "DRAFT",
			default_environment_id: r.env_id ?? null,
		}));

		return { zone: { ...zone, specs: specList } };
	});
}

export async function createZone(
	body: Omit<typeof zones.$inferInsert, "user_id">,
) {
	const actor = await authorize("create", { type: "zone" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		// C2: derive a unique-per-org URL slug from the name.
		const existing = await tx
			.select({ slug: zones.slug })
			.from(zones)
			.where(eq(zones.org_id, body.org_id ?? owner));
		const slug = pickFreeSlug(
			slugify(body.name) || "zone",
			existing.map((r) => r.slug),
		);
		const [zone] = await tx
			.insert(zones)
			.values({ ...body, slug, user_id: owner })
			.returning();
		// Authz hierarchy edge: zone → org (community org_id == owner). Lets an
		// org/zone-scoped grant flow down to this zone's specs.
		await tx
			.insert(resourceHierarchy)
			.values({
				child_type: "zone",
				child_id: zone.id,
				parent_type: "org",
				parent_id: owner,
			})
			.onConflictDoNothing();
		mirrorHierarchyEdge("zone", zone.id, "org", owner);
		return { zone };
	});
}

export async function updateZone(
	id: string,
	body: Partial<typeof zones.$inferInsert>,
) {
	const actor = await authorize("edit", { type: "zone", id });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [zone] = await tx
			.update(zones)
			.set(body)
			.where(eq(zones.id, id))
			.returning();
		return { zone };
	});
}

export async function deleteZone(id: string) {
	const actor = await authorize("destroy", { type: "zone", id });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		await tx.delete(zones).where(eq(zones.id, id));
		return { success: true };
	});
}
