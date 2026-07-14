// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Drift attribution: a drifted OpenTofu resource has to find the canvas card that designed it.
// The rule these tests defend is the honest one — drift we can't confidently place is NEVER silently
// dropped, it rolls up to the environment. A wrong "this database drifted" badge is worse than an
// honest "2 resources drifted, unattributed".

import { describe, expect, it } from "vitest";
import {
	attributeDrift,
	kindForResourceType,
	type DriftTarget,
} from "@/lib/canvas/drift-map";
import type { DriftDetail } from "@/types/jsonb.types";

const detail = (address: string, type: string): DriftDetail => ({
	address,
	type,
	kind: "modified",
});

describe("kindForResourceType", () => {
	it("maps each cloud's real resources onto the right node kind", () => {
		expect(kindForResourceType("aws_rds_cluster")).toBe("database");
		expect(kindForResourceType("google_sql_database_instance")).toBe("database");
		expect(kindForResourceType("azurerm_postgresql_flexible_server")).toBe("database");
		expect(kindForResourceType("alicloud_db_instance")).toBe("database");

		expect(kindForResourceType("aws_eks_cluster")).toBe("cluster");
		expect(kindForResourceType("google_container_node_pool")).toBe("cluster");
		expect(kindForResourceType("azurerm_kubernetes_cluster")).toBe("cluster");

		expect(kindForResourceType("aws_elasticache_replication_group")).toBe("cache");
		expect(kindForResourceType("aws_s3_bucket")).toBe("bucket");
		expect(kindForResourceType("aws_sqs_queue")).toBe("queue");
		expect(kindForResourceType("google_pubsub_topic")).toBe("topic");
		expect(kindForResourceType("aws_dynamodb_table")).toBe("nosql");
		expect(kindForResourceType("aws_secretsmanager_secret")).toBe("secret");
		expect(kindForResourceType("aws_ecr_repository")).toBe("registry");
		expect(kindForResourceType("aws_route53_record")).toBe("dns");
		expect(kindForResourceType("aws_vpc")).toBe("network");
	});

	it("prefers the longest matching prefix (elasticache is a cache, not an aws_e… anything)", () => {
		// `aws_elasticache_` must win over any shorter aws_ prefix that might be added later.
		expect(kindForResourceType("aws_elasticache_cluster")).toBe("cache");
	});

	it("returns null for a resource type it doesn't know", () => {
		expect(kindForResourceType("aws_msk_cluster")).toBeNull();
		expect(kindForResourceType("some_provider_thing")).toBeNull();
	});
});

describe("attributeDrift", () => {
	const singletons: DriftTarget[] = [
		{ key: "network", kind: "network" },
		{ key: "cluster", kind: "cluster" },
	];

	it("places a singleton kind's drift with no ambiguity", () => {
		const { byKey, unattributed } = attributeDrift(
			[detail("aws_vpc.main", "aws_vpc")],
			singletons,
		);
		expect(byKey.get("network")).toHaveLength(1);
		expect(unattributed).toHaveLength(0);
	});

	it("places drift on the only node of its kind, even when the address names nothing we know", () => {
		const targets: DriftTarget[] = [{ key: "database:orders", kind: "database", name: "orders" }];
		const { byKey, unattributed } = attributeDrift(
			[detail("module.db.aws_rds_cluster.this", "aws_rds_cluster")],
			targets,
		);
		expect(byKey.get("database:orders")).toHaveLength(1);
		expect(unattributed).toHaveLength(0);
	});

	it("narrows among several nodes of a kind by the name in the address", () => {
		const targets: DriftTarget[] = [
			{ key: "database:orders", kind: "database", name: "orders" },
			{ key: "database:analytics", kind: "database", name: "analytics" },
		];
		const { byKey, unattributed } = attributeDrift(
			[detail("aws_db_instance.analytics", "aws_db_instance")],
			targets,
		);
		expect(byKey.get("database:analytics")).toHaveLength(1);
		expect(byKey.has("database:orders")).toBe(false);
		expect(unattributed).toHaveLength(0);
	});

	it("matches on a whole token, so `orders` does not claim `orders-replica`", () => {
		const targets: DriftTarget[] = [
			{ key: "database:orders", kind: "database", name: "orders" },
			{ key: "database:orders-replica", kind: "database", name: "orders-replica" },
		];
		const { byKey } = attributeDrift(
			[detail("aws_db_instance.orders-replica", "aws_db_instance")],
			targets,
		);
		expect(byKey.get("database:orders-replica")).toHaveLength(1);
		expect(byKey.has("database:orders")).toBe(false);
	});

	it("handles the module/quoted address shapes Terraform actually emits", () => {
		const targets: DriftTarget[] = [
			{ key: "database:orders", kind: "database", name: "orders" },
			{ key: "database:analytics", kind: "database", name: "analytics" },
		];
		const { byKey } = attributeDrift(
			[detail('module.db["orders"].aws_db_instance.this', "aws_db_instance")],
			targets,
		);
		expect(byKey.get("database:orders")).toHaveLength(1);
	});

	// ── the honesty rules ───────────────────────────────────────────────────
	it("rolls up an UNKNOWN resource type rather than dropping it", () => {
		const { byKey, unattributed } = attributeDrift(
			[detail("aws_msk_cluster.events", "aws_msk_cluster")],
			singletons,
		);
		expect(byKey.size).toBe(0);
		expect(unattributed).toHaveLength(1);
	});

	it("rolls up AMBIGUOUS drift rather than guessing a node", () => {
		// Two databases, and an address that names neither — attributing it to one would be a lie.
		const targets: DriftTarget[] = [
			{ key: "database:orders", kind: "database", name: "orders" },
			{ key: "database:analytics", kind: "database", name: "analytics" },
		];
		const { byKey, unattributed } = attributeDrift(
			[detail("aws_db_instance.this", "aws_db_instance")],
			targets,
		);
		expect(byKey.size).toBe(0);
		expect(unattributed).toHaveLength(1);
	});

	it("rolls up drift for a kind that has no node on the canvas at all", () => {
		const { unattributed } = attributeDrift(
			[detail("aws_s3_bucket.leftover", "aws_s3_bucket")],
			singletons, // no bucket node
		);
		expect(unattributed).toHaveLength(1);
	});

	it("never loses a resource: every detail is either attributed or rolled up", () => {
		const targets: DriftTarget[] = [
			{ key: "cluster", kind: "cluster" },
			{ key: "database:orders", kind: "database", name: "orders" },
			{ key: "database:analytics", kind: "database", name: "analytics" },
		];
		const details = [
			detail("aws_eks_cluster.main", "aws_eks_cluster"),
			detail("aws_db_instance.orders", "aws_db_instance"),
			detail("aws_db_instance.this", "aws_db_instance"), // ambiguous
			detail("aws_msk_cluster.events", "aws_msk_cluster"), // unknown
		];
		const { byKey, unattributed } = attributeDrift(details, targets);
		const attributed = [...byKey.values()].reduce((n, list) => n + list.length, 0);
		expect(attributed + unattributed.length).toBe(details.length);
	});
});
