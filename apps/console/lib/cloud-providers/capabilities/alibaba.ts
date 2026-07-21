// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba capability enumeration (epic #928, lane #936). Auth is KEYLESS: temporary STS credentials from
// AssumeRoleWithOIDC (session/alibaba.ts). Reads what THIS account can launch: its regions and, per region,
// the offerable ECS instance types with a tri-state `launchable` verdict.
//
// launchable = "offered" AND "has quota". `DescribeAvailableResource` gives per-region stock status
// (Available / SoldOut); `DescribeAccountAttributes` gives the account's region-wide postpaid vCPU max —
// obtainable, so Alibaba quota is populated (NOT not_evaluable). We AND them: max vCPU 0 ⇒ quota_zero for
// the whole region; else Available ⇒ launchable, SoldOut ⇒ not_launchable/sold_out. The vCPU max is
// region-wide (coarser than a per-family limit), which is the honest obtainable grain. Availability is
// design-time GUIDANCE, never a hard gate; best-effort, never throws.

import EcsClient, {
	DescribeAccountAttributesRequest,
	DescribeAvailableResourceRequest,
	DescribeInstanceTypesRequest,
	DescribeRegionsRequest,
} from "@alicloud/ecs20140526";
import * as $OpenApi from "@alicloud/openapi-client";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { type AlibabaCredentials, assumeAlibabaRole } from "../session/alibaba";
import { softRemoveUnseen } from "../inventory/upsert";
import {
	existingNativeIds,
	hashSource,
	recordRegionHashes,
	regionDue,
} from "./sync-state";
import type { CapabilityIdentity } from "./types";

const BOOTSTRAP_REGION = "cn-hangzhou";

interface TypeSpec {
	vcpu: number | null;
	memGb: number | null;
	family: string | null;
	arch: string | null;
}

function ecsClient(creds: AlibabaCredentials, region: string): EcsClient {
	return new EcsClient(
		new $OpenApi.Config({
			accessKeyId: creds.accessKeyId,
			accessKeySecret: creds.accessKeySecret,
			securityToken: creds.securityToken,
			endpoint: `ecs.${region}.aliyuncs.com`,
		}),
	);
}

/** Global instance-type specs (id → vcpu/mem/family/arch). */
async function instanceSpecs(
	client: EcsClient,
): Promise<Map<string, TypeSpec>> {
	const out = new Map<string, TypeSpec>();
	const resp = await client.describeInstanceTypes(
		new DescribeInstanceTypesRequest({}),
	);
	for (const t of resp.body?.instanceTypes?.instanceType ?? []) {
		if (!t.instanceTypeId) continue;
		out.set(t.instanceTypeId, {
			vcpu: t.cpuCoreCount ?? null,
			memGb: typeof t.memorySize === "number" ? t.memorySize : null,
			family: t.instanceTypeFamily ?? null,
			arch: t.cpuArchitecture ?? null,
		});
	}
	return out;
}

/** Per-region offered instance types + their stock status (Available if available in any zone). */
async function offeredStatus(
	client: EcsClient,
	region: string,
): Promise<Map<string, string>> {
	const status = new Map<string, string>();
	const resp = await client.describeAvailableResource(
		new DescribeAvailableResourceRequest({
			regionId: region,
			destinationResource: "InstanceType",
			ioOptimized: "optimized",
		}),
	);
	for (const zone of resp.body?.availableZones?.availableZone ?? []) {
		for (const ar of zone.availableResources?.availableResource ?? []) {
			for (const sr of ar.supportedResources?.supportedResource ?? []) {
				if (!sr.value) continue;
				// Prefer an Available in any zone over a SoldOut in another.
				if (status.get(sr.value) === "Available") continue;
				status.set(sr.value, sr.status ?? "Unknown");
			}
		}
	}
	return status;
}

/** The account's region-wide postpaid vCPU max (undefined if not returned). */
async function regionVcpuMax(
	client: EcsClient,
	region: string,
): Promise<number | undefined> {
	const resp = await client.describeAccountAttributes(
		new DescribeAccountAttributesRequest({
			regionId: region,
			attributeName: ["max-postpaid-instance-vcpu-count"],
		}),
	);
	for (const item of resp.body?.accountAttributeItems?.accountAttributeItem ??
		[]) {
		if (item.attributeName !== "max-postpaid-instance-vcpu-count") continue;
		const raw = item.attributeValues?.valueItem?.[0]?.value;
		const n = raw === undefined ? NaN : Number(raw);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function verdictFor(
	status: string,
	vcpuMax: number | undefined,
): { launchable: CapabilityLaunchable; reason: CapabilityLaunchableReason } {
	if (vcpuMax !== undefined && vcpuMax <= 0)
		return { launchable: "not_launchable", reason: "quota_zero" };
	if (status === "Available")
		return { launchable: "launchable", reason: "available" };
	return { launchable: "not_launchable", reason: "sold_out" };
}

/** Enumerate this Alibaba account's launchable regions + instance types into the capability tables. */
export async function syncAlibabaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const session = await assumeAlibabaRole(identity, { purpose: "capabilities" });
	if (!session.credentials) return;
	const creds = session.credentials;
	const db = getServiceDb();
	const identityId = identity.id;

	const bootstrap = ecsClient(creds, BOOTSTRAP_REGION);
	const regionsResp = await bootstrap.describeRegions(
		new DescribeRegionsRequest({}),
	);
	const regions = (regionsResp.body?.regions?.region ?? [])
		.map((r) => r.regionId)
		.filter((r): r is string => Boolean(r));

	// Global instance-type specs (one call).
	const specs = await instanceSpecs(bootstrap);

	const seenRegions: string[] = [];
	for (const region of regions) {
		seenRegions.push(region);
		const now = new Date();
		await db
			.insert(cloudCapabilityRegions)
			.values({
				cloud_identity_id: identityId,
				provider: "alibaba",
				region,
				native_id: region,
				name: region,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			})
			.onConflictDoUpdate({
				target: [
					cloudCapabilityRegions.cloud_identity_id,
					cloudCapabilityRegions.provider,
					cloudCapabilityRegions.native_id,
				],
				set: { last_seen: now, last_synced_at: now, removed_at: null },
			});
	}
	await softRemoveUnseen("cloud_capability_regions", identityId, seenRegions);

	const seenTypes: string[] = [];
	for (const region of regions) {
		// A region the role can't reach (not activated / no perms) must not fail the whole sync.
		let status: Map<string, string>;
		let vcpuMax: number | undefined;
		try {
			const client = ecsClient(creds, region);
			[status, vcpuMax] = await Promise.all([
				offeredStatus(client, region),
				regionVcpuMax(client, region),
			]);
		} catch {
			continue;
		}

		// The per-region stock status + region-wide vCPU quota are the change-detection input; they gate
		// the batch upsert (the specs are one global call already fetched above).
		const instanceHash = hashSource(status);
		const quotaHash = hashSource(vcpuMax ?? null);
		if (
			!(await regionDue({
				cloudIdentityId: identityId,
				provider: "alibaba",
				region,
				instanceHash,
				quotaHash,
			}))
		) {
			seenTypes.push(...(await existingNativeIds(identityId, region)));
			continue;
		}

		const now = new Date();
		const rows = [...status].map(([type, st]) => {
			seenTypes.push(type);
			const spec = specs.get(type);
			const { launchable, reason } = verdictFor(st, vcpuMax);
			return {
				cloud_identity_id: identityId,
				provider: "alibaba" as const,
				region,
				native_id: type,
				name: type,
				vcpu: spec?.vcpu ?? null,
				mem_gb: spec?.memGb ?? null,
				family: spec?.family ?? null,
				arch: spec?.arch ?? null,
				launchable,
				launchable_reason: reason,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			};
		});

		if (rows.length > 0) {
			await db
				.insert(cloudCapabilityInstanceTypes)
				.values(rows)
				.onConflictDoUpdate({
					target: [
						cloudCapabilityInstanceTypes.cloud_identity_id,
						cloudCapabilityInstanceTypes.provider,
						cloudCapabilityInstanceTypes.region,
						cloudCapabilityInstanceTypes.native_id,
					],
					set: {
						name: sql`excluded.name`,
						vcpu: sql`excluded.vcpu`,
						mem_gb: sql`excluded.mem_gb`,
						family: sql`excluded.family`,
						arch: sql`excluded.arch`,
						launchable: sql`excluded.launchable`,
						launchable_reason: sql`excluded.launchable_reason`,
						last_seen: sql`excluded.last_seen`,
						last_synced_at: sql`excluded.last_synced_at`,
						removed_at: sql`excluded.removed_at`,
					},
				});
		}
		await recordRegionHashes({
			cloudIdentityId: identityId,
			provider: "alibaba",
			region,
			instanceHash,
			quotaHash,
		});
	}
	await softRemoveUnseen("cloud_capability_instance_types", identityId, seenTypes);
}
