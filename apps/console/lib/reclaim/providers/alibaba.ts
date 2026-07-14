// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba orphan-reclaim adapter.
//
// Every list here goes out with a SERVER-SIDE tag filter (`Tag.1.Key` / `Tag.1.Value` on the RPC
// describes, the `tags` query on ACK's ROA `ListTagResources`). The customer's Alibaba account holds
// their own production infrastructure — an unfiltered account listing that we then narrow client-side is
// one bad predicate away from enumerating it, so it is forbidden and never happens below.
//
// Auth is KEYLESS: the temporary STS credentials come from the same `AssumeRoleWithOIDC` the connection
// and the inventory sync use (session/alibaba.ts). No AccessKey is ever stored or introduced here.
//
// API choice: per-service `DescribeXxx` calls, NOT the cross-product Tag API (`tag.aliyuncs.com`
// `ListResourcesByTags`). The Tag API returns resource ARNs and tags and nothing else — no creation
// time. Since the created-after guard REFUSES any resource with a null `created_at`, an adapter built on
// it would list everything and be able to delete nothing. The per-service describes carry a genuine
// server-side tag filter AND return `CreationTime`, so they satisfy both halves of the contract.
//
// The adapter lists and deletes. It decides nothing — see lib/reclaim/guards.ts.

import { and, eq } from "drizzle-orm";
import OpenApiClient, * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import { getServiceDb } from "@/lib/db";
import { type CloudIdentity, cloudIdentities } from "@/lib/db/schema";
import {
	type AlibabaCredentials,
	assumeAlibabaRole,
} from "@/lib/cloud-providers/session/alibaba";
import type { CloudResourceRef, LabelSelector, ReclaimAdapter } from "../types";

const PAGE_SIZE = 50;
/** The region used to enumerate all regions (any always-on region works) — mirrors inventory/alibaba.ts. */
const BOOTSTRAP_REGION = "cn-hangzhou";
/** Regions swept in parallel. Bounded: a full sweep is ~30 regions × ~10 kinds of API call. */
const REGION_CONCURRENCY = 5;
/** ACK (Container Service) speaks a ROA API on its own version. */
const ACK_VERSION = "2015-12-15";
/** Re-assume once the STS credentials are within this window of expiring. */
const CRED_SKEW_MS = 5 * 60_000;

// --- resource kinds ---------------------------------------------------------------------------

/** How a delete call is addressed for one kind. */
interface DeleteSpec {
	action: string;
	/** The exact request params for the delete — nothing but the native id (+ region where required). */
	params: (nativeId: string, region: string) => Record<string, string>;
}

/**
 * One RPC-style kind we sweep: how to LIST it under a server-side tag filter, and how to DELETE one by
 * native id. These are the kinds `infra/templates/project/alibaba` actually creates and tags, plus the
 * ECS instances / disks / security groups / SLBs that ACK creates underneath the cluster.
 */
interface RpcKindSpec {
	kind: string;
	/** Endpoint prefix — the client talks to `<service>.<region>.aliyuncs.com`. */
	service: string;
	version: string;
	listAction: string;
	/** Alibaba wraps RPC lists twice: body[container][item] is the array (e.g. Instances.Instance). */
	container: string;
	item: string;
	idKey: string;
	nameKey: string;
	/** The response field carrying the creation time. EIPs call theirs `AllocationTime`. */
	createdKey: string;
	/**
	 * Set when the describe response may not echo tags (RDS/KVStore). Labels are then backfilled from the
	 * product's `ListTagResources` under the SAME tag filter — a narrowing, never a widening.
	 */
	tagResourceType?: string;
	del: DeleteSpec;
}

const RPC_KINDS: readonly RpcKindSpec[] = [
	{
		kind: "ecs:instance",
		service: "ecs",
		version: "2014-05-26",
		listAction: "DescribeInstances",
		container: "Instances",
		item: "Instance",
		idKey: "InstanceId",
		nameKey: "InstanceName",
		createdKey: "CreationTime",
		del: {
			action: "DeleteInstance",
			// Force lets a still-running pay-as-you-go instance be released; without it a live orphan is
			// undeletable and bills forever, which is the exact failure this feature exists to end.
			params: (id) => ({ InstanceId: id, Force: "true" }),
		},
	},
	{
		kind: "ecs:disk",
		service: "ecs",
		version: "2014-05-26",
		listAction: "DescribeDisks",
		container: "Disks",
		item: "Disk",
		idKey: "DiskId",
		nameKey: "DiskName",
		createdKey: "CreationTime",
		del: { action: "DeleteDisk", params: (id) => ({ DiskId: id }) },
	},
	{
		kind: "ecs:security-group",
		service: "ecs",
		version: "2014-05-26",
		listAction: "DescribeSecurityGroups",
		container: "SecurityGroups",
		item: "SecurityGroup",
		idKey: "SecurityGroupId",
		nameKey: "SecurityGroupName",
		createdKey: "CreationTime",
		del: {
			action: "DeleteSecurityGroup",
			params: (id, region) => ({ RegionId: region, SecurityGroupId: id }),
		},
	},
	{
		kind: "slb:loadbalancer",
		service: "slb",
		version: "2014-05-15",
		listAction: "DescribeLoadBalancers",
		container: "LoadBalancers",
		item: "LoadBalancer",
		idKey: "LoadBalancerId",
		nameKey: "LoadBalancerName",
		createdKey: "CreateTime",
		del: {
			action: "DeleteLoadBalancer",
			params: (id, region) => ({ RegionId: region, LoadBalancerId: id }),
		},
	},
	{
		kind: "rds:instance",
		service: "rds",
		version: "2014-08-15",
		listAction: "DescribeDBInstances",
		container: "Items",
		item: "DBInstance",
		idKey: "DBInstanceId",
		nameKey: "DBInstanceDescription",
		createdKey: "CreateTime",
		tagResourceType: "INSTANCE",
		del: {
			action: "DeleteDBInstance",
			params: (id) => ({ DBInstanceId: id }),
		},
	},
	{
		kind: "kvstore:instance",
		service: "r-kvstore",
		version: "2015-01-01",
		listAction: "DescribeInstances",
		container: "Instances",
		item: "KVStoreInstance",
		idKey: "InstanceId",
		nameKey: "InstanceName",
		createdKey: "CreateTime",
		tagResourceType: "INSTANCE",
		del: { action: "DeleteInstance", params: (id) => ({ InstanceId: id }) },
	},
	{
		kind: "vpc:nat-gateway",
		service: "vpc",
		version: "2016-04-28",
		listAction: "DescribeNatGateways",
		container: "NatGateways",
		item: "NatGateway",
		idKey: "NatGatewayId",
		nameKey: "Name",
		createdKey: "CreationTime",
		del: {
			action: "DeleteNatGateway",
			// Force also drops the gateway's SNAT entries and detaches its EIP, so the EIP that follows in
			// deleteOrder is free by the time we reach it.
			params: (id, region) => ({
				RegionId: region,
				NatGatewayId: id,
				Force: "true",
			}),
		},
	},
	{
		kind: "vpc:eip",
		service: "vpc",
		version: "2016-04-28",
		listAction: "DescribeEipAddresses",
		container: "EipAddresses",
		item: "EipAddress",
		idKey: "AllocationId",
		nameKey: "Name",
		// EIPs are the one kind that does not call it CreationTime.
		createdKey: "AllocationTime",
		del: {
			action: "ReleaseEipAddress",
			params: (id, region) => ({ RegionId: region, AllocationId: id }),
		},
	},
	{
		kind: "vpc:vswitch",
		service: "vpc",
		version: "2016-04-28",
		listAction: "DescribeVSwitches",
		container: "VSwitches",
		item: "VSwitch",
		idKey: "VSwitchId",
		nameKey: "VSwitchName",
		createdKey: "CreationTime",
		del: {
			action: "DeleteVSwitch",
			params: (id, region) => ({ RegionId: region, VSwitchId: id }),
		},
	},
	{
		kind: "vpc:vpc",
		service: "vpc",
		version: "2016-04-28",
		listAction: "DescribeVpcs",
		container: "Vpcs",
		item: "Vpc",
		idKey: "VpcId",
		nameKey: "VpcName",
		createdKey: "CreationTime",
		del: {
			action: "DeleteVpc",
			params: (id, region) => ({ RegionId: region, VpcId: id }),
		},
	},
] as const;

/** ACK clusters are ROA, not RPC, so they live outside RPC_KINDS. */
const ACK_KIND = "cs:cluster";

// --- narrowing helpers (no `any`, no casts) ---------------------------------------------------

/** True when `value` is a plain JSON object — the shape every Alibaba response body and item takes. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a non-empty string field off a response object, or null. */
function readString(
	source: Record<string, unknown>,
	key: string,
): string | null {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads a string field allowing the empty string (tag values may legitimately be ""). */
function readLoose(source: Record<string, unknown>, key: string): string | null {
	const value = source[key];
	return typeof value === "string" ? value : null;
}

/** The array at `body[container][item]`, dropping anything that isn't an object. */
function itemsOf(
	body: Record<string, unknown>,
	container: string,
	item: string,
): Record<string, unknown>[] {
	const outer = body[container];
	if (!isRecord(outer)) return [];
	const list = outer[item];
	return Array.isArray(list) ? list.filter(isRecord) : [];
}

/**
 * Normalizes Alibaba's several tag shapes into a flat map. Products disagree: ECS/VPC/SLB return
 * `Tags.Tag[{TagKey,TagValue}]`, KVStore returns `Tags.Tag[{Key,Value}]`, and a few return a bare array.
 * All three are accepted; nothing is invented.
 */
function tagsOf(item: Record<string, unknown>): Record<string, string> {
	const raw = item.Tags;
	const rows: unknown[] = Array.isArray(raw)
		? raw
		: isRecord(raw) && Array.isArray(raw.Tag)
			? raw.Tag
			: [];

	const labels: Record<string, string> = {};
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const key = readString(row, "TagKey") ?? readString(row, "Key");
		if (!key) continue;
		labels[key] =
			readLoose(row, "TagValue") ?? readLoose(row, "Value") ?? "";
	}
	return labels;
}

/**
 * Parses an Alibaba timestamp. Returns null when absent or unparseable — the created-after guard then
 * REFUSES the resource, which is the correct, safe outcome. A timestamp is never fabricated.
 */
function parseCreated(raw: string | null): Date | null {
	if (!raw) return null;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The `Code` Alibaba returned on a failed call, if the thrown error carries one. */
function errorCode(err: unknown): string | null {
	if (!isRecord(err)) return null;
	const code = err.code;
	return typeof code === "string" ? code : null;
}

/** The HTTP status of a failed call, if the thrown error carries one. */
function errorStatus(err: unknown): number | null {
	if (!isRecord(err)) return null;
	const direct = err.statusCode;
	if (typeof direct === "number") return direct;
	const data = err.data;
	if (isRecord(data) && typeof data.statusCode === "number") {
		return data.statusCode;
	}
	return null;
}

/**
 * True when a delete failed because the resource is already gone. Alibaba spells this a dozen ways
 * (`InvalidInstanceId.NotFound`, `InvalidVpcId.NotFound`, `InvalidAllocationId.NotFound`, an ACK 404, …),
 * so the match is deliberately generous: an already-deleted resource is a SUCCESS, not an error.
 */
function isAlreadyGone(err: unknown): boolean {
	const code = errorCode(err);
	if (code && /NotFound|NotExist|NoSuch/i.test(code)) return true;
	return errorStatus(err) === 404;
}

// --- credentials + transport -------------------------------------------------------------------

/** Cached STS credentials per identity. A sweep issues many calls; one assume per delete is wasteful. */
const credentialCache = new Map<
	string,
	{ credentials: AlibabaCredentials; expiresAt: number }
>();

/** Loads the Alibaba identity's connection metadata. Filtered by provider — never cross-provider. */
async function identityFor(
	identityId: string,
): Promise<Pick<CloudIdentity, "credentials">> {
	const [identity] = await getServiceDb()
		.select({ credentials: cloudIdentities.credentials })
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.provider, "alibaba"),
			),
		)
		.limit(1);

	if (!identity) {
		throw new Error(
			"alibaba reclaim: no Alibaba cloud identity for this connection",
		);
	}
	return identity;
}

/**
 * Temporary STS credentials for one identity, via the keyless `AssumeRoleWithOIDC` path the connection
 * already uses. Cached until shortly before they expire; no AccessKey is ever stored.
 */
async function credentialsFor(identityId: string): Promise<AlibabaCredentials> {
	const cached = credentialCache.get(identityId);
	if (cached && cached.expiresAt - CRED_SKEW_MS > Date.now()) {
		return cached.credentials;
	}

	const identity = await identityFor(identityId);
	const session = await assumeAlibabaRole(identity, { purpose: "reclaim" });
	if (!session.credentials) {
		throw new Error("alibaba reclaim: assume returned no credentials");
	}

	const expiry = session.credentials.expiration
		? Date.parse(session.credentials.expiration)
		: Number.NaN;
	credentialCache.set(identityId, {
		credentials: session.credentials,
		// An unparseable expiry must not be read as "never expires" — fall back to a short lease.
		expiresAt: Number.isNaN(expiry) ? Date.now() + 10 * 60_000 : expiry,
	});
	return session.credentials;
}

/** An OpenAPI client for one service in one region, signed with the temporary STS credentials. */
function clientFor(
	credentials: AlibabaCredentials,
	service: string,
	region: string,
): OpenApiClient {
	return new OpenApiClient(
		new $OpenApi.Config({
			accessKeyId: credentials.accessKeyId,
			accessKeySecret: credentials.accessKeySecret,
			securityToken: credentials.securityToken,
			endpoint: `${service}.${region}.aliyuncs.com`,
		}),
	);
}

/** The parsed body of an OpenAPI response, or an empty object when the call returned nothing. */
function bodyOf(response: unknown): Record<string, unknown> {
	if (!isRecord(response)) return {};
	return isRecord(response.body) ? response.body : {};
}

/**
 * One RPC call (ECS/VPC/SLB/RDS/KVStore). We drive the generic `@alicloud/openapi-client` client rather
 * than a per-service SDK: the console only vendors `@alicloud/vpc20160428`, and pulling in an SDK per
 * product (ecs/slb/rds/r-kvstore/cs) to issue two calls each would be a lot of dependency for no
 * capability. Signing, STS-token headers and retries are the shared client's job either way.
 */
async function rpc(
	client: OpenApiClient,
	action: string,
	version: string,
	query: Record<string, string>,
): Promise<Record<string, unknown>> {
	const params = new $OpenApi.Params({
		action,
		version,
		protocol: "HTTPS",
		pathname: "/",
		method: "POST",
		authType: "AK",
		style: "RPC",
		reqBodyType: "formData",
		bodyType: "json",
	});
	const response: unknown = await client.callApi(
		params,
		new $OpenApi.OpenApiRequest({ query }),
		new $Util.RuntimeOptions({}),
	);
	return bodyOf(response);
}

/** One ROA call (ACK / Container Service, which is not an RPC product). */
async function roa(
	client: OpenApiClient,
	action: string,
	method: string,
	pathname: string,
	query: Record<string, string>,
): Promise<Record<string, unknown>> {
	const params = new $OpenApi.Params({
		action,
		version: ACK_VERSION,
		protocol: "HTTPS",
		pathname,
		method,
		authType: "AK",
		style: "ROA",
		reqBodyType: "json",
		bodyType: "json",
	});
	const response: unknown = await client.callApi(
		params,
		new $OpenApi.OpenApiRequest({ query }),
		new $Util.RuntimeOptions({}),
	);
	return bodyOf(response);
}

/**
 * The tag filter, as Alibaba's RPC products spell it. This is a SERVER-SIDE filter — the account is
 * never enumerated and then narrowed here, so a bug in this file cannot reach a resource outside the
 * selector.
 */
function tagFilter(selector: LabelSelector): Record<string, string> {
	return { "Tag.1.Key": selector.key, "Tag.1.Value": selector.value };
}

// --- listing ------------------------------------------------------------------------------------

/** Every region the role can see. Enumerated once per sweep (mirrors inventory/alibaba.ts). */
async function listRegions(credentials: AlibabaCredentials): Promise<string[]> {
	const body = await rpc(
		clientFor(credentials, "vpc", BOOTSTRAP_REGION),
		"DescribeRegions",
		"2016-04-28",
		{},
	);
	return itemsOf(body, "Regions", "Region")
		.map((region) => readString(region, "RegionId"))
		.filter((region): region is string => region !== null);
}

/**
 * Tags for the resources of one product that carry the selector, from the product's `ListTagResources`.
 * Used only for the kinds whose describe response may omit tags (RDS/KVStore) — without labels the core's
 * label re-check refuses the resource, so this is what makes those kinds sweepable at all.
 *
 * Best-effort: the same tag filter is applied server-side, and a failure yields an empty map (the
 * resource then falls back to its describe tags, and is refused if it has none). Failing OPEN here is
 * impossible by construction — an empty map can only cause a KEEP.
 */
async function tagMapFor(
	client: OpenApiClient,
	version: string,
	region: string,
	resourceType: string,
	selector: LabelSelector,
): Promise<Map<string, Record<string, string>>> {
	const byId = new Map<string, Record<string, string>>();
	let nextToken: string | null = null;

	try {
		for (;;) {
			const query: Record<string, string> = {
				RegionId: region,
				ResourceType: resourceType,
				...tagFilter(selector),
			};
			if (nextToken) query.NextToken = nextToken;

			const body: Record<string, unknown> = await rpc(
				client,
				"ListTagResources",
				version,
				query,
			);
			for (const row of itemsOf(body, "TagResources", "TagResource")) {
				const id = readString(row, "ResourceId");
				const key = readString(row, "TagKey");
				if (!id || !key) continue;
				const labels = byId.get(id) ?? {};
				labels[key] = readLoose(row, "TagValue") ?? "";
				byId.set(id, labels);
			}
			nextToken = readString(body, "NextToken");
			if (!nextToken) break;
		}
	} catch {
		// A product that doesn't expose ListTagResources (or a role without the permission) must not fail
		// the sweep — the describe tags still stand, and a resource with no labels is simply kept.
		return byId;
	}
	return byId;
}

/** Lists one RPC kind in one region, server-side filtered by the selector tag, following pagination. */
async function listRpcKind(
	credentials: AlibabaCredentials,
	spec: RpcKindSpec,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const client = clientFor(credentials, spec.service, region);
	const backfill = spec.tagResourceType
		? await tagMapFor(
				client,
				spec.version,
				region,
				spec.tagResourceType,
				selector,
			)
		: null;

	const found: CloudResourceRef[] = [];
	for (let page = 1; ; page++) {
		const body = await rpc(client, spec.listAction, spec.version, {
			RegionId: region,
			PageNumber: String(page),
			PageSize: String(PAGE_SIZE),
			...tagFilter(selector),
		});

		const items = itemsOf(body, spec.container, spec.item);
		for (const item of items) {
			const nativeId = readString(item, spec.idKey);
			if (!nativeId) continue;

			found.push({
				native_id: nativeId,
				kind: spec.kind,
				name: readString(item, spec.nameKey),
				region,
				created_at: parseCreated(readString(item, spec.createdKey)),
				labels: { ...(backfill?.get(nativeId) ?? {}), ...tagsOf(item) },
			});
		}
		if (items.length < PAGE_SIZE) break;
	}
	return found;
}

/** The tag rows of an ACK `ListTagResources` response (ROA, snake_case, sometimes singly wrapped). */
function ackTagRows(body: Record<string, unknown>): Record<string, unknown>[] {
	const raw = body.tag_resources;
	if (Array.isArray(raw)) return raw.filter(isRecord);
	if (isRecord(raw) && Array.isArray(raw.tag_resource)) {
		return raw.tag_resource.filter(isRecord);
	}
	return [];
}

/** The tags on an ACK cluster detail (`tags: [{key, value}]` — ACK's own shape, not the RPC one). */
function ackTags(detail: Record<string, unknown>): Record<string, string> {
	const raw = detail.tags;
	if (!Array.isArray(raw)) return {};
	const labels: Record<string, string> = {};
	for (const row of raw) {
		if (!isRecord(row)) continue;
		const key = readString(row, "key");
		if (!key) continue;
		labels[key] = readLoose(row, "value") ?? "";
	}
	return labels;
}

/**
 * Lists the ACK clusters in one region carrying the selector.
 *
 * ACK's `DescribeClustersV1` has NO tag filter, so listing it and matching afterwards would be exactly
 * the client-side filter this file forbids. Instead we go through ACK's `ListTagResources` — a
 * server-side tag filter that returns the matching cluster ids — and then read each of THOSE ids with
 * `DescribeClusterDetail` for its `created` timestamp. The second call only ever narrows: it is issued
 * against ids the tag filter already selected.
 */
async function listAckClusters(
	credentials: AlibabaCredentials,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const client = clientFor(credentials, "cs", region);

	const labelsById = new Map<string, Record<string, string>>();
	let nextToken: string | null = null;
	for (;;) {
		const query: Record<string, string> = {
			region_id: region,
			resource_type: "CLUSTER",
			tags: JSON.stringify([{ key: selector.key, value: selector.value }]),
		};
		if (nextToken) query.next_token = nextToken;

		const body: Record<string, unknown> = await roa(
			client,
			"ListTagResources",
			"GET",
			"/tags",
			query,
		);
		for (const row of ackTagRows(body)) {
			const id = readString(row, "resource_id");
			const key = readString(row, "tag_key");
			if (!id) continue;
			const labels = labelsById.get(id) ?? {};
			if (key) labels[key] = readLoose(row, "tag_value") ?? "";
			labelsById.set(id, labels);
		}
		nextToken = readString(body, "next_token");
		if (!nextToken) break;
	}

	const found: CloudResourceRef[] = [];
	for (const [clusterId, tagLabels] of labelsById) {
		const detail = await roa(
			client,
			"DescribeClusterDetail",
			"GET",
			`/clusters/${encodeURIComponent(clusterId)}`,
			{},
		);
		const detailLabels = ackTags(detail);
		found.push({
			native_id: clusterId,
			kind: ACK_KIND,
			name: readString(detail, "name"),
			region: readString(detail, "region_id") ?? region,
			// ACK spells its creation time `created`.
			created_at: parseCreated(readString(detail, "created")),
			labels: {
				...tagLabels,
				...detailLabels,
			},
		});
	}
	return found;
}

/** Every kind in one region. A region the role can't reach must not fail the whole sweep. */
async function listRegion(
	credentials: AlibabaCredentials,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const lists = await Promise.all([
		listAckClusters(credentials, region, selector).catch(() => []),
		...RPC_KINDS.map((spec) =>
			listRpcKind(credentials, spec, region, selector).catch(() => []),
		),
	]);
	return lists.flat();
}

/**
 * Lists every Alibaba resource carrying the selector tag, across every region the role can see and every
 * kind our template creates. Server-side tag-filtered throughout — no account-wide listing ever happens.
 */
async function list(
	identityId: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const credentials = await credentialsFor(identityId);
	const regions = await listRegions(credentials);

	const found: CloudResourceRef[] = [];
	for (let i = 0; i < regions.length; i += REGION_CONCURRENCY) {
		const batch = regions.slice(i, i + REGION_CONCURRENCY);
		const results = await Promise.all(
			batch.map((region) => listRegion(credentials, region, selector)),
		);
		found.push(...results.flat());
	}
	return found;
}

// --- deleting -----------------------------------------------------------------------------------

/**
 * Deletes ONE resource by its exact native id — the id the cloud gave us, never a name. Called only for
 * resources the core has already cleared through every guard.
 *
 * Idempotent: a resource that has since vanished is a success. Anything else surfaces, and the sweep
 * retries on its next tick rather than forcing (a dependency that is still detaching resolves itself
 * once the kind ahead of it in deleteOrder finishes).
 */
async function remove(
	identityId: string,
	resource: CloudResourceRef,
): Promise<void> {
	const credentials = await credentialsFor(identityId);
	// Region comes from the listing that found it, so a delete is always issued where the resource lives.
	const region = resource.region ?? BOOTSTRAP_REGION;

	try {
		if (resource.kind === ACK_KIND) {
			await roa(
				clientFor(credentials, "cs", region),
				"DeleteCluster",
				"DELETE",
				`/clusters/${encodeURIComponent(resource.native_id)}`,
				{},
			);
			return;
		}

		const spec = RPC_KINDS.find((candidate) => candidate.kind === resource.kind);
		if (!spec) {
			throw new Error(`alibaba reclaim: unknown kind ${resource.kind}`);
		}

		await rpc(
			clientFor(credentials, spec.service, region),
			spec.del.action,
			spec.version,
			spec.del.params(resource.native_id, region),
		);
	} catch (err) {
		if (isAlreadyGone(err)) return;
		throw err;
	}
}

export const alibabaReclaim: ReclaimAdapter = {
	provider: "alibaba",
	list,
	delete: remove,
	// Most-dependent first. The ACK cluster owns its nodes and their SLBs, so it goes before everything;
	// then the compute and the things attached to it; then the data services holding ENIs in the
	// vswitches; then disks and security groups; and only once the vswitches are empty can the VPC go.
	deleteOrder: [
		ACK_KIND,
		"ecs:instance",
		"slb:loadbalancer",
		"vpc:nat-gateway",
		"vpc:eip",
		"rds:instance",
		"kvstore:instance",
		"ecs:disk",
		"ecs:security-group",
		"vpc:vswitch",
		"vpc:vpc",
	],
};
