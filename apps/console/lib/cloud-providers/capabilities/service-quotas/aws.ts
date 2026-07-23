// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS service-quota headroom enumeration (Wave-2 quota axis, epic #928, #981). Assumes the customer's
// keyless role (session/aws) and reads, per region, the networking quota CEILINGS a provision plan can
// exhaust — Elastic IPs, NAT gateways, VPC security groups, and the three load-balancer families — via
// Service Quotas `ListServiceQuotas`. That API reports the effective LIMIT (`Value`) but NOT current
// usage (used is a CloudWatch `AWS/Usage` pointer, not a number), so `used`/`available` are stored NULL
// (honest not_evaluable, never a fabricated zero). Best-effort: never throws; a failing region/service is
// skipped. Availability is design-time GUIDANCE (#918 fail-open), surfaced as advisory on the network node.

import {
	ListServiceQuotasCommand,
	ServiceQuotasClient,
} from "@aws-sdk/client-service-quotas";
import { DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityQuotaKind,
	cloudCapabilityQuotas,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { assumeAwsRole } from "../../session/aws";
import type { CapabilityIdentity } from "../types";

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

// The networking quota codes we reconcile, grouped by the Service Quotas ServiceCode that owns them.
// (Elastic IPs live under `ec2`, not `vpc`, despite rendering on the VPC quota page.)
interface AwsQuotaSpec {
	serviceCode: string;
	quotaCode: string;
	kind: CapabilityQuotaKind;
}
const AWS_QUOTA_SPECS: AwsQuotaSpec[] = [
	{ serviceCode: "ec2", quotaCode: "L-0263D0A3", kind: "elastic_ip" }, // Elastic IP addresses per Region
	{ serviceCode: "vpc", quotaCode: "L-FE5A380F", kind: "nat_gateway" }, // NAT gateways per Availability Zone
	{ serviceCode: "vpc", quotaCode: "L-E79EC296", kind: "security_group" }, // VPC security groups per Region
	{ serviceCode: "elasticloadbalancing", quotaCode: "L-53DA6B97", kind: "load_balancer" }, // Application LBs per Region
	{ serviceCode: "elasticloadbalancing", quotaCode: "L-69A177A2", kind: "load_balancer" }, // Network LBs per Region
	{ serviceCode: "elasticloadbalancing", quotaCode: "L-E9E9831D", kind: "load_balancer" }, // Classic LBs per Region
];
const AWS_SERVICE_CODES = ["ec2", "vpc", "elasticloadbalancing"];

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

/** The `Value`+`QuotaName` a `ListServiceQuotas` page reports per quota code (what we keep). */
export interface AwsQuotaValue {
	name: string | null;
	value: number | null;
}

/** Picks our networking quota codes out of a region's collected Service-Quotas map into headroom rows.
 * `used`/`available` are always NULL for AWS (Service Quotas exposes the limit only). Pure — no IO. */
export function normalizeAwsQuotas(
	region: string,
	byCode: Map<string, AwsQuotaValue>,
): NormalizedQuota[] {
	const out: NormalizedQuota[] = [];
	for (const spec of AWS_QUOTA_SPECS) {
		const q = byCode.get(spec.quotaCode);
		if (!q) continue;
		out.push({
			region,
			quota_kind: spec.kind,
			native_id: spec.quotaCode,
			name: q.name ?? spec.quotaCode,
			quota_limit: q.value,
			used: null,
			available: null,
		});
	}
	return out;
}

/** Enumerates this account's networking service-quota ceilings per region into `cloud_capability_quotas`.
 * Best-effort — never throws; each region/service call is isolated. */
export async function syncAwsQuotaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	let session: Awaited<ReturnType<typeof assumeAwsRole>>;
	try {
		session = await assumeAwsRole(identity, { purpose: "capabilities" });
	} catch {
		return;
	}
	const { credentials, region: sessionRegion } = session;

	const db = getServiceDb();
	const identityId = identity.id;

	// Enabled regions (default DescribeRegions — opt-in regions excluded).
	let regionNames: string[] = [];
	try {
		const ec2 = new EC2Client({
			region: sessionRegion,
			credentials,
			requestHandler: { requestTimeout: TIMEOUT_MS },
			maxAttempts: 2,
		});
		const resp = await ec2.send(new DescribeRegionsCommand({}));
		regionNames = (resp.Regions ?? [])
			.map((r) => r.RegionName)
			.filter((n): n is string => Boolean(n));
	} catch {
		return;
	}
	if (regionNames.length === 0) return;

	const now = new Date();
	const seen: string[] = [];

	for (const region of regionNames) {
		const byCode = new Map<string, AwsQuotaValue>();
		const sq = new ServiceQuotasClient({
			region,
			credentials,
			requestHandler: { requestTimeout: TIMEOUT_MS },
			maxAttempts: 2,
		});
		for (const serviceCode of AWS_SERVICE_CODES) {
			try {
				let nextToken: string | undefined;
				for (let page = 0; page < MAX_PAGES; page++) {
					const resp = await sq.send(
						new ListServiceQuotasCommand({
							ServiceCode: serviceCode,
							MaxResults: 100,
							NextToken: nextToken,
						}),
					);
					for (const q of resp.Quotas ?? []) {
						if (q.QuotaCode) {
							byCode.set(q.QuotaCode, {
								name: q.QuotaName ?? null,
								value: typeof q.Value === "number" ? q.Value : null,
							});
						}
					}
					nextToken = resp.NextToken;
					if (!nextToken) break;
				}
			} catch {
				// One service's quotas unreadable in this region — skip it, keep the rest.
			}
		}

		const rows = normalizeAwsQuotas(region, byCode);
		if (rows.length === 0) continue;

		const insertRows = rows.map((r) => {
			seen.push(r.native_id);
			return {
				cloud_identity_id: identityId,
				provider: "aws" as const,
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
