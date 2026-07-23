// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba Cloud service-quota headroom enumeration (Wave-2 quota axis, epic #928, #981). Assumes the
// customer's RAM role via AssumeRoleWithOIDC (keyless, session/alibaba) and reads, per region, the
// security-group ceiling from ECS `DescribeAccountAttributes` (attribute `max-security-groups`). The API
// reports the limit only (no usage), so `used`/`available` are stored NULL. Best-effort: never throws; a
// failing region is skipped.
//
// DOCUMENTED per-cloud parity gap (cloud parity is a hard rule — explicit, not silent): EIP, NAT-gateway,
// and SLB/load-balancer headroom on Alibaba are only read-obtainable via the Quota Center product
// (`@alicloud/quotas`, ProductCodes eip/nat/slb). That SDK client is NOT installed in the console, so
// wiring those three is deferred to a follow-up that adds the dependency (a package.json change, out of
// this lane's file scope). Today Alibaba covers `security_group` only.

import EcsClient, {
	DescribeAccountAttributesRequest,
	DescribeRegionsRequest,
} from "@alicloud/ecs20140526";
import * as $OpenApi from "@alicloud/openapi-client";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityQuotaKind,
	cloudCapabilityQuotas,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { type AlibabaCredentials, assumeAlibabaRole } from "../../session/alibaba";
import type { CapabilityIdentity } from "../types";

const BOOTSTRAP_REGION = "cn-hangzhou";
// The ECS DescribeAccountAttributes attribute carrying the per-region security-group ceiling.
const SG_ATTRIBUTE = "max-security-groups";

/** A quota row before identity/timestamps are attached — the pure normalizer output (testable). */
export interface NormalizedQuota {
	region: string;
	quota_kind: CapabilityQuotaKind;
	native_id: string;
	name: string;
	quota_limit: number | null;
	used: number | null;
	available: number | null;
}

/** A flattened DescribeAccountAttributes item ({ name, values }) — the shape the normalizer consumes,
 * decoupled from the SDK's deeply-nested response classes. */
export interface AccountAttribute {
	attributeName: string | null;
	values: string[];
}

/** Maps the flattened DescribeAccountAttributes items to a `security_group` headroom row for `region`.
 * Alibaba reports the ceiling only (no usage), so used/available are NULL. Pure — no IO. */
export function normalizeAlibabaSecurityGroups(
	region: string,
	attributes: AccountAttribute[],
): NormalizedQuota[] {
	const sg = attributes.find((a) => a.attributeName === SG_ATTRIBUTE);
	if (!sg) return [];
	const raw = sg.values[0];
	const parsed = raw !== undefined ? Number(raw) : NaN;
	const limit = Number.isFinite(parsed) ? parsed : null;
	return [
		{
			region,
			quota_kind: "security_group",
			native_id: SG_ATTRIBUTE,
			name: "Security groups per region",
			quota_limit: limit,
			used: null,
			available: null,
		},
	];
}

/** Builds a region-scoped ECS OpenAPI client from the assumed STS credentials. */
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

/** Flattens the SDK's nested DescribeAccountAttributes response into {attributeName, values}. */
function flattenAttributes(
	items:
		| { attributeName?: string; attributeValues?: { valueItem?: { value?: string }[] } }[]
		| undefined,
): AccountAttribute[] {
	return (items ?? []).map((item) => ({
		attributeName: item.attributeName ?? null,
		values: (item.attributeValues?.valueItem ?? [])
			.map((v) => v.value)
			.filter((v): v is string => v !== undefined),
	}));
}

/** Enumerates this account's per-region security-group ceiling into `cloud_capability_quotas`.
 * Best-effort — never throws; each region call is isolated. */
export async function syncAlibabaQuotaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	let session: Awaited<ReturnType<typeof assumeAlibabaRole>>;
	try {
		session = await assumeAlibabaRole(identity, { purpose: "capabilities" });
	} catch {
		return;
	}
	if (!session.credentials) return;
	const creds = session.credentials;

	const db = getServiceDb();
	const identityId = identity.id;

	// Enumerate regions off a bootstrap-region client.
	let regionIds: string[] = [];
	try {
		const bootstrap = ecsClient(creds, BOOTSTRAP_REGION);
		const resp = await bootstrap.describeRegions(new DescribeRegionsRequest({}));
		regionIds = (resp.body?.regions?.region ?? [])
			.map((r) => r.regionId)
			.filter((n): n is string => Boolean(n));
	} catch {
		return;
	}
	if (regionIds.length === 0) return;

	const now = new Date();
	const seen: string[] = [];

	for (const region of regionIds) {
		let attributes: AccountAttribute[] = [];
		try {
			const client = ecsClient(creds, region);
			const resp = await client.describeAccountAttributes(
				new DescribeAccountAttributesRequest({
					regionId: region,
					attributeName: [SG_ATTRIBUTE],
				}),
			);
			attributes = flattenAttributes(
				resp.body?.accountAttributeItems?.accountAttributeItem,
			);
		} catch {
			continue;
		}

		const rows = normalizeAlibabaSecurityGroups(region, attributes);
		if (rows.length === 0) continue;

		const insertRows = rows.map((r) => {
			seen.push(r.native_id);
			return {
				cloud_identity_id: identityId,
				provider: "alibaba" as const,
				region: r.region,
				native_id: r.native_id,
				name: r.name,
				quota_kind: r.quota_kind,
				quota_limit: r.quota_limit,
				used: r.used,
				available: r.available,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			};
		});

		await db
			.insert(cloudCapabilityQuotas)
			.values(insertRows)
			.onConflictDoUpdate({
				target: [
					cloudCapabilityQuotas.cloud_identity_id,
					cloudCapabilityQuotas.provider,
					cloudCapabilityQuotas.region,
					cloudCapabilityQuotas.quota_kind,
					cloudCapabilityQuotas.native_id,
				],
				set: {
					name: sql`excluded.name`,
					quota_limit: sql`excluded.quota_limit`,
					used: sql`excluded.used`,
					available: sql`excluded.available`,
					last_seen: sql`excluded.last_seen`,
					last_synced_at: sql`excluded.last_synced_at`,
					removed_at: sql`excluded.removed_at`,
				},
			});
	}

	await softRemoveUnseen("cloud_capability_quotas", identityId, seen);
}
