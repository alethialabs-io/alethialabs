// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Maps a drifted OpenTofu resource back onto the canvas node that designed it.
//
// `environment_drift.details[]` carries a Terraform ADDRESS (`aws_db_instance.orders`) and a
// resource TYPE (`aws_db_instance`). The canvas thinks in node kinds (`database`), so the type is
// matched to a kind through the table below, then narrowed to a specific node by looking for that
// node's name inside the address.
//
// The rule that matters: a drifted resource is NEVER silently dropped. If it can't be attributed to
// a node (an unknown resource type, or an ambiguous kind with several candidates), it rolls up to
// the ENVIRONMENT and is surfaced there. Drift we can't place is still drift.

import type { DriftDetail } from "@/types/jsonb.types";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";

/**
 * Resource-type prefix → node kind, across all five clouds. Derived from what the per-cloud
 * templates actually provision (infra/templates/project/{aws,gcp,azure,alibaba} + the Hetzner
 * in-cluster charts). Longest prefix wins, so `aws_elasticache_` beats a hypothetical `aws_`.
 */
const TYPE_PREFIX_TO_KIND: Array<[prefix: string, kind: NodeKind]> = [
	// ── cluster ───────────────────────────────────────────────────────────
	["aws_eks_", "cluster"],
	["google_container_", "cluster"],
	["azurerm_kubernetes_", "cluster"],
	["alicloud_cs_", "cluster"],
	["talos_", "cluster"],
	["helm_release", "cluster"], // in-cluster charts (Hetzner data services, add-ons)

	// ── network ───────────────────────────────────────────────────────────
	["aws_vpc", "network"],
	["aws_subnet", "network"],
	["aws_nat_gateway", "network"],
	["aws_internet_gateway", "network"],
	["aws_route_table", "network"],
	["aws_route.", "network"],
	["aws_eip", "network"],
	["aws_security_group", "network"],
	["google_compute_network", "network"],
	["google_compute_subnetwork", "network"],
	["google_compute_router", "network"],
	["google_compute_firewall", "network"],
	["azurerm_virtual_network", "network"],
	["azurerm_subnet", "network"],
	["azurerm_network_security_group", "network"],
	["alicloud_vpc", "network"],
	["alicloud_vswitch", "network"],
	["alicloud_security_group", "network"],
	["hcloud_network", "network"],

	// ── database ──────────────────────────────────────────────────────────
	["aws_rds_", "database"],
	["aws_db_", "database"],
	["google_sql_", "database"],
	["azurerm_postgresql", "database"],
	["azurerm_mysql", "database"],
	["alicloud_db_", "database"],

	// ── cache ─────────────────────────────────────────────────────────────
	["aws_elasticache_", "cache"],
	["google_redis_", "cache"],
	["azurerm_redis_", "cache"],
	["alicloud_kvstore_", "cache"],

	// ── queue ─────────────────────────────────────────────────────────────
	["aws_sqs_", "queue"],
	["azurerm_servicebus_queue", "queue"],
	["alicloud_message_service_queue", "queue"],
	["alicloud_mns_queue", "queue"],

	// ── topic ─────────────────────────────────────────────────────────────
	["aws_sns_", "topic"],
	["google_pubsub_", "topic"],
	["azurerm_servicebus_topic", "topic"],
	["azurerm_servicebus_subscription", "topic"],
	["alicloud_message_service_topic", "topic"],
	["alicloud_mns_topic", "topic"],

	// ── nosql ─────────────────────────────────────────────────────────────
	["aws_dynamodb_", "nosql"],
	["google_firestore_", "nosql"],
	["azurerm_cosmosdb_", "nosql"],
	["alicloud_ots_", "nosql"],

	// ── bucket ────────────────────────────────────────────────────────────
	["aws_s3_", "bucket"],
	["google_storage_bucket", "bucket"],
	["azurerm_storage_", "bucket"],
	["alicloud_oss_bucket", "bucket"],
	["minio_s3_bucket", "bucket"],

	// ── secret ────────────────────────────────────────────────────────────
	["aws_secretsmanager_", "secret"],
	["google_secret_manager_", "secret"],
	["azurerm_key_vault", "secret"],
	["alicloud_kms_", "secret"],
	["random_password", "secret"],

	// ── registry ──────────────────────────────────────────────────────────
	["aws_ecr_", "registry"],
	["google_artifact_registry_", "registry"],
	["azurerm_container_registry", "registry"],
	["alicloud_cr_", "registry"],

	// ── dns (+ certs + WAF, which the DNS node owns) ───────────────────────
	["aws_route53_", "dns"],
	["aws_acm_", "dns"],
	["aws_wafv2_", "dns"],
	["aws_cloudfront_", "dns"],
	["google_dns_", "dns"],
	["google_compute_security_policy", "dns"],
	["azurerm_dns_", "dns"],
	["azurerm_web_application_firewall", "dns"],
	["alicloud_alidns_", "dns"],
	["alicloud_waf_", "dns"],
];

/** The node kind a Terraform resource type belongs to, or null when we don't recognise it. */
export function kindForResourceType(type: string): NodeKind | null {
	let best: { kind: NodeKind; len: number } | null = null;
	for (const [prefix, kind] of TYPE_PREFIX_TO_KIND) {
		if (type.startsWith(prefix) && (!best || prefix.length > best.len)) {
			best = { kind, len: prefix.length };
		}
	}
	return best?.kind ?? null;
}

/** A canvas node reduced to what drift attribution needs. */
export interface DriftTarget {
	/** `nodeStatusKey()`: the kind for singletons, `kind:name` for array kinds. */
	key: string;
	kind: NodeKind;
	/** The resource's own name; undefined for singleton kinds (network/cluster/dns). */
	name?: string;
}

export interface DriftAttribution {
	/** Drifted resources per node key. */
	byKey: Map<string, DriftDetail[]>;
	/** Drift we could not place on a node — surfaced at the environment. Never dropped. */
	unattributed: DriftDetail[];
}

/**
 * Attribute each drifted resource to a canvas node.
 *
 * Narrowing an array kind (which of three databases drifted?) uses the node's name as a token in
 * the Terraform address — `aws_db_instance.orders` → the database named `orders`. When the address
 * names no known node and the kind has exactly ONE candidate, it's that one. Anything still
 * ambiguous or unrecognised rolls up to the environment rather than being attributed to a node it
 * might not belong to — a wrong "this database drifted" badge is worse than an honest
 * "2 resources drifted, unattributed".
 */
export function attributeDrift(
	details: DriftDetail[],
	targets: DriftTarget[],
): DriftAttribution {
	const byKey = new Map<string, DriftDetail[]>();
	const unattributed: DriftDetail[] = [];

	const push = (key: string, detail: DriftDetail) => {
		const list = byKey.get(key);
		if (list) list.push(detail);
		else byKey.set(key, [detail]);
	};

	for (const detail of details) {
		const kind = kindForResourceType(detail.type);
		if (!kind) {
			unattributed.push(detail);
			continue;
		}
		const candidates = targets.filter((t) => t.kind === kind);
		if (candidates.length === 0) {
			unattributed.push(detail);
			continue;
		}
		if (candidates.length === 1) {
			push(candidates[0].key, detail);
			continue;
		}
		// Several nodes of this kind — narrow by name. Match on a word boundary so `orders` doesn't
		// also claim `orders-replica`; prefer the LONGEST matching name for the same reason.
		const named = candidates
			.filter((t) => t.name && addressNamesResource(detail.address, t.name))
			.sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0));
		if (named.length > 0) push(named[0].key, detail);
		else unattributed.push(detail);
	}

	return { byKey, unattributed };
}

/**
 * Whether a Terraform address refers to a resource named `name`. Terraform mangles names into
 * addresses in several shapes (`aws_db_instance.orders`, `module.db["orders"].aws_db_instance.this`,
 * `aws_db_instance.this["orders"]`), so match the name as a whole token — bounded by anything that
 * isn't a name character — rather than as a bare substring, which would let `orders` claim
 * `orders-replica`.
 */
function addressNamesResource(address: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
	return new RegExp(`(^|[^a-zA-Z0-9_-])${escaped}([^a-zA-Z0-9_-]|$)`).test(address);
}
