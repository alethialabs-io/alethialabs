// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba Cloud service-quota headroom enumeration (Wave-2 quota axis, epic #928, #981, #1229). Assumes
// the customer's RAM role via AssumeRoleWithOIDC (keyless, session/alibaba) and reads, per region, the
// networking quota ceilings a provision plan can exhaust:
//   • security_group — ECS `DescribeAccountAttributes` (attribute `max-security-groups`): limit only, so
//     used/available are NULL (honest not_evaluable).
//   • elastic_ip / nat_gateway / load_balancer — Quota Center `ListProductQuotas` (ProductCodes eip / vpc /
//     slb, region as a dimension). Quota Center reports BOTH the ceiling (`TotalQuota`) and usage
//     (`TotalUsage`), so these carry real used/available headroom (#1229 closes the #981 gap; cloud parity).
// Best-effort: never throws; a failing region/product is skipped. Availability is design-time GUIDANCE
// (#918 fail-open), surfaced as advisory on the network node.

import EcsClient, {
	DescribeAccountAttributesRequest,
	DescribeRegionsRequest,
} from "@alicloud/ecs20140526";
import * as $OpenApi from "@alicloud/openapi-client";
import QuotasClient, {
	ListProductQuotasRequest,
} from "@alicloud/quotas20200510";
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
// The Quota Center endpoint is central (region is passed as a `regionId` dimension, not the endpoint host).
const QUOTA_CENTER_ENDPOINT = "quotas.aliyuncs.com";

// The networking quotas we reconcile via Quota Center, grouped by ProductCode. Quota Center action codes
// vary (and are only knowable against the live product), so each kind carries an ALLOW-LIST of candidate
// `quotaActionCode`s — the first that matches wins, and an unmatched kind simply yields no row (honest
// not_evaluable / fail-open, never a fabricated value). One spec per kind (a single count quota each).
interface AlibabaQuotaCenterSpec {
	productCode: string;
	kind: CapabilityQuotaKind;
	actionCodes: string[];
	name: string;
}
const QUOTA_CENTER_SPECS: AlibabaQuotaCenterSpec[] = [
	{
		productCode: "eip",
		kind: "elastic_ip",
		actionCodes: ["eip_whitelist/eip_number", "eip_number", "q_eip_number"],
		name: "Elastic IP addresses per region",
	},
	{
		productCode: "vpc",
		kind: "nat_gateway",
		actionCodes: ["vpc_quota_ngw_num", "vpc_quota_ngw_number", "vpc_quota_enhanced_ngw"],
		name: "NAT gateways per region",
	},
	{
		productCode: "slb",
		kind: "load_balancer",
		actionCodes: ["slb_quota_instances_num", "slb_quota_instance_num", "slb_quota_clb_number"],
		name: "Load balancer instances per region",
	},
];
/** Distinct ProductCodes to query per region (one ListProductQuotas call each). */
const QUOTA_CENTER_PRODUCTS = [
	...new Set(QUOTA_CENTER_SPECS.map((s) => s.productCode)),
];

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

/** A flattened Quota Center quota ({productCode, action code, name, limit, usage}) — the shape the
 * normalizer consumes, decoupled from the SDK's response classes (the recorded-fixture contract). */
export interface QuotaCenterItem {
	productCode: string | null;
	quotaActionCode: string | null;
	quotaName: string | null;
	totalQuota: number | null;
	totalUsage: number | null;
}

/** Maps a region's Quota Center quotas to elastic_ip / nat_gateway / load_balancer headroom rows. Each kind
 * takes the first quota whose (productCode, quotaActionCode) matches its spec allow-list; `available` is
 * `limit − used` when Quota Center reports both (it usually does), else NULL. Pure — no IO. */
export function normalizeAlibabaQuotaCenter(
	region: string,
	items: QuotaCenterItem[],
): NormalizedQuota[] {
	const out: NormalizedQuota[] = [];
	for (const spec of QUOTA_CENTER_SPECS) {
		const match = items.find(
			(i) =>
				i.productCode === spec.productCode &&
				typeof i.quotaActionCode === "string" &&
				spec.actionCodes.includes(i.quotaActionCode),
		);
		if (!match) continue;
		const limit =
			typeof match.totalQuota === "number" && Number.isFinite(match.totalQuota)
				? match.totalQuota
				: null;
		const used =
			typeof match.totalUsage === "number" && Number.isFinite(match.totalUsage)
				? match.totalUsage
				: null;
		const available = limit !== null && used !== null ? limit - used : null;
		out.push({
			region,
			quota_kind: spec.kind,
			native_id: match.quotaActionCode ?? spec.actionCodes[0],
			name: match.quotaName ?? spec.name,
			quota_limit: limit,
			used,
			available,
		});
	}
	return out;
}

/** Flattens a ListProductQuotas response's `quotas` into {productCode, quotaActionCode, …}. */
function flattenQuotaCenter(
	quotas:
		| {
				productCode?: string;
				quotaActionCode?: string;
				quotaName?: string;
				totalQuota?: number;
				totalUsage?: number;
		  }[]
		| undefined,
): QuotaCenterItem[] {
	return (quotas ?? []).map((q) => ({
		productCode: q.productCode ?? null,
		quotaActionCode: q.quotaActionCode ?? null,
		quotaName: q.quotaName ?? null,
		totalQuota: typeof q.totalQuota === "number" ? q.totalQuota : null,
		totalUsage: typeof q.totalUsage === "number" ? q.totalUsage : null,
	}));
}

/** Builds the central Quota Center OpenAPI client from the assumed STS credentials. */
function quotasClient(creds: AlibabaCredentials): QuotasClient {
	return new QuotasClient(
		new $OpenApi.Config({
			accessKeyId: creds.accessKeyId,
			accessKeySecret: creds.accessKeySecret,
			securityToken: creds.securityToken,
			endpoint: QUOTA_CENTER_ENDPOINT,
		}),
	);
}

/** Collects the flattened Quota Center quotas for a region across all networking ProductCodes. A single
 * product's failure is isolated so the others still contribute. */
async function collectQuotaCenter(
	client: QuotasClient,
	region: string,
): Promise<QuotaCenterItem[]> {
	const items: QuotaCenterItem[] = [];
	for (const productCode of QUOTA_CENTER_PRODUCTS) {
		try {
			const resp = await client.listProductQuotas(
				new ListProductQuotasRequest({
					productCode,
					dimensions: [{ key: "regionId", value: region }],
					maxResults: 100,
				}),
			);
			items.push(...flattenQuotaCenter(resp.body?.quotas));
		} catch {
			// Best-effort — a single product's Quota Center call may 403/throttle; skip it.
		}
	}
	return items;
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
	const quotas = quotasClient(creds);

	for (const region of regionIds) {
		// security_group ceiling via ECS DescribeAccountAttributes (limit only).
		let sgRows: NormalizedQuota[] = [];
		try {
			const client = ecsClient(creds, region);
			const resp = await client.describeAccountAttributes(
				new DescribeAccountAttributesRequest({
					regionId: region,
					attributeName: [SG_ATTRIBUTE],
				}),
			);
			sgRows = normalizeAlibabaSecurityGroups(
				region,
				flattenAttributes(resp.body?.accountAttributeItems?.accountAttributeItem),
			);
		} catch {
			// ECS unreachable in this region — the Quota Center pass below can still contribute.
		}

		// elastic_ip / nat_gateway / load_balancer headroom via Quota Center (limit + usage).
		const quotaCenterRows = normalizeAlibabaQuotaCenter(
			region,
			await collectQuotaCenter(quotas, region),
		);

		const rows = [...sgRows, ...quotaCenterRows];
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
