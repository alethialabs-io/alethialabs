// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS capability enumeration (epic #928, lane #933). Assumes the customer's keyless identity and reads
// what THIS account can actually launch: the regions it has enabled, and per region the offerable EC2
// instance types with a tri-state `launchable` verdict.
//
// launchable = "offered" AND "has quota". AWS exposes the two signals separately, and the quota one only
// at family-CLASS grain (per the research): `DescribeInstanceTypeOfferings` says a type is offered in a
// region; `ServiceQuotas ListServiceQuotas` gives the On-Demand vCPU limit for the type's CLASS (Standard
// covers A/C/D/H/I/M/R/T/Z; the accelerator/HPC classes each have their own quota, default 0). So we can
// say "the P class has 0 vCPU quota → P instances not launchable" but NEVER "p4d.24xlarge specifically has
// 0" — per-instance-type quota is not queryable, so that grain stays `not_evaluable` (honest, per verify).
// If a class's quota code is missing from the account's applied quotas we ALSO fail to `not_evaluable`
// (`quota_unknown`) — we never fabricate a `launchable`/`not_launchable` verdict from an absent signal.
// Availability is design-time GUIDANCE, never a hard gate (the #918 fail-open rule); best-effort, never throws.

import {
	DescribeInstanceTypeOfferingsCommand,
	DescribeInstanceTypesCommand,
	DescribeRegionsCommand,
	EC2Client,
	type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import {
	ListServiceQuotasCommand,
	ServiceQuotasClient,
} from "@aws-sdk/client-service-quotas";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { assumeAwsRole } from "../session/aws";
import { softRemoveUnseen } from "../inventory/upsert";
import type { CapabilityIdentity } from "./types";

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 200; // strict-progress bound on every paginated loop

type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken: string };

// ── EC2 On-Demand vCPU quota codes, per family CLASS ────────────────────────────────
// Service Quotas ServiceCode "ec2". Only `standard` (the bulk of general/compute/memory types) is
// treated as high-confidence; the accelerator/HPC codes are best-effort — if a code is stale or absent
// from the account's applied quotas the class degrades to `not_evaluable`, never a wrong verdict.
const QUOTA_CODE_BY_CLASS: Record<string, string> = {
	standard: "L-1216C47A", // A, C, D, H, I, M, R, T, Z
	f: "L-74FC7D96",
	g: "L-DB2E81BA", // G and VT
	inf: "L-1945791B",
	p: "L-417A185B",
	x: "L-7295265B",
	dl: "L-6E869C2A",
	trn: "L-2C3B7624",
	hpc: "L-F7808C92",
	highmem: "L-43DA4232", // u-* high-memory
};

/** Map an instance type to its On-Demand vCPU quota CLASS. Specific accelerator/HPC prefixes are checked
 * before the first-letter Standard fallback (e.g. `inf1` is Inf not Standard, `trn1` is Trn not T). */
function classForInstanceType(type: string): string {
	if (type.startsWith("inf")) return "inf";
	if (type.startsWith("trn")) return "trn";
	if (type.startsWith("hpc")) return "hpc";
	if (type.startsWith("dl")) return "dl";
	if (type.startsWith("vt") || type.startsWith("g")) return "g";
	if (type.startsWith("p")) return "p";
	if (type.startsWith("f")) return "f";
	if (type.startsWith("x")) return "x";
	if (type.startsWith("u")) return "highmem";
	return "standard"; // a, c, d, h, i, m, r, t, z, …
}

/** Derive the tri-state launch verdict for an offered type from its class's vCPU quota headroom. */
function verdictFor(
	type: string,
	quotaByCode: Map<string, number>,
): { launchable: CapabilityLaunchable; reason: CapabilityLaunchableReason } {
	const code = QUOTA_CODE_BY_CLASS[classForInstanceType(type)];
	const quota = code ? quotaByCode.get(code) : undefined;
	if (quota === undefined)
		return { launchable: "not_evaluable", reason: "quota_unknown" };
	if (quota <= 0) return { launchable: "not_launchable", reason: "quota_zero" };
	return { launchable: "launchable", reason: "available" };
}

function ec2(region: string, credentials: AwsCreds): EC2Client {
	return new EC2Client({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
}

/** The set of instance types offered in a region (paginated). */
async function offeredTypes(client: EC2Client): Promise<Set<string>> {
	const offered = new Set<string>();
	let token: string | undefined;
	for (let i = 0; i < MAX_PAGES; i++) {
		const resp = await client.send(
			new DescribeInstanceTypeOfferingsCommand({
				LocationType: "region",
				MaxResults: 1000,
				NextToken: token,
			}),
		);
		for (const o of resp.InstanceTypeOfferings ?? []) {
			if (o.InstanceType) offered.add(o.InstanceType);
		}
		token = resp.NextToken;
		if (!token) break;
	}
	return offered;
}

/** Specs (vCPU / memory / arch) for every instance type described in a region (paginated). */
async function instanceSpecs(
	client: EC2Client,
): Promise<Map<string, InstanceTypeInfo>> {
	const specs = new Map<string, InstanceTypeInfo>();
	let token: string | undefined;
	for (let i = 0; i < MAX_PAGES; i++) {
		const resp = await client.send(
			new DescribeInstanceTypesCommand({ MaxResults: 100, NextToken: token }),
		);
		for (const t of resp.InstanceTypes ?? []) {
			if (t.InstanceType) specs.set(t.InstanceType, t);
		}
		token = resp.NextToken;
		if (!token) break;
	}
	return specs;
}

/** The account's applied EC2 On-Demand vCPU quota values, keyed by quota code (paginated). */
async function ec2QuotaValues(
	region: string,
	credentials: AwsCreds,
): Promise<Map<string, number>> {
	const client = new ServiceQuotasClient({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
	const values = new Map<string, number>();
	let token: string | undefined;
	for (let i = 0; i < MAX_PAGES; i++) {
		const resp = await client.send(
			new ListServiceQuotasCommand({
				ServiceCode: "ec2",
				MaxResults: 100,
				NextToken: token,
			}),
		);
		for (const q of resp.Quotas ?? []) {
			if (q.QuotaCode && typeof q.Value === "number") values.set(q.QuotaCode, q.Value);
		}
		token = resp.NextToken;
		if (!token) break;
	}
	return values;
}

/** Enumerate this AWS account's launchable regions + instance types into the capability tables. Fills the
 * dispatcher's stub; best-effort (the dispatcher stamps freshness + swallows errors). */
export async function syncAwsCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const db = getServiceDb();
	const identityId = identity.id;
	const root = await assumeAwsRole(identity, { purpose: "capabilities" });

	// Enabled regions (DescribeRegions returns opted-in / opt-in-not-required only by default).
	const regionsResp = await ec2(root.region, root.credentials).send(
		new DescribeRegionsCommand({}),
	);
	const regions = (regionsResp.Regions ?? [])
		.map((r) => r.RegionName)
		.filter((r): r is string => Boolean(r));

	const seenRegions: string[] = [];
	for (const region of regions) {
		seenRegions.push(region);
		const now = new Date();
		await db
			.insert(cloudCapabilityRegions)
			.values({
				cloud_identity_id: identityId,
				provider: "aws",
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

	// Per region: offered types ∧ specs ∧ family-class quota → tri-state rows (batch upsert).
	const seenTypes: string[] = [];
	for (const region of regions) {
		const client = ec2(region, root.credentials);
		const [offered, specs, quotas] = await Promise.all([
			offeredTypes(client),
			instanceSpecs(client),
			ec2QuotaValues(region, root.credentials),
		]);

		const now = new Date();
		const rows = [...offered].map((type) => {
			seenTypes.push(type);
			const spec = specs.get(type);
			const memMib = spec?.MemoryInfo?.SizeInMiB;
			const { launchable, reason } = verdictFor(type, quotas);
			return {
				cloud_identity_id: identityId,
				provider: "aws" as const,
				region,
				native_id: type,
				name: type,
				vcpu: spec?.VCpuInfo?.DefaultVCpus ?? null,
				mem_gb:
					typeof memMib === "number"
						? Math.round((memMib / 1024) * 100) / 100
						: null,
				family: type.split(".")[0] || null,
				arch: spec?.ProcessorInfo?.SupportedArchitectures?.[0] ?? null,
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
	}
	await softRemoveUnseen("cloud_capability_instance_types", identityId, seenTypes);
}
