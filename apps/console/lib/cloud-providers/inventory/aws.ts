// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS inventory sync — server-side enumeration of the resources the product reasons about, upserted
// into the typed cloud_* tables (replaces the runner's FETCH_RESOURCES for AWS). v1 covers regions,
// VPCs, and subnets (what the canvas needs for "use an existing network"); more kinds layer on the same
// pattern. Runs on connect + the reconciliation sweep + (later) the event ingester.

import {
	DescribeRegionsCommand,
	DescribeSubnetsCommand,
	DescribeVpcsCommand,
	EC2Client,
	type Subnet,
	type Vpc,
} from "@aws-sdk/client-ec2";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	cloudNetworks,
	cloudRegions,
	cloudSubnets,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assumeAwsRole } from "../session/aws";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 15_000;

/** The conventional `Name` tag → the row's name. We intentionally store NO other tags (they routinely
 * carry owner emails / cost centers / secrets), so only `Name` is projected. */
function nameFromTags(tags?: { Key?: string; Value?: string }[]): string | null {
	for (const t of tags ?? []) if (t.Key === "Name") return t.Value ?? null;
	return null;
}

/** Syncs one AWS identity's regions + networks + subnets. Returns the regions covered. */
export async function syncAwsInventory(
	identity: Pick<CloudIdentity, "id" | "credentials">,
): Promise<{ regions: string[] }> {
	const db = getServiceDb();
	const identityId = identity.id;

	// Assume the role once (in the default region) to enumerate regions.
	const root = await assumeAwsRole(identity, { purpose: "inventory" });
	const ec2Root = new EC2Client({
		region: root.region,
		credentials: root.credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});

	const regionsResp = await ec2Root.send(new DescribeRegionsCommand({}));
	const regionNames = (regionsResp.Regions ?? [])
		.map((r) => r.RegionName)
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
					cloudRegions.cloud_identity_id,
					cloudRegions.provider,
					cloudRegions.native_id,
				],
				set: { last_seen: now, last_synced_at: now, removed_at: null },
			});
	}
	await softRemoveUnseen("cloud_regions", identityId, seenRegions);

	// Networks + subnets per region (sequential, bounded — keeps it simple; the sweep is time-sliced).
	const seenVpcs: string[] = [];
	const seenSubnets: string[] = [];
	// Map a VPC native id → its inventory row id so subnets can FK to it.
	const vpcRowId = new Map<string, string>();

	for (const region of regionNames) {
		const ec2 = new EC2Client({
			region,
			credentials: root.credentials,
			requestHandler: { requestTimeout: TIMEOUT_MS },
			maxAttempts: 2,
		});

		const vpcs: Vpc[] = (await ec2.send(new DescribeVpcsCommand({}))).Vpcs ?? [];
		for (const vpc of vpcs) {
			if (!vpc.VpcId) continue;
			seenVpcs.push(vpc.VpcId);
			const name = nameFromTags(vpc.Tags);
			const sensitive = sealSensitive({ cidr_block: vpc.CidrBlock ?? undefined });
			const now = new Date();
			const [row] = await db
				.insert(cloudNetworks)
				.values({
					cloud_identity_id: identityId,
					provider: "aws",
					region,
					native_id: vpc.VpcId,
					name,
					sensitive,
					is_default: vpc.IsDefault ?? false,
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
						name,
						sensitive,
						is_default: vpc.IsDefault ?? false,
						last_seen: now,
						last_synced_at: now,
						removed_at: null,
					},
				})
				.returning({ id: cloudNetworks.id });
			if (row) vpcRowId.set(vpc.VpcId, row.id);
		}

		const subnets: Subnet[] =
			(await ec2.send(new DescribeSubnetsCommand({}))).Subnets ?? [];
		for (const sn of subnets) {
			if (!sn.SubnetId) continue;
			seenSubnets.push(sn.SubnetId);
			const name = nameFromTags(sn.Tags);
			const sensitive = sealSensitive({ cidr_block: sn.CidrBlock ?? undefined });
			const now = new Date();
			await db
				.insert(cloudSubnets)
				.values({
					cloud_identity_id: identityId,
					provider: "aws",
					region,
					native_id: sn.SubnetId,
					name,
					sensitive,
					network_id: sn.VpcId ? (vpcRowId.get(sn.VpcId) ?? null) : null,
					availability_zone: sn.AvailabilityZone ?? null,
					is_public: sn.MapPublicIpOnLaunch ?? false,
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
						name,
						sensitive,
						network_id: sn.VpcId ? (vpcRowId.get(sn.VpcId) ?? null) : null,
						availability_zone: sn.AvailabilityZone ?? null,
						is_public: sn.MapPublicIpOnLaunch ?? false,
						last_seen: now,
						last_synced_at: now,
						removed_at: null,
					},
				});
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
