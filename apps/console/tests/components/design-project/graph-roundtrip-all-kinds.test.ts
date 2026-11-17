// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The save path's projection, pinned for EVERY design kind at once (#6762).
//
// A canvas save is `projectFormSchema.parse(graphToForm(nodes))` followed by a delete-then-insert of
// the environment's components, so a kind that `graphToForm` stops emitting is not an error — it is
// rows that quietly leave on the next save. `graph-mapping.test.ts` pins that kind by kind, from a
// form. This file comes at it from the other side: one hand-built node of every design kind, and
// the WHOLE parsed form compared with a fixture.
//
// The fixture (`tests/fixtures/canvas/all-kinds.form.json`) is typed by hand. It is not a capture
// of `graphToForm`'s output, so a change to the projection cannot move the expectation with it.

import { describe, expect, it } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { formToGraph } from "@/components/design-project/canvas/graph/form-to-graph";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { OUT_OF_BAND, PROJECT_NODE_ID } from "@/lib/stores/use-canvas-store";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import allKindsForm from "@/tests/fixtures/canvas/all-kinds.form.json";

/** The project's own cloud identity (the CORE every node inherits). */
const CORE_IDENTITY = "5b1f0c9e-2a3d-4e6f-8a7b-1c2d3e4f5a6b";
/** A second identity, so one node carries a placement of its own. */
const OTHER_IDENTITY = "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a";

const IDENTITIES: CloudIdentityOption[] = [
	{ id: CORE_IDENTITY, name: "prod", displayId: "111122223333", provider: "aws" },
	{ id: OTHER_IDENTITY, name: "data", displayId: "444455556666", provider: "aws" },
];

/** One node of every design kind, each config written out by hand. */
function allKindsGraph(): CanvasNode[] {
	return [
		{
			id: PROJECT_NODE_ID,
			type: "project",
			position: { x: 260, y: 0 },
			deletable: false,
			data: {
				kind: "project",
				config: {
					project_name: "Acme Shop",
					environment_stage: "production",
					region: "eu-central-1",
					iac_version: "1.11.4",
					// Scanned source repos ride on the project root and are lifted to the form's top level.
					source_repos: [
						{
							repo_url: "https://github.com/acme/shop",
							ref: "main",
							scan_path: "",
							services: [],
						},
					],
				},
				cloud_identity_id: CORE_IDENTITY,
				provider: "aws",
			},
		},
		{
			id: "network-network",
			type: "network",
			position: { x: 60, y: 180 },
			data: {
				kind: "network",
				config: {
					provision_network: true,
					cidr_block: "10.20.0.0/16",
					single_nat_gateway: false,
					allowed_cidr_blocks: ["203.0.113.0/24"],
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "cluster-cluster",
			type: "cluster",
			position: { x: 360, y: 180 },
			data: {
				kind: "cluster",
				config: {
					cluster_version: "1.31",
					instance_types: ["t3.large"],
					node_min_size: 2,
					node_max_size: 6,
					node_desired_size: 3,
					capacity_type: "on_demand",
					node_disk_size_gb: 50,
					provider_config: { enable_karpenter: true },
					cluster_admins: [{ username: "alice", groups: ["system:masters"] }],
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "dns-dns",
			type: "dns",
			position: { x: 680, y: 180 },
			data: {
				kind: "dns",
				config: {
					enabled: true,
					domain_name: "shop.example.com",
					managed_certificate: true,
					waf_enabled: false,
					provider_config: {},
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "repositories-repositories",
			type: "repositories",
			position: { x: 900, y: 180 },
			data: {
				kind: "repositories",
				config: {
					apps_destination_repo: "https://github.com/acme/apps",
					apps_path: "overlays/prod",
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "database-orders",
			type: "database",
			position: { x: 120, y: 340 },
			data: {
				kind: "database",
				config: {
					name: "orders",
					engine_family: "postgres",
					min_capacity: 0.5,
					max_capacity: 4,
					port: 5432,
					backup_retention_days: 7,
					iam_auth: false,
				},
				// The one node placed on an identity of its own: the form must carry it.
				cloud_identity_id: OTHER_IDENTITY,
				provider: "aws",
			},
		},
		{
			id: "cache-sessions",
			type: "cache",
			position: { x: 120, y: 470 },
			data: {
				kind: "cache",
				config: {
					name: "sessions",
					engine: "redis",
					node_type: "cache.t3.micro",
					num_cache_nodes: 1,
					multi_az: false,
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "queue-jobs",
			type: "queue",
			position: { x: 120, y: 600 },
			data: {
				kind: "queue",
				config: {
					name: "jobs",
					ordered: true,
					visibility_timeout: 45,
					message_retention: 86400,
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "topic-events",
			type: "topic",
			position: { x: 120, y: 730 },
			data: {
				kind: "topic",
				config: {
					name: "events",
					subscriptions: [
						{ protocol: "https", endpoint: "https://hooks.example.com/events" },
					],
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "nosql-ledger",
			type: "nosql",
			position: { x: 120, y: 860 },
			data: {
				kind: "nosql",
				config: {
					name: "ledger",
					partition_key: "account_id",
					partition_key_type: "S",
					sort_key: "posted_at",
					sort_key_type: "N",
					table_type: "standard",
					capacity_mode: "on_demand",
					point_in_time_recovery: true,
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "secret-api-key",
			type: "secret",
			position: { x: 120, y: 990 },
			data: {
				kind: "secret",
				config: {
					name: "api-key",
					generate: true,
					length: 48,
					special_chars: false,
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "bucket-assets",
			type: "bucket",
			position: { x: 120, y: 1120 },
			data: {
				kind: "bucket",
				config: {
					name: "assets",
					versioning: true,
					encryption_enabled: true,
					public_access: false,
					cors_origins: ["https://shop.example.com"],
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "registry-apps",
			type: "registry",
			position: { x: 120, y: 1250 },
			data: {
				kind: "registry",
				config: {
					name: "apps",
					immutable_tags: false,
					vulnerability_scanning: false,
					provider_config: {},
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "helm_registry-ghcr-io",
			type: "helm_registry",
			position: { x: 120, y: 1510 },
			data: {
				kind: "helm_registry",
				config: {
					name: "ghcr-io",
					provider: "oci-github-cr",
					provider_config: {},
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
		{
			id: "service-api",
			type: "service",
			position: { x: 120, y: 1380 },
			data: {
				kind: "service",
				config: {
					name: "api",
					type: "deployment",
					source: {
						kind: "repo",
						repo_url: "https://github.com/acme/shop",
						path: "apps/api",
					},
					env: [{ name: "LOG_LEVEL", value: "info" }],
					bindings: [
						{
							target: { kind: "database", name: "orders" },
							inject: [
								{ env: "DATABASE_HOST", from: "endpoint" },
								{ env: "DATABASE_PASSWORD", from: "password" },
							],
						},
					],
					ports: [{ container_port: 8080, protocol: "TCP" }],
					replicas: 3,
				},
				cloud_identity_id: null,
				provider: "aws",
			},
		},
	];
}

/** The kinds on a graph, sorted, as plain strings. */
function kindsOf(nodes: CanvasNode[]): string[] {
	return nodes.map((n) => n.data.kind).sort();
}

/** Every kind the design owns: the registry's kinds minus the ones persisted out-of-band. */
function designKinds(): string[] {
	const outOfBand = new Set<string>(OUT_OF_BAND);
	return Object.keys(NODE_REGISTRY)
		.filter((kind) => !outOfBand.has(kind))
		.sort();
}

describe("the all-kinds graph", () => {
	it("holds exactly one node of every design kind the registry knows", () => {
		// A design kind added to the registry and not to this file fails here, before it can pass
		// the round-trip below by simply being absent from both sides.
		expect(kindsOf(allKindsGraph())).toEqual(designKinds());
	});
});

describe("graphToForm over one node of every design kind", () => {
	it("parses to the hand-written form", () => {
		const parsed = projectFormSchema.parse(graphToForm(allKindsGraph()));
		expect(parsed).toEqual(allKindsForm);
	});

	it("the hand-written form is its own parse, so the schema adds and strips nothing in it", () => {
		expect(projectFormSchema.parse(allKindsForm)).toEqual(allKindsForm);
	});
});

describe("formToGraph then graphToForm", () => {
	it("is idempotent on the hand-written form", () => {
		const form = projectFormSchema.parse(allKindsForm);
		const { nodes } = formToGraph(form, IDENTITIES);
		expect(projectFormSchema.parse(graphToForm(nodes))).toEqual(allKindsForm);
	});

	it("draws one node of every design kind from it", () => {
		const form = projectFormSchema.parse(allKindsForm);
		expect(kindsOf(formToGraph(form, IDENTITIES).nodes)).toEqual(designKinds());
	});

	it("is idempotent a second time round", () => {
		const first = projectFormSchema.parse(allKindsForm);
		const second = projectFormSchema.parse(
			graphToForm(formToGraph(first, IDENTITIES).nodes),
		);
		const third = projectFormSchema.parse(
			graphToForm(formToGraph(second, IDENTITIES).nodes),
		);
		expect(third).toEqual(second);
	});
});
