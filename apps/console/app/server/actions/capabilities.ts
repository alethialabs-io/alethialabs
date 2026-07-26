"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one client-reachable entry point to the per-tenant capabilities catalog.
//
// `lib/queries/capabilities.ts` is `server-only`, so the canvas cannot call it directly. This action
// runs every reader in ONE round trip and normalizes the results into the `CapabilityBag` the
// inspector's field engine consumes — mirroring how `getCloudIdentityInventory` already feeds the
// runner dialog, and how `repository-context.tsx` shares one fetch across N mounted selects.
//
// SECURITY — the provider is DERIVED, never taken from the caller. Every reader filters on
// `provider`, so a mismatched value returns zero rows and then FAILS OPEN to the static catalog of
// whatever cloud was named — i.e. a caller could make an AWS project's picker render GCP machine
// types. Not a tenancy leak (the readers self-authorize under withActorScope), but a real
// correctness hazard, and the kind that looks like a product bug rather than an attack.

import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
	getCacheTierCapabilities,
	getDatabaseCapabilities,
	getInstanceTypeCapabilities,
	getK8sVersionCapabilities,
	getNosqlCapability,
	getRegionCapabilities,
} from "@/lib/queries/capabilities";
import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import type {
	CapabilityAxis,
	CapabilityBag,
} from "@/components/design-project/canvas/inspector/config-schema";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/** Rows=0 with a stamp this fresh is read as "still enumerating" rather than "nothing to report". */
const SYNCING_WINDOW_MS = 5 * 60_000;

/** The clouds with a provisioning-option catalog. Cast-free narrowing: returns the matching literal
 * (already the union type) so a wider `cloud_provider` value degrades to null instead of lying. */
function asCatalogued(p: string): CloudProviderSlug | null {
	const catalogued: CloudProviderSlug[] = ["aws", "gcp", "azure", "hetzner", "alibaba"];
	return catalogued.find((c) => c === p) ?? null;
}

/**
 * Everything the canvas pickers need for one cloud identity, in one round trip.
 *
 * `region` scopes the axes that are genuinely per-region. Pass null and those axes are SKIPPED and
 * reported as `catalog`: reading them region-less returns the union across regions, which yields a
 * false "launchable" for a type that is only launchable somewhere else — worse than no signal. It
 * also bounds the payload (AWS enumerates ~700 instance types).
 */
export async function getIdentityCapabilities(
	cloudIdentityId: string,
	region?: string | null,
): Promise<CapabilityBag> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});

	// Derive the provider (and the sync stamp) from the identity itself, under withActorScope so
	// Postgres RLS is the tenancy wall. `cloud_identities` carries the `owner_all` policy, so there
	// is no reason to reach for the RLS-bypassing service role here and re-implement the boundary as
	// a hand-written org predicate — a predicate is only as good as the column it names, and RLS is
	// the wall that is actually tested.
	const [identity] = await withActorScope(actor, (tx) =>
		tx
			.select({
				provider: cloudIdentities.provider,
				syncedAt: cloudIdentities.capabilities_synced_at,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloudIdentityId))
			.limit(1),
	);

	if (!identity) return emptyBag();

	// `cloud_provider` is wider than the catalogued set: digitalocean/civo have no capability lane
	// and no static option catalog, so there is nothing to resolve for them. Narrow explicitly and
	// return the empty bag — every picker then shows exactly what it shows today.
	const provider = asCatalogued(identity.provider);
	if (!provider) return emptyBag();
	const scoped = region ?? null;

	const [regions, instanceTypes, k8sVersions, database, cacheTiers, nosql, inventory] =
		await Promise.all([
			getRegionCapabilities(cloudIdentityId, provider),
			scoped ? getInstanceTypeCapabilities(cloudIdentityId, provider, scoped) : [],
			getK8sVersionCapabilities(cloudIdentityId, provider),
			getDatabaseCapabilities(cloudIdentityId, provider),
			scoped ? getCacheTierCapabilities(cloudIdentityId, provider, scoped) : [],
			getNosqlCapability(cloudIdentityId, provider),
			getCloudIdentityInventory(cloudIdentityId).catch(() => ({
				networks: [],
				subnets: [],
				regions: [],
			})),
		]);

	// `launchable === undefined` marks a static fallback row, so it doubles as the provenance signal
	// for every axis except regions (whose reader reports its own source).
	const sourceOf = (rows: { launchable?: string }[]): "account" | "catalog" =>
		rows.some((r) => r.launchable !== undefined) ? "account" : "catalog";

	const axisSource: Record<CapabilityAxis, "account" | "catalog"> = {
		region: regions.source,
		instance_type: scoped ? sourceOf(instanceTypes) : "catalog",
		k8s_version: sourceOf(k8sVersions),
		database: sourceOf(database.engines),
		cache_tier: scoped ? sourceOf(cacheTiers) : "catalog",
		nosql: nosql.launchable !== undefined ? "account" : "catalog",
		placement: inventory.networks.length > 0 ? "account" : "catalog",
	};

	// `state` describes the CAPABILITY sync (it is derived from capabilities_synced_at), so placement
	// is deliberately excluded: inventory is populated by a different sweeper, and an account with
	// synced VPCs but no capability rows would otherwise report "ready" while it is still enumerating.
	const CAPABILITY_AXES: CapabilityAxis[] = [
		"region",
		"instance_type",
		"k8s_version",
		"database",
		"cache_tier",
		"nosql",
	];
	const anyAccount = CAPABILITY_AXES.some((axis) => axisSource[axis] === "account");

	return {
		identityId: cloudIdentityId,
		provider,
		region: scoped,
		state: syncState(anyAccount, identity.syncedAt),
		axisSource,
		regions: regions.codes,
		instanceTypes: instanceTypes.map((r) => ({
			value: r.value,
			label:
				r.vcpu != null && r.memoryGb != null
					? `${r.label} · ${r.vcpu} vCPU / ${r.memoryGb} GB`
					: r.label,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		k8sVersions: k8sVersions.map((r) => ({
			value: r.version,
			label: r.version,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		dbEngines: database.engines.map((r) => ({
			value: r.value,
			label: r.version ? `${r.label} ${r.version}` : r.label,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		cacheTiers: cacheTiers.map((r) => ({
			value: r.value,
			label:
				r.memoryGb != null
					? `${r.label} · ${r.memoryGb} GB${r.cost ? ` (${r.cost})` : ""}`
					: r.label,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		// The key-type SHAPE is static provider metadata, not an enumerated axis — the account verdict
		// applies to the service as a whole, so it rides on every key type.
		nosqlKeyTypes: nosql.available
			? nosql.config.keyTypes.map((k) => ({
					value: k.value,
					label: k.label,
					launchable: nosql.launchable,
					launchableReason: nosql.launchableReason ?? null,
				}))
			: [],
		networks: inventory.networks.map((n) => ({
			nativeId: n.native_id,
			name: n.name,
			region: n.region,
			cidrBlock: n.cidr_block,
			isDefault: Boolean(n.is_default),
		})),
		subnets: inventory.subnets.map((s) => ({
			nativeId: s.native_id,
			name: s.name,
			region: s.region,
			cidrBlock: s.cidr_block,
			isDefault: false,
			availabilityZone: s.availability_zone,
			isPublic: Boolean(s.is_public),
			// The subnet's parent is stored as the cloud_networks ROW id; the picker matches on the
			// native id, so resolve it against the networks we just read.
			networkRowId:
				inventory.networks.find((n) => n.id === s.network_id)?.native_id ?? null,
		})),
	};
}

/**
 * Honest sync state. `claimDueCapability` stamps `capabilities_synced_at` BEFORE enumerating, so
 * "rows=0 with a recent stamp" is genuinely ambiguous between in-flight and produced-nothing. The
 * window is an approximation, not a fact — a real `capabilities_sync_status` column would settle it,
 * but that needs the board-mutex'd migration and this must not block on one.
 */
function syncState(
	anyAccountRows: boolean,
	syncedAt: Date | null,
): CapabilityBag["state"] {
	if (anyAccountRows) return "ready";
	if (syncedAt === null) return "syncing";
	return Date.now() - syncedAt.getTime() < SYNCING_WINDOW_MS ? "syncing" : "ready";
}

function emptyBag(): CapabilityBag {
	const catalog: Record<CapabilityAxis, "account" | "catalog"> = {
		region: "catalog",
		instance_type: "catalog",
		k8s_version: "catalog",
		database: "catalog",
		cache_tier: "catalog",
		nosql: "catalog",
		placement: "catalog",
	};
	return {
		identityId: null,
		provider: null,
		region: null,
		state: "idle",
		axisSource: catalog,
		regions: [],
		instanceTypes: [],
		k8sVersions: [],
		dbEngines: [],
		cacheTiers: [],
		nosqlKeyTypes: [],
		networks: [],
		subnets: [],
	};
}
