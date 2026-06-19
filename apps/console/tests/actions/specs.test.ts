// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";
import { specFormSchema } from "@/lib/validations/spec-form.schema";

function buildValidFormData(overrides?: Partial<SpecFormData>): SpecFormData {
	return {
		spec: {
			project_name: "test-project",
			zone_id: "550e8400-e29b-41d4-a716-446655440000",
			environment_stage: "development",
			region: "eu-west-1",
			cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
			terraform_version: "1.11.4",
		},
		network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
		cluster: {
			cluster_version: "1.32",
			provider_config: { enable_karpenter: true },
			instance_types: ["t3.medium"],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [{ username: "admin@example.com", groups: ["system:masters"] }],
		},
		dns: { enabled: false },
		repositories: {},
		databases: [],
		caches: [],
		queues: [],
		topics: [],
		nosql_tables: [],
		secrets: [],
		...overrides,
	} as SpecFormData;
}

describe("CreateSpecInput shape validation", () => {
	it("valid form data passes schema", () => {
		const data = buildValidFormData();
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with databases passes schema", () => {
		const data = buildValidFormData({
			databases: [
				{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4, port: 5432, iam_auth: false },
				{ name: "analytics", engine: "aurora-postgresql", min_capacity: 1, max_capacity: 8 },
			],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.databases).toHaveLength(2);
		}
	});

	it("form data with caches passes schema", () => {
		const data = buildValidFormData({
			caches: [
				{ name: "primary", engine: "redis", node_type: "cache.t3.medium", num_cache_nodes: 1, multi_az: false },
			],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with queues and topics passes schema", () => {
		const data = buildValidFormData({
			queues: [{ name: "email-queue", fifo: false, visibility_timeout: 30 }],
			topics: [{ name: "user-events", subscriptions: [] }],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with dynamodb tables passes schema", () => {
		const data = buildValidFormData({
			nosql_tables: [
				{
					name: "users",
					partition_key: "id",
					partition_key_type: "S",
					table_type: "standard",
					capacity_mode: "on_demand",
					point_in_time_recovery: true,
				},
			],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with secrets passes schema", () => {
		const data = buildValidFormData({
			secrets: [
				{ name: "postgres-password", generate: true, length: 32, special_chars: true },
				{ name: "api-token", generate: true, length: 48, special_chars: false },
			],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.secrets).toHaveLength(2);
		}
	});

	it("form data with all components populated passes schema", () => {
		const data = buildValidFormData({
			databases: [{ name: "db-1", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4 }],
			caches: [{ name: "cache-1", engine: "redis", node_type: "cache.t3.medium", num_cache_nodes: 1 }],
			queues: [{ name: "q-1", fifo: false, visibility_timeout: 30 }],
			topics: [{ name: "t-1" }],
			nosql_tables: [{ name: "ddb-1", partition_key: "id" }],
			secrets: [{ name: "s-1", generate: true, length: 32 }],
		});
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});
});

describe("CreateSpecInput → server action mapping", () => {
	it("spec fields map to specs table insert", () => {
		const data = buildValidFormData();
		const parsed = specFormSchema.parse(data);

		expect(parsed.spec.project_name).toBe("test-project");
		expect(parsed.spec.environment_stage).toBe("development");
		expect(parsed.spec.region).toBe("eu-west-1");
		expect(parsed.spec.terraform_version).toBe("1.11.4");
		expect(parsed.spec.zone_id).toBe("550e8400-e29b-41d4-a716-446655440000");
		expect(parsed.spec.cloud_identity_id).toBe("660e8400-e29b-41d4-a716-446655440000");
	});

	it("vpc fields map to spec_network table insert", () => {
		const data = buildValidFormData();
		const parsed = specFormSchema.parse(data);

		expect(parsed.network.provision_network).toBe(true);
		expect(parsed.network.cidr_block).toBe("10.0.0.0/16");
		expect(parsed.network.single_nat_gateway).toBe(true);
	});

	it("eks fields map to spec_cluster table insert", () => {
		const data = buildValidFormData();
		const parsed = specFormSchema.parse(data);

		expect(parsed.cluster.cluster_version).toBe("1.32");
		expect(parsed.cluster.provider_config?.enable_karpenter).toBe(true);
		expect(parsed.cluster.instance_types).toEqual(["t3.medium"]);
		expect(parsed.cluster.node_min_size).toBe(2);
		expect(parsed.cluster.node_desired_size).toBe(2);
		expect(parsed.cluster.node_max_size).toBe(5);
		expect(parsed.cluster.cluster_admins).toEqual([{ username: "admin@example.com", groups: ["system:masters"] }]);
	});

	it("dns fields map to spec_dns table insert", () => {
		const data = buildValidFormData({
			dns: {
				enabled: true,
				zone_id: "Z123",
				domain_name: "example.com",
				provider_config: { acm_certificate: true, cloudfront_waf: true, application_waf: false },
			},
		});
		const parsed = specFormSchema.parse(data);

		expect(parsed.dns.enabled).toBe(true);
		expect(parsed.dns.zone_id).toBe("Z123");
		expect(parsed.dns.domain_name).toBe("example.com");
		expect(parsed.dns.provider_config?.acm_certificate).toBe(true);
		expect(parsed.dns.provider_config?.cloudfront_waf).toBe(true);
		expect(parsed.dns.provider_config?.application_waf).toBe(false);
	});

	it("repositories fields map to spec_repositories table insert", () => {
		const data = buildValidFormData({
			repositories: {
				apps_destination_repo: "git@github.com:org/apps-repo.git",
			},
		});
		const parsed = specFormSchema.parse(data);

		expect(parsed.repositories.apps_destination_repo).toBe("git@github.com:org/apps-repo.git");
	});

	it("omits auto-generated fields", () => {
		const data = buildValidFormData();
		const parsed = specFormSchema.parse(data);

		expect(parsed.spec).not.toHaveProperty("id");
		expect(parsed.spec).not.toHaveProperty("user_id");
		expect(parsed.spec).not.toHaveProperty("status");
		expect(parsed.spec).not.toHaveProperty("created_at");
		expect(parsed.spec).not.toHaveProperty("updated_at");
		expect(parsed.spec).not.toHaveProperty("estimated_monthly_cost");
		expect(parsed.network).not.toHaveProperty("spec_id");
		expect(parsed.network).not.toHaveProperty("status");
		expect(parsed.cluster).not.toHaveProperty("cluster_name");
		expect(parsed.cluster).not.toHaveProperty("cluster_endpoint");
	});
});

describe("Validation edge cases", () => {
	it("rejects when spec is missing entirely", () => {
		const result = specFormSchema.safeParse({ vpc: {}, cluster: {}, dns: {}, repositories: {} });
		expect(result.success).toBe(false);
	});

	it("rejects invalid environment_stage", () => {
		const data = buildValidFormData();
		const invalid = { ...data, spec: { ...data.spec, environment_stage: "invalid" } };
		const result = specFormSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it("rejects invalid cache engine", () => {
		const data = {
			...buildValidFormData(),
			caches: [{ name: "test", engine: "memcached" }],
		};
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid dynamodb key type", () => {
		const data = {
			...buildValidFormData(),
			nosql_tables: [{ name: "test", partition_key: "id", partition_key_type: "X" }],
		};
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid dynamodb billing mode", () => {
		const data = {
			...buildValidFormData(),
			nosql_tables: [{ name: "test", partition_key: "id", capacity_mode: "INVALID" }],
		};
		const result = specFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});
});
