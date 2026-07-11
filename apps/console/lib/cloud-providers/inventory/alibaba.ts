// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba inventory sync — server-side enumeration of the resources the product reasons about, upserted
// into the typed cloud_* tables (mirrors inventory/aws.ts). v1 covers regions, VPCs, and VSwitches (what the
// canvas needs for "use an existing network"). Auth is KEYLESS: the temporary STS credentials come from the
// same AssumeRoleWithOIDC the connection uses (session/alibaba.ts) — no AccessKey is stored.

import VpcClient, {
	DescribeRegionsRequest,
	DescribeVpcsRequest,
	DescribeVSwitchesRequest,
} from "@alicloud/vpc20160428";
import * as $OpenApi from "@alicloud/openapi-client";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	cloudNetworks,
	cloudRegions,
	cloudSubnets,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { type AlibabaCredentials, assumeAlibabaRole } from "../session/alibaba";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const PAGE_SIZE = 50;
/** The region used to enumerate all regions (any always-on region works). */
const BOOTSTRAP_REGION = "cn-hangzhou";

/** Builds a VPC client for one region from the temporary STS credentials. */
function vpcClient(creds: AlibabaCredentials, region: string): VpcClient {
	return new VpcClient(
		new $OpenApi.Config({
			accessKeyId: creds.accessKeyId,
			accessKeySecret: creds.accessKeySecret,
			securityToken: creds.securityToken,
			endpoint: `vpc.${region}.aliyuncs.com`,
		}),
	);
}

/** Syncs one Alibaba identity's regions + networks + subnets. Returns the regions covered. */
export async function syncAlibabaInventory(
	identity: Pick<CloudIdentity, "id" | "credentials">,
): Promise<{ regions: string[] }> {
	const db = getServiceDb();
	const identityId = identity.id;

	const session = await assumeAlibabaRole(identity, { purpose: "inventory" });
	if (!session.credentials) {
		throw new Error("Alibaba inventory: assume returned no credentials.");
	}
	const creds = session.credentials;

	// Enumerate regions from a bootstrap endpoint.
	const bootstrap = new VpcClient(
		new $OpenApi.Config({
			accessKeyId: creds.accessKeyId,
			accessKeySecret: creds.accessKeySecret,
			securityToken: creds.securityToken,
			endpoint: `vpc.${BOOTSTRAP_REGION}.aliyuncs.com`,
		}),
	);
	const regionsResp = await bootstrap.describeRegions(new DescribeRegionsRequest({}));
	const regionNames = (regionsResp.body?.regions?.region ?? [])
		.map((r) => r.regionId)
		.filter((r): r is string => Boolean(r));

	// Regions inventory.
	const seenRegions: string[] = [];
	for (const region of regionNames) {
		seenRegions.push(region);
		const now = new Date();
		await db
			.insert(cloudRegions)
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
				target: [cloudRegions.cloud_identity_id, cloudRegions.provider, cloudRegions.native_id],
				set: { last_seen: now, last_synced_at: now, removed_at: null },
			});
	}
	await softRemoveUnseen("cloud_regions", identityId, seenRegions);

	const seenVpcs: string[] = [];
	const seenSubnets: string[] = [];
	const vpcRowId = new Map<string, string>();

	for (const region of regionNames) {
		// A region the role can't reach (not activated / no perms) must not fail the whole sync.
		let client: VpcClient;
		try {
			client = vpcClient(creds, region);
		} catch {
			continue;
		}

		try {
			for (let page = 1; ; page++) {
				const resp = await client.describeVpcs(
					new DescribeVpcsRequest({ regionId: region, pageNumber: page, pageSize: PAGE_SIZE }),
				);
				const vpcs = resp.body?.vpcs?.vpc ?? [];
				for (const vpc of vpcs) {
					if (!vpc.vpcId) continue;
					seenVpcs.push(vpc.vpcId);
					const sensitive = sealSensitive({ cidr_block: vpc.cidrBlock ?? undefined });
					const now = new Date();
					const [row] = await db
						.insert(cloudNetworks)
						.values({
							cloud_identity_id: identityId,
							provider: "alibaba",
							region,
							native_id: vpc.vpcId,
							name: vpc.vpcName || null,
							sensitive,
							is_default: vpc.isDefault ?? false,
							last_seen: now,
							last_synced_at: now,
							removed_at: null,
						})
						.onConflictDoUpdate({
							target: [
								cloudNetworks.cloud_identity_id,
								cloudNetworks.provider,
								cloudNetworks.native_id,
							],
							set: {
								region,
								name: vpc.vpcName || null,
								sensitive,
								is_default: vpc.isDefault ?? false,
								last_seen: now,
								last_synced_at: now,
								removed_at: null,
							},
						})
						.returning({ id: cloudNetworks.id });
					if (row) vpcRowId.set(vpc.vpcId, row.id);
				}
				if (vpcs.length < PAGE_SIZE) break;
			}

			for (let page = 1; ; page++) {
				const resp = await client.describeVSwitches(
					new DescribeVSwitchesRequest({ regionId: region, pageNumber: page, pageSize: PAGE_SIZE }),
				);
				const vswitches = resp.body?.vSwitches?.vSwitch ?? [];
				for (const sw of vswitches) {
					if (!sw.vSwitchId) continue;
					seenSubnets.push(sw.vSwitchId);
					const sensitive = sealSensitive({ cidr_block: sw.cidrBlock ?? undefined });
					const now = new Date();
					await db
						.insert(cloudSubnets)
						.values({
							cloud_identity_id: identityId,
							provider: "alibaba",
							region,
							native_id: sw.vSwitchId,
							name: sw.vSwitchName || null,
							sensitive,
							network_id: sw.vpcId ? (vpcRowId.get(sw.vpcId) ?? null) : null,
							availability_zone: sw.zoneId ?? null,
							// Alibaba VSwitches have no "auto-assign public IP" flag; public access is via EIP/NAT.
							is_public: false,
							last_seen: now,
							last_synced_at: now,
							removed_at: null,
						})
						.onConflictDoUpdate({
							target: [
								cloudSubnets.cloud_identity_id,
								cloudSubnets.provider,
								cloudSubnets.native_id,
							],
							set: {
								region,
								name: sw.vSwitchName || null,
								sensitive,
								network_id: sw.vpcId ? (vpcRowId.get(sw.vpcId) ?? null) : null,
								availability_zone: sw.zoneId ?? null,
								is_public: false,
								last_seen: now,
								last_synced_at: now,
								removed_at: null,
							},
						});
				}
				if (vswitches.length < PAGE_SIZE) break;
			}
		} catch {
			// Skip a region we can't fully enumerate; other regions still sync.
			continue;
		}
	}

	await softRemoveUnseen("cloud_networks", identityId, seenVpcs);
	await softRemoveUnseen("cloud_subnets", identityId, seenSubnets);

	await db
		.update(cloudNetworks)
		.set({ last_synced_at: new Date() })
		.where(eq(cloudNetworks.cloud_identity_id, identityId));

	return { regions: regionNames };
}
