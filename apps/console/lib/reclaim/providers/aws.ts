// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS orphan-reclaim adapter.
//
// Every list here is filtered SERVER-SIDE, by AWS. We never enumerate the account and filter
// afterwards: a customer's AWS account routinely holds unrelated production infrastructure, and a
// client-side predicate is one bug away from listing all of it.
//
// TWO SERVER-SIDE DISCOVERY PATHS, DELIBERATELY MIXED
//  - EKS clusters / node groups / ELBv2 load balancers → the Resource Groups Tagging API
//    (`GetResources` + `TagFilters`): one genuine server-side tag query spanning services, returning
//    ARNs. These are the expensive orphans; nothing else finds them.
//  - EC2 kinds → EC2's own `tag:<key>` `Filters`, which AWS also evaluates server-side. Kept because a
//    describe returns the tags AND the creation timestamp in the SAME filtered call, so `created_at`
//    costs no follow-up request and there is no N+1. The Tagging API cannot do that — it returns no
//    creation time at all, for anything.
//
// Both paths are tag-filtered by AWS itself. Neither is ever widened afterwards.
//
// The adapter lists and deletes. It decides nothing — see lib/reclaim/guards.ts.

import {
	DeleteNatGatewayCommand,
	DeleteSecurityGroupCommand,
	DeleteSubnetCommand,
	DeleteVolumeCommand,
	DeleteVpcCommand,
	DescribeAddressesCommand,
	DescribeInstancesCommand,
	DescribeNatGatewaysCommand,
	DescribeRegionsCommand,
	DescribeSecurityGroupsCommand,
	DescribeSubnetsCommand,
	DescribeVolumesCommand,
	DescribeVpcsCommand,
	EC2Client,
	type Filter,
	ReleaseAddressCommand,
	type Tag,
	TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
	DeleteClusterCommand,
	DeleteNodegroupCommand,
	DescribeClusterCommand,
	DescribeNodegroupCommand,
	EKSClient,
} from "@aws-sdk/client-eks";
import {
	DeleteLoadBalancerCommand,
	DescribeLoadBalancersCommand,
	ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
	GetResourcesCommand,
	ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { and, eq } from "drizzle-orm";
import { assumeAwsRole } from "@/lib/cloud-providers/session/aws";
import { getServiceDb } from "@/lib/db";
import { type CloudIdentity, cloudIdentities } from "@/lib/db/schema";
import type { CloudResourceRef, LabelSelector, ReclaimAdapter } from "../types";

const TIMEOUT_MS = 15_000;

/** How many regions we sweep at once. Bounded so a sweep cannot stampede the AWS APIs. */
const REGION_CONCURRENCY = 4;

/** EKS has no batch describe, so its per-resource describes are fanned out at this width. */
const DESCRIBE_CONCURRENCY = 8;

/** `DescribeLoadBalancers` takes at most 20 ARNs per call. */
const ELB_BATCH = 20;

/**
 * The kinds this adapter can see, named `service:resourceType` after the ARN grammar the Tagging API
 * speaks.
 *
 * `ec2:elastic-ip`, `ec2:security-group`, `ec2:subnet` and `ec2:vpc` carry NO creation timestamp — AWS
 * records one nowhere, for any of them. They therefore report `created_at: null` and the created-after
 * guard REFUSES them. That is the correct, safe outcome: we cannot prove such a resource is ours, so we
 * do not delete it. They are still listed so the sweep's audit trail shows the operator the residue it
 * declined to touch. No timestamp is ever fabricated to get around this.
 */
const KIND = {
	eksCluster: "eks:cluster",
	eksNodegroup: "eks:nodegroup",
	loadBalancer: "elasticloadbalancing:loadbalancer",
	instance: "ec2:instance",
	volume: "ec2:volume",
	natGateway: "ec2:natgateway",
	elasticIp: "ec2:elastic-ip",
	securityGroup: "ec2:security-group",
	subnet: "ec2:subnet",
	vpc: "ec2:vpc",
} as const;

/** The resource types the Tagging API is asked for — exactly the ones EC2's own filters cannot reach. */
const TAGGING_API_TYPES = [
	KIND.eksCluster,
	KIND.eksNodegroup,
	KIND.loadBalancer,
];

// ---------------------------------------------------------------------------------------------
// native_id: WHATEVER TOFU STATE RECORDS FOR THAT RESOURCE TYPE.
//
// This is the criterion, and it is load-bearing — do NOT "normalize" these to ARNs. The not-in-state
// guard (guards.ts) asks `stateNativeIds.has(resource.native_id)`, and state.ts builds that set from
// each resource's `id`/`arn` attributes exactly as the AWS provider wrote them. So a native_id must be
// a value the provider actually stores, or the guard silently stops matching:
//
//   ec2:*         → the raw id (i-…, vol-…, nat-…, eipalloc-…, sg-…, subnet-…, vpc-…), i.e. `.id`.
//                   NOT the ARN. The AWS provider exports NO `arn` attribute for aws_nat_gateway or
//                   aws_eip, so an ARN native_id would MISS the not-in-state guard for those two, then
//                   pass created-after (they were, truthfully, created after the job started), and be
//                   decided "delete" — destroying a resource tofu is actively managing, behind its
//                   back. Raw ids match `.id` for every EC2 kind and close that hole.
//   eks:cluster   → the cluster NAME (aws_eks_cluster.id is the name). DeleteCluster also takes it.
//   eks:nodegroup → "<cluster>:<nodegroup>" (aws_eks_node_group.id is exactly this colon pair).
//   elasticloadbalancing:loadbalancer
//                 → the ARN (aws_lb.id IS the arn, and the ELBv2 delete API takes the arn).
// ---------------------------------------------------------------------------------------------

/** Short-lived federated credentials for one identity (keyless — AssumeRoleWithWebIdentity). */
type AwsCredentials = Awaited<ReturnType<typeof assumeAwsRole>>["credentials"];

/** Resolves the AWS cloud identity, scoped by provider (a cross-provider read is a data leak). */
async function identityFor(
	identityId: string,
): Promise<Pick<CloudIdentity, "credentials">> {
	const [identity] = await getServiceDb()
		.select({ credentials: cloudIdentities.credentials })
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.provider, "aws"),
			),
		)
		.limit(1);

	if (!identity) {
		throw new Error(`aws reclaim: no AWS cloud identity ${identityId}`);
	}
	return identity;
}

/** The tag filter AWS itself applies. The ONLY thing scoping this sweep to one environment. */
function tagFilter(selector: LabelSelector): Filter {
	return { Name: `tag:${selector.key}`, Values: [selector.value] };
}

/** Every tag AWS returned, flattened. The core re-checks the selector against this. */
function tagsToLabels(
	tags: Tag[] | { Key?: string; Value?: string }[] | undefined,
): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const tag of tags ?? []) {
		if (tag.Key !== undefined && tag.Value !== undefined) {
			labels[tag.Key] = tag.Value;
		}
	}
	return labels;
}

/** The conventional `Name` tag. Audit-trail only — never used to choose what to delete. */
function nameFromTags(
	tags: Tag[] | { Key?: string; Value?: string }[] | undefined,
): string | null {
	for (const tag of tags ?? []) if (tag.Key === "Name") return tag.Value ?? null;
	return null;
}

/** The AWS error code (`InvalidVolume.NotFound`, `ResourceNotFoundException`, …), or "". */
function errorCode(err: unknown): string {
	if (typeof err !== "object" || err === null) return "";
	if ("name" in err && typeof err.name === "string" && err.name) return err.name;
	if ("Code" in err && typeof err.Code === "string") return err.Code;
	return "";
}

/**
 * Whether a call failed only because the resource is already gone. Idempotence is a hard requirement of
 * the adapter contract: a resource that vanished between the list and the delete is a SUCCESS. Every
 * relevant code across EC2 (`InvalidVolume.NotFound`), EKS (`ResourceNotFoundException`) and ELBv2
 * (`LoadBalancerNotFoundException`) contains "NotFound".
 */
function isAlreadyGone(err: unknown): boolean {
	return errorCode(err).includes("NotFound");
}

/** Splits `items` into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/** Runs `fn` over `items` with bounded concurrency, flattening the results. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R[]>,
): Promise<R[]> {
	const out: R[] = [];
	for (const batch of chunk(items, limit)) {
		for (const part of await Promise.all(batch.map(fn))) out.push(...part);
	}
	return out;
}

/** An EC2 client for one region, on the identity's short-lived federated session. */
function ec2For(region: string, credentials: AwsCredentials): EC2Client {
	return new EC2Client({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
}

/** An EKS client for one region. */
function eksFor(region: string, credentials: AwsCredentials): EKSClient {
	return new EKSClient({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
}

/** An ELBv2 client for one region. */
function elbFor(
	region: string,
	credentials: AwsCredentials,
): ElasticLoadBalancingV2Client {
	return new ElasticLoadBalancingV2Client({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
}

/** The regions this account has enabled. An orphan can sit in any of them, so all are swept. */
async function enabledRegions(client: EC2Client): Promise<string[]> {
	const res = await client.send(new DescribeRegionsCommand({}));
	return (res.Regions ?? [])
		.map((region) => region.RegionName)
		.filter((name): name is string => Boolean(name));
}

// ---------------------------------------------------------------------------------------------
// Discovery path 1 — the Resource Groups Tagging API (EKS + ELBv2).
// ---------------------------------------------------------------------------------------------

/** One ARN the Tagging API matched, with the tags it carries. */
interface TaggedArn {
	arn: string;
	labels: Record<string, string>;
	name: string | null;
}

/** The pieces of an ARN this adapter cares about: `arn:aws:<service>:<region>:<acct>:<resource>`. */
interface ParsedArn {
	service: string;
	region: string;
	/** The `/`-separated resource part, e.g. ["nodegroup", "my-cluster", "ng-1", "<uuid>"]. */
	segments: string[];
}

/** Parses an ARN, or returns null if it is not the 6-field form we understand. */
function parseArn(arn: string): ParsedArn | null {
	const parts = arn.split(":");
	if (parts.length < 6) return null;
	const service = parts[2];
	const region = parts[3];
	// The resource part may itself contain ":" — be exact rather than lucky.
	const resource = parts.slice(5).join(":");
	if (!service || !region || !resource) return null;
	return { service, region, segments: resource.split("/") };
}

/**
 * Every EKS/ELBv2 ARN in one region carrying the selector tag, via `GetResources` + `TagFilters` — a
 * genuine server-side tag filter, evaluated by AWS across services. Paginated fully. The Tagging API
 * returns no creation time; callers enrich with a describe per service.
 */
async function taggedArns(
	region: string,
	credentials: AwsCredentials,
	selector: LabelSelector,
): Promise<TaggedArn[]> {
	const tagging = new ResourceGroupsTaggingAPIClient({
		region,
		credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});

	const out: TaggedArn[] = [];
	let token: string | undefined;

	do {
		const res = await tagging.send(
			new GetResourcesCommand({
				// The tag filter is always sent. It is the whole safety story of this path.
				TagFilters: [{ Key: selector.key, Values: [selector.value] }],
				ResourceTypeFilters: TAGGING_API_TYPES,
				ResourcesPerPage: 100,
				PaginationToken: token,
			}),
		);
		for (const mapping of res.ResourceTagMappingList ?? []) {
			if (!mapping.ResourceARN) continue;
			out.push({
				arn: mapping.ResourceARN,
				labels: tagsToLabels(mapping.Tags),
				name: nameFromTags(mapping.Tags),
			});
		}
		// The Tagging API signals "done" with an EMPTY string, not a missing field.
		token = res.PaginationToken ? res.PaginationToken : undefined;
	} while (token);

	return out;
}

/** An EKS cluster the Tagging API matched. */
interface FoundCluster {
	tagged: TaggedArn;
	clusterName: string;
}

/** An EKS node group the Tagging API matched. */
interface FoundNodegroup {
	tagged: TaggedArn;
	clusterName: string;
	nodegroupName: string;
}

/**
 * EKS clusters, enriched with `created_at` ← `DescribeCluster().cluster.createdAt`. EKS offers NO batch
 * describe, so one call per cluster is the only option available (there are a handful per environment,
 * not hundreds). A cluster that vanished between list and describe is dropped — it is already gone.
 */
async function describeClusters(
	eks: EKSClient,
	region: string,
	found: FoundCluster[],
): Promise<CloudResourceRef[]> {
	return mapPool(found, DESCRIBE_CONCURRENCY, async ({ tagged, clusterName }) => {
		try {
			const res = await eks.send(
				new DescribeClusterCommand({ name: clusterName }),
			);
			return [
				{
					// native_id = the cluster NAME: what aws_eks_cluster.id records.
					native_id: clusterName,
					kind: KIND.eksCluster,
					name: clusterName,
					region,
					created_at: res.cluster?.createdAt ?? null,
					labels: tagged.labels,
				},
			];
		} catch (err) {
			if (isAlreadyGone(err)) return [];
			throw err;
		}
	});
}

/**
 * EKS node groups, enriched with `created_at` ← `DescribeNodegroup().nodegroup.createdAt`. No batch
 * describe exists here either. A node group that vanished between list and describe is dropped.
 */
async function describeNodegroups(
	eks: EKSClient,
	region: string,
	found: FoundNodegroup[],
): Promise<CloudResourceRef[]> {
	return mapPool(
		found,
		DESCRIBE_CONCURRENCY,
		async ({ tagged, clusterName, nodegroupName }) => {
			try {
				const res = await eks.send(
					new DescribeNodegroupCommand({ clusterName, nodegroupName }),
				);
				return [
					{
						// native_id = "<cluster>:<nodegroup>": exactly what aws_eks_node_group.id records.
						native_id: `${clusterName}:${nodegroupName}`,
						kind: KIND.eksNodegroup,
						name: nodegroupName,
						region,
						created_at: res.nodegroup?.createdAt ?? null,
						labels: tagged.labels,
					},
				];
			} catch (err) {
				if (isAlreadyGone(err)) return [];
				throw err;
			}
		},
	);
}

/**
 * ELBv2 load balancers, enriched with `created_at` ← `DescribeLoadBalancers().CreatedTime`. BATCHED: the
 * API takes up to 20 ARNs per call. One stale ARN makes the whole batch throw
 * `LoadBalancerNotFoundException`, so a failed batch is retried one ARN at a time and the gone ones are
 * dropped — rather than losing the creation time of the 19 that are still there (which would make the
 * guard refuse them and leave real orphans billing).
 */
async function describeLoadBalancers(
	elb: ElasticLoadBalancingV2Client,
	region: string,
	found: TaggedArn[],
): Promise<CloudResourceRef[]> {
	const byArn = new Map(found.map((entry) => [entry.arn, entry]));

	/** Describes a set of ARNs in one call, mapping each live one to a ref. */
	const describe = async (arns: string[]): Promise<CloudResourceRef[]> => {
		const res = await elb.send(
			new DescribeLoadBalancersCommand({ LoadBalancerArns: arns }),
		);
		const refs: CloudResourceRef[] = [];
		for (const lb of res.LoadBalancers ?? []) {
			const arn = lb.LoadBalancerArn;
			if (!arn) continue;
			const tagged = byArn.get(arn);
			// Only ever emit what the tag filter matched — never what the describe happened to return.
			if (!tagged) continue;
			refs.push({
				// native_id = the ARN: aws_lb.id IS the arn, and DeleteLoadBalancer takes the arn.
				native_id: arn,
				kind: KIND.loadBalancer,
				name: lb.LoadBalancerName ?? tagged.name,
				region,
				created_at: lb.CreatedTime ?? null,
				labels: tagged.labels,
			});
		}
		return refs;
	};

	return mapPool(chunk([...byArn.keys()], ELB_BATCH), 1, async (batch) => {
		try {
			return await describe(batch);
		} catch (err) {
			if (!isAlreadyGone(err)) throw err;
			// Fall back to one-at-a-time so a single deleted LB cannot blind us to the rest of the batch.
			return mapPool(batch, DESCRIBE_CONCURRENCY, async (arn) => {
				try {
					return await describe([arn]);
				} catch (inner) {
					if (isAlreadyGone(inner)) return [];
					throw inner;
				}
			});
		}
	});
}

/**
 * The Tagging-API path for one region: discover EKS/ELBv2 ARNs by tag, then describe each service to
 * attach `created_at`. ARNs whose shape we do not recognise are skipped — notably a CLASSIC ELB, whose
 * ARN is `loadbalancer/<name>` (no `app|net|gwy` segment) and which the ELBv2 API cannot delete. Our
 * template never creates one; skipping is the safe outcome if one somehow appears.
 */
async function listTaggedServices(
	region: string,
	credentials: AwsCredentials,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const found = await taggedArns(region, credentials, selector);
	if (found.length === 0) return [];

	const clusters: FoundCluster[] = [];
	const nodegroups: FoundNodegroup[] = [];
	const loadBalancers: TaggedArn[] = [];

	for (const tagged of found) {
		const parsed = parseArn(tagged.arn);
		if (!parsed) continue;
		const resourceType = parsed.segments[0];
		const first = parsed.segments[1];
		const second = parsed.segments[2];

		if (parsed.service === "eks" && resourceType === "cluster" && first) {
			// arn:…:cluster/<name>
			clusters.push({ tagged, clusterName: first });
		} else if (
			parsed.service === "eks" &&
			resourceType === "nodegroup" &&
			first &&
			second
		) {
			// arn:…:nodegroup/<cluster>/<nodegroup>/<uuid>
			nodegroups.push({ tagged, clusterName: first, nodegroupName: second });
		} else if (
			parsed.service === "elasticloadbalancing" &&
			resourceType === "loadbalancer" &&
			// ELBv2 only: loadbalancer/<app|net|gwy>/<name>/<id>. A Classic ELB has no type segment.
			parsed.segments.length >= 4
		) {
			loadBalancers.push(tagged);
		}
	}

	const eks = eksFor(region, credentials);
	const results = await Promise.all([
		describeClusters(eks, region, clusters),
		describeNodegroups(eks, region, nodegroups),
		describeLoadBalancers(elbFor(region, credentials), region, loadBalancers),
	]);
	return results.flat();
}

// ---------------------------------------------------------------------------------------------
// Discovery path 2 — EC2's own server-side `tag:` filters (tags + creation time in one call).
// ---------------------------------------------------------------------------------------------

/**
 * Live EC2 instances carrying the selector tag — the EKS node-group nodes, in practice.
 * `created_at` ← `LaunchTime`. Terminated/terminating instances are excluded SERVER-SIDE: they bill
 * nothing and cannot be deleted twice.
 */
async function listInstances(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeInstancesCommand({
				Filters: [
					tagFilter(selector),
					{
						Name: "instance-state-name",
						Values: ["pending", "running", "stopping", "stopped"],
					},
				],
				NextToken: token,
			}),
		);
		for (const reservation of res.Reservations ?? []) {
			for (const instance of reservation.Instances ?? []) {
				if (!instance.InstanceId) continue;
				out.push({
					native_id: instance.InstanceId,
					kind: KIND.instance,
					name: nameFromTags(instance.Tags),
					region,
					created_at: instance.LaunchTime ?? null,
					labels: tagsToLabels(instance.Tags),
				});
			}
		}
		token = res.NextToken;
	} while (token);

	return out;
}

/**
 * EBS volumes carrying the selector tag (incl. the EBS-CSI driver's dynamic ones, which the template
 * tags via `extraVolumeTags`). `created_at` ← `CreateTime`.
 */
async function listVolumes(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeVolumesCommand({
				Filters: [tagFilter(selector)],
				NextToken: token,
			}),
		);
		for (const volume of res.Volumes ?? []) {
			if (!volume.VolumeId) continue;
			out.push({
				native_id: volume.VolumeId,
				kind: KIND.volume,
				name: nameFromTags(volume.Tags),
				region,
				created_at: volume.CreateTime ?? null,
				labels: tagsToLabels(volume.Tags),
			});
		}
		token = res.NextToken;
	} while (token);

	return out;
}

/**
 * NAT gateways carrying the selector tag — the orphan that hurts, at ~$32/month each.
 * `created_at` ← `CreateTime`. Already-deleted ones are excluded SERVER-SIDE (`state`), because
 * DescribeNatGateways keeps returning them for hours after they stop billing.
 */
async function listNatGateways(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeNatGatewaysCommand({
				Filter: [
					tagFilter(selector),
					{ Name: "state", Values: ["pending", "available"] },
				],
				NextToken: token,
			}),
		);
		for (const gateway of res.NatGateways ?? []) {
			if (!gateway.NatGatewayId) continue;
			out.push({
				native_id: gateway.NatGatewayId,
				kind: KIND.natGateway,
				name: nameFromTags(gateway.Tags),
				region,
				created_at: gateway.CreateTime ?? null,
				labels: tagsToLabels(gateway.Tags),
			});
		}
		token = res.NextToken;
	} while (token);

	return out;
}

/**
 * Elastic IPs carrying the selector tag. AWS records NO creation time for an EIP → `created_at: null`,
 * and the created-after guard refuses them. Listed anyway so the audit trail shows them.
 * (DescribeAddresses is not paginated — it returns every match.)
 */
async function listElasticIps(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const res = await ec2.send(
		new DescribeAddressesCommand({ Filters: [tagFilter(selector)] }),
	);

	const out: CloudResourceRef[] = [];
	for (const address of res.Addresses ?? []) {
		// The allocation id is the handle ReleaseAddress takes; a VPC EIP always has one.
		if (!address.AllocationId) continue;
		out.push({
			native_id: address.AllocationId,
			kind: KIND.elasticIp,
			name: nameFromTags(address.Tags),
			region,
			created_at: null,
			labels: tagsToLabels(address.Tags),
		});
	}
	return out;
}

/**
 * Security groups carrying the selector tag. No creation time exists → refused by the guard.
 * A VPC's `default` group is skipped: it cannot be deleted, and it is the VPC's, not ours. (Skipping
 * NARROWS the server-side result — it never widens it.)
 */
async function listSecurityGroups(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeSecurityGroupsCommand({
				Filters: [tagFilter(selector)],
				NextToken: token,
			}),
		);
		for (const group of res.SecurityGroups ?? []) {
			if (!group.GroupId || group.GroupName === "default") continue;
			out.push({
				native_id: group.GroupId,
				kind: KIND.securityGroup,
				name: nameFromTags(group.Tags) ?? group.GroupName ?? null,
				region,
				created_at: null,
				labels: tagsToLabels(group.Tags),
			});
		}
		token = res.NextToken;
	} while (token);

	return out;
}

/** Subnets carrying the selector tag. No creation time exists → refused by the guard. */
async function listSubnets(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeSubnetsCommand({
				Filters: [tagFilter(selector)],
				NextToken: token,
			}),
		);
		for (const subnet of res.Subnets ?? []) {
			if (!subnet.SubnetId) continue;
			out.push({
				native_id: subnet.SubnetId,
				kind: KIND.subnet,
				name: nameFromTags(subnet.Tags),
				region,
				created_at: null,
				labels: tagsToLabels(subnet.Tags),
			});
		}
		token = res.NextToken;
	} while (token);

	return out;
}

/** VPCs carrying the selector tag. No creation time exists → refused by the guard. */
async function listVpcs(
	ec2: EC2Client,
	region: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	let token: string | undefined;

	do {
		const res = await ec2.send(
			new DescribeVpcsCommand({
				Filters: [tagFilter(selector)],
				NextToken: token,
			}),
		);
		for (const vpc of res.Vpcs ?? []) {
			if (!vpc.VpcId) continue;
			out.push({
				native_id: vpc.VpcId,
				kind: KIND.vpc,
				name: nameFromTags(vpc.Tags),
				region,
				created_at: null,
				labels: tagsToLabels(vpc.Tags),
			});
		}
		token = res.NextToken;
	} while (token);

	return out;
}

// ---------------------------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------------------------

/** Every kind we can see in one region, across both server-side-filtered discovery paths. */
async function listRegion(
	region: string,
	credentials: AwsCredentials,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const ec2 = ec2For(region, credentials);
	const results = await Promise.all([
		listTaggedServices(region, credentials, selector),
		listInstances(ec2, region, selector),
		listVolumes(ec2, region, selector),
		listNatGateways(ec2, region, selector),
		listElasticIps(ec2, region, selector),
		listSecurityGroups(ec2, region, selector),
		listSubnets(ec2, region, selector),
		listVpcs(ec2, region, selector),
	]);
	return results.flat();
}

/**
 * Lists every resource carrying the selector tag, across every region the account has enabled (`list`
 * gets no region, and an orphan bills wherever it happens to sit). Server-side filtered throughout —
 * the tag filter is always sent, never optional.
 */
async function list(
	identityId: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const identity = await identityFor(identityId);
	const session = await assumeAwsRole(identity, { purpose: "reclaim" });

	const regions = await enabledRegions(
		ec2For(session.region, session.credentials),
	);
	return mapPool(regions, REGION_CONCURRENCY, (region) =>
		listRegion(region, session.credentials, selector),
	);
}

/**
 * Deletes ONE resource by its native id, in its own region. Idempotent: a resource that has already
 * vanished is a success.
 *
 * Dependency failures are deliberately NOT forced. A volume still detaching from an instance we just
 * terminated, an EIP still attached to a NAT gateway mid-delete, or a cluster whose node groups are
 * still draining raises a dependency error here — it surfaces, and the sweep retries on its next tick,
 * rather than escalating to a force-delete.
 */
async function remove(
	identityId: string,
	resource: CloudResourceRef,
): Promise<void> {
	const region = resource.region;
	if (!region) {
		throw new Error(
			`aws reclaim: ${resource.kind} ${resource.native_id} has no region`,
		);
	}

	const identity = await identityFor(identityId);
	const session = await assumeAwsRole(identity, { purpose: "reclaim" });
	const credentials = session.credentials;
	const id = resource.native_id;

	try {
		switch (resource.kind) {
			case KIND.eksNodegroup: {
				// native_id is "<cluster>:<nodegroup>" (aws_eks_node_group.id). Split it back apart.
				const separator = id.indexOf(":");
				if (separator <= 0) {
					throw new Error(`aws reclaim: malformed node group id ${id}`);
				}
				await eksFor(region, credentials).send(
					new DeleteNodegroupCommand({
						clusterName: id.slice(0, separator),
						nodegroupName: id.slice(separator + 1),
					}),
				);
				break;
			}
			case KIND.eksCluster:
				// native_id is the cluster name, which is what DeleteCluster takes.
				await eksFor(region, credentials).send(
					new DeleteClusterCommand({ name: id }),
				);
				break;
			case KIND.loadBalancer:
				await elbFor(region, credentials).send(
					new DeleteLoadBalancerCommand({ LoadBalancerArn: id }),
				);
				break;
			case KIND.instance:
				await ec2For(region, credentials).send(
					new TerminateInstancesCommand({ InstanceIds: [id] }),
				);
				break;
			case KIND.volume:
				await ec2For(region, credentials).send(
					new DeleteVolumeCommand({ VolumeId: id }),
				);
				break;
			case KIND.natGateway:
				await ec2For(region, credentials).send(
					new DeleteNatGatewayCommand({ NatGatewayId: id }),
				);
				break;
			case KIND.elasticIp:
				await ec2For(region, credentials).send(
					new ReleaseAddressCommand({ AllocationId: id }),
				);
				break;
			case KIND.securityGroup:
				await ec2For(region, credentials).send(
					new DeleteSecurityGroupCommand({ GroupId: id }),
				);
				break;
			case KIND.subnet:
				await ec2For(region, credentials).send(
					new DeleteSubnetCommand({ SubnetId: id }),
				);
				break;
			case KIND.vpc:
				await ec2For(region, credentials).send(
					new DeleteVpcCommand({ VpcId: id }),
				);
				break;
			default:
				throw new Error(`aws reclaim: unknown kind ${resource.kind}`);
		}
	} catch (err) {
		if (isAlreadyGone(err)) return;
		throw err;
	}
}

export const awsReclaim: ReclaimAdapter = {
	provider: "aws",
	list,
	delete: remove,
	// Most-dependent FIRST.
	//  - node groups lead: deleting one drains and terminates its own EC2 instances and releases their
	//    ENIs, which is what actually unblocks the security groups and subnets further down.
	//  - load balancers next: they hold ENIs in the subnets, and an orphaned Service of type
	//    LoadBalancer is exactly how one gets left behind.
	//  - loose instances (anything not owned by a node group) after those.
	//  - the EKS cluster only AFTER its node groups (AWS refuses otherwise), but before the network.
	//  - then the NAT gateway, the EIP it holds, detached volumes, and finally SG → subnet → VPC.
	deleteOrder: [
		KIND.eksNodegroup,
		KIND.loadBalancer,
		KIND.instance,
		KIND.eksCluster,
		KIND.natGateway,
		KIND.elasticIp,
		KIND.volume,
		KIND.securityGroup,
		KIND.subnet,
		KIND.vpc,
	],
};
