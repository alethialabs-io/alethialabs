// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner managed-SERVICE capability enumeration (Wave-2, epic #928, lane #976). Hetzner is a
// COMPUTE-only cloud: it exposes NO managed database/cache/NoSQL/Kubernetes services to federate — the
// data services a Hetzner project runs are IN-CLUSTER OSS Helm charts installed by ArgoCD (CloudNativePG
// for Postgres, Valkey for cache), and its Kubernetes is a single pinned Talos-coupled version. There is
// therefore no read-only Describe/List API to enumerate (and Hetzner auth is a project token, not the
// keyless federation the managed clouds use — see the hetzner-connector-parity ceiling).
//
// This is the DOCUMENTED-EXCLUSION lane: rather than skip the axis, it records the STATIC in-cluster
// offerings THIS platform always provisions on a Hetzner cluster — the CloudNativePG Postgres engine, the
// Valkey cache tiers, and the pinned k8s version (all launchable on every Hetzner project, identical
// across accounts) — into `cloud_capability_services`. NoSQL is genuinely not offered (an honest
// exclusion, not an absent signal), so it records NO row and the picker fails open to the static catalog
// (`available: false`). The offerings are location-independent (the charts run wherever the cluster is),
// so they are recorded once at the default location; the region-filtered cache read falls open to the
// static catalog elsewhere. Best-effort + never throws; the dispatcher stamps freshness.

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CloudCapabilityServiceInsert,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import {
	CACHE_NODE_TYPES,
	DB_ENGINES,
	DEFAULT_REGION,
	K8S_VERSIONS,
} from "@/lib/cloud-providers/generated/catalog";
import { softRemoveUnseen } from "../../inventory/upsert";
import type { CapabilityIdentity } from "../types";

/** The shared per-row context: the identity being enumerated + the (location-independent) region the
 * in-cluster offerings are recorded at. */
export interface HetznerServiceCtx {
	cloudIdentityId: string;
	region: string;
	now: Date;
}

/** Builds a `cloud_capability_services` insert row for a Hetzner in-cluster offering. Every recorded
 * offering is `launchable`/`available` — the platform always provisions these charts on a Hetzner
 * cluster (there is no per-account variation to gate on). */
function serviceRow(
	ctx: HetznerServiceCtx,
	fields: Pick<
		CloudCapabilityServiceInsert,
		"service_kind" | "native_id" | "name" | "engine" | "version" | "tier" | "mem_gb"
	>,
): CloudCapabilityServiceInsert {
	return {
		cloud_identity_id: ctx.cloudIdentityId,
		provider: "hetzner",
		region: ctx.region,
		launchable: "launchable",
		launchable_reason: "available",
		last_seen: ctx.now,
		last_synced_at: ctx.now,
		removed_at: null,
		...fields,
	};
}

/** The STATIC in-cluster service offerings a Hetzner project can launch: the CloudNativePG Postgres
 * engine (at its chart version), the Valkey cache tiers, and the pinned Talos-coupled k8s version.
 * Sourced from the Catalog #2 Hetzner slices (the single source of truth). NoSQL is intentionally
 * absent — Hetzner offers none (the honest documented exclusion). Pure — unit-tested directly. */
export function normalizeHetznerServiceRows(
	ctx: HetznerServiceCtx,
): CloudCapabilityServiceInsert[] {
	const rows: CloudCapabilityServiceInsert[] = [];

	// database: CloudNativePG (in-cluster Postgres) at its chart's default version.
	for (const e of DB_ENGINES.hetzner) {
		rows.push(
			serviceRow(ctx, {
				service_kind: "database",
				native_id: e.value,
				name: e.label,
				engine: e.value,
				version: e.defaultVersion,
				tier: null,
				mem_gb: null,
			}),
		);
	}

	// cache: the in-cluster Valkey tiers.
	for (const t of CACHE_NODE_TYPES.hetzner) {
		rows.push(
			serviceRow(ctx, {
				service_kind: "cache",
				native_id: t.value,
				name: t.label,
				engine: null,
				version: null,
				tier: t.value,
				mem_gb: t.memoryGb,
			}),
		);
	}

	// kubernetes: the single pinned Talos-coupled version.
	for (const version of K8S_VERSIONS.hetzner) {
		rows.push(
			serviceRow(ctx, {
				service_kind: "kubernetes",
				native_id: version,
				name: version,
				engine: null,
				version,
				tier: null,
				mem_gb: null,
			}),
		);
	}

	// nosql: intentionally none — Hetzner offers no managed NoSQL (documented exclusion, not an absent
	// signal). The picker fails open to the static catalog, which reports `available: false`.
	return rows;
}

/** Records this Hetzner project's launchable in-cluster services into `cloud_capability_services`. Fills
 * the dispatcher's Hetzner stub; best-effort (the dispatcher stamps freshness + swallows errors). Because
 * the offerings are static, the reconcile always runs over the full set. */
export async function syncHetznerServiceCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const db = getServiceDb();
	const identityId = identity.id;
	const ctx: HetznerServiceCtx = {
		cloudIdentityId: identityId,
		region: DEFAULT_REGION.hetzner,
		now: new Date(),
	};

	const rows = normalizeHetznerServiceRows(ctx);
	if (rows.length > 0) {
		await db
			.insert(cloudCapabilityServices)
			.values(rows)
			.onConflictDoUpdate({
				target: [
					cloudCapabilityServices.cloud_identity_id,
					cloudCapabilityServices.provider,
					cloudCapabilityServices.region,
					cloudCapabilityServices.service_kind,
					cloudCapabilityServices.native_id,
				],
				set: {
					name: sql`excluded.name`,
					engine: sql`excluded.engine`,
					version: sql`excluded.version`,
					tier: sql`excluded.tier`,
					mem_gb: sql`excluded.mem_gb`,
					launchable: sql`excluded.launchable`,
					launchable_reason: sql`excluded.launchable_reason`,
					last_seen: sql`excluded.last_seen`,
					last_synced_at: sql`excluded.last_synced_at`,
					removed_at: sql`excluded.removed_at`,
				},
			});
	}
	// The offerings are static, so this always reconciles the full set (retires any row no longer in the
	// catalog — e.g. a Valkey tier dropped from the platform templates).
	await softRemoveUnseen(
		"cloud_capability_services",
		identityId,
		rows.map((r) => r.native_id),
	);
}
