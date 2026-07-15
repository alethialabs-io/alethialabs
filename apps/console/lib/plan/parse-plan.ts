// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

export interface PlanResource {
	address: string;
	type: string;
	name: string;
	action: "create" | "update" | "delete" | "no-op" | "replace";
	category: string;
	displayName: string;
	iconName: string;
	properties: Record<string, { value: unknown; computed: boolean }>;
}

export interface PlanSummary {
	resources: PlanResource[];
	counts: { create: number; update: number; delete: number; replace: number };
}

interface ResourceMeta {
	category: string;
	displayName: string;
	iconName: string;
}

const RESOURCE_MAP: Record<string, ResourceMeta> = {
	aws_vpc: { category: "Networking", displayName: "VPC", iconName: "Network" },
	aws_subnet: {
		category: "Networking",
		displayName: "Subnet",
		iconName: "GitBranch",
	},
	aws_nat_gateway: {
		category: "Networking",
		displayName: "NAT Gateway",
		iconName: "ArrowUpRight",
	},
	aws_internet_gateway: {
		category: "Networking",
		displayName: "Internet Gateway",
		iconName: "Globe",
	},
	aws_route_table: {
		category: "Networking",
		displayName: "Route Table",
		iconName: "Route",
	},
	aws_route_table_association: {
		category: "Networking",
		displayName: "Route Association",
		iconName: "Link",
	},
	aws_eip: {
		category: "Networking",
		displayName: "Elastic IP",
		iconName: "MapPin",
	},
	aws_security_group: {
		category: "Security",
		displayName: "Security Group",
		iconName: "Shield",
	},
	aws_security_group_rule: {
		category: "Security",
		displayName: "SG Rule",
		iconName: "ShieldCheck",
	},
	aws_iam_role: {
		category: "Security",
		displayName: "IAM Role",
		iconName: "KeyRound",
	},
	aws_iam_role_policy_attachment: {
		category: "Security",
		displayName: "Policy Attachment",
		iconName: "Paperclip",
	},
	aws_iam_policy: {
		category: "Security",
		displayName: "IAM Policy",
		iconName: "FileKey",
	},
	aws_eks_cluster: {
		category: "Compute",
		displayName: "EKS Cluster",
		iconName: "Server",
	},
	aws_eks_node_group: {
		category: "Compute",
		displayName: "Node Group",
		iconName: "Cpu",
	},
	aws_eks_addon: {
		category: "Compute",
		displayName: "EKS Addon",
		iconName: "Puzzle",
	},
	aws_launch_template: {
		category: "Compute",
		displayName: "Launch Template",
		iconName: "FileCode",
	},
	aws_rds_cluster: {
		category: "Database",
		displayName: "Aurora Cluster",
		iconName: "Database",
	},
	aws_rds_cluster_instance: {
		category: "Database",
		displayName: "DB Instance",
		iconName: "HardDrive",
	},
	aws_db_subnet_group: {
		category: "Database",
		displayName: "DB Subnet Group",
		iconName: "Layers",
	},
	aws_elasticache_cluster: {
		category: "Cache",
		displayName: "ElastiCache",
		iconName: "Zap",
	},
	aws_elasticache_replication_group: {
		category: "Cache",
		displayName: "ElastiCache Replication",
		iconName: "Zap",
	},
	aws_elasticache_subnet_group: {
		category: "Cache",
		displayName: "Cache Subnet Group",
		iconName: "Layers",
	},
	aws_sqs_queue: {
		category: "Messaging",
		displayName: "SQS Queue",
		iconName: "MessageSquare",
	},
	aws_sns_topic: {
		category: "Messaging",
		displayName: "SNS Topic",
		iconName: "Bell",
	},
	aws_dynamodb_table: {
		category: "Database",
		displayName: "DynamoDB Table",
		iconName: "Table",
	},
	aws_secretsmanager_secret: {
		category: "Security",
		displayName: "Secret",
		iconName: "Lock",
	},
	aws_secretsmanager_secret_version: {
		category: "Security",
		displayName: "Secret Version",
		iconName: "Lock",
	},
	aws_route53_zone: {
		category: "DNS",
		displayName: "Hosted Zone",
		iconName: "Globe",
	},
	aws_route53_record: {
		category: "DNS",
		displayName: "DNS Record",
		iconName: "FileText",
	},
	aws_acm_certificate: {
		category: "DNS",
		displayName: "ACM Certificate",
		iconName: "ShieldCheck",
	},
	aws_acm_certificate_validation: {
		category: "DNS",
		displayName: "Cert Validation",
		iconName: "CheckCircle",
	},
	aws_cloudfront_distribution: {
		category: "CDN",
		displayName: "CloudFront",
		iconName: "Cloud",
	},
	aws_wafv2_web_acl: {
		category: "Security",
		displayName: "WAF ACL",
		iconName: "ShieldAlert",
	},
	aws_ecr_repository: {
		category: "Container",
		displayName: "ECR Repository",
		iconName: "Container",
	},
	aws_s3_bucket: {
		category: "Storage",
		displayName: "S3 Bucket",
		iconName: "FolderArchive",
	},
	aws_cloudwatch_log_group: {
		category: "Observability",
		displayName: "Log Group",
		iconName: "ScrollText",
	},
};

// The slice of the OpenTofu `plan -json` we render. Every level is lenient (`.catch`) so a
// truncated or unexpected plan never throws — it degrades to "no changes". `after`/
// `after_unknown` stay `unknown`-valued: OpenTofu nests arbitrary attribute shapes there,
// and `extractProperties` reads them defensively (scalars only, truthy = computed).
const planChangeSchema = z
	.object({
		actions: z.array(z.string()).catch([]),
		after: z.record(z.string(), z.unknown()).catch({}),
		after_unknown: z.record(z.string(), z.unknown()).catch({}),
	})
	.catch({ actions: [], after: {}, after_unknown: {} });

type PlanChange = z.infer<typeof planChangeSchema>;

const planJsonSchema = z
	.object({
		resource_changes: z
			.array(
				z.object({
					type: z.string().catch(""),
					name: z.string().catch(""),
					address: z.string().catch(""),
					change: planChangeSchema,
				}),
			)
			.catch([]),
	})
	.catch({ resource_changes: [] });

/** The plan action a resource_changes entry resolves to. Exported so the BYO-IaC inventory
 * (lib/canvas/iac-inventory.ts) resolves actions through the SAME ladder rather than
 * growing a second, drifting copy of it. */
export function resolveAction(
	actions: string[],
): PlanResource["action"] {
	if (!actions || actions.length === 0) return "no-op";
	if (actions.includes("create") && actions.includes("delete"))
		return "replace";
	if (actions.includes("create")) return "create";
	if (actions.includes("update")) return "update";
	if (actions.includes("delete")) return "delete";
	return "no-op";
}

function extractProperties(change: PlanChange): PlanResource["properties"] {
	const after = change.after;
	const afterUnknown = change.after_unknown;
	const props: PlanResource["properties"] = {};

	const SKIP_KEYS = new Set([
		"id",
		"arn",
		"tags_all",
		"owner_id",
		"self_managed_event_source",
	]);

	for (const [key, value] of Object.entries(after)) {
		if (SKIP_KEYS.has(key)) continue;
		if (value === null || value === undefined) continue;
		if (typeof value === "object" && !Array.isArray(value)) continue;
		props[key] = {
			value,
			computed: !!afterUnknown[key],
		};
	}

	return props;
}

export function parsePlanJSON(
	planResult: Record<string, unknown>,
): PlanSummary {
	const { resource_changes } = planJsonSchema.parse(planResult);

	const counts = { create: 0, update: 0, delete: 0, replace: 0 };
	const resources: PlanResource[] = [];

	for (const rc of resource_changes) {
		const action = resolveAction(rc.change.actions);

		if (action === "no-op") continue;

		const type = rc.type;
		const meta = RESOURCE_MAP[type] || {
			category: "Other",
			displayName: type.replace(/^aws_/, "").replaceAll("_", " "),
			iconName: "Box",
		};

		resources.push({
			address: rc.address,
			type,
			name: rc.name,
			action,
			category: meta.category,
			displayName: meta.displayName,
			iconName: meta.iconName,
			properties: extractProperties(rc.change),
		});

		counts[action]++;
	}

	resources.sort((a, b) => {
		const catOrder = a.category.localeCompare(b.category);
		if (catOrder !== 0) return catOrder;
		return a.displayName.localeCompare(b.displayName);
	});

	return { resources, counts };
}

export function groupByCategory(
	resources: PlanResource[],
): Map<string, PlanResource[]> {
	const groups = new Map<string, PlanResource[]>();
	for (const r of resources) {
		const list = groups.get(r.category) || [];
		list.push(r);
		groups.set(r.category, list);
	}
	return groups;
}
