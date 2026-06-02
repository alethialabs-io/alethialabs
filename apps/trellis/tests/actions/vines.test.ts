import { describe, expect, it } from "vitest";
import type { VineFormData } from "@/lib/validations/vine-form.schema";
import { vineFormSchema } from "@/lib/validations/vine-form.schema";

function buildValidFormData(overrides?: Partial<VineFormData>): VineFormData {
	return {
		vine: {
			project_name: "test-project",
			vineyard_id: "550e8400-e29b-41d4-a716-446655440000",
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
	} as VineFormData;
}

describe("CreateVineInput shape validation", () => {
	it("valid form data passes schema", () => {
		const data = buildValidFormData();
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with databases passes schema", () => {
		const data = buildValidFormData({
			databases: [
				{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4, port: 5432, iam_auth: false },
				{ name: "analytics", engine: "aurora-postgresql", min_capacity: 1, max_capacity: 8 },
			],
		});
		const result = vineFormSchema.safeParse(data);
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
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with queues and topics passes schema", () => {
		const data = buildValidFormData({
			queues: [{ name: "email-queue", fifo: false, visibility_timeout: 30 }],
			topics: [{ name: "user-events", subscriptions: [] }],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with dynamodb tables passes schema", () => {
		const data = buildValidFormData({
			nosql_tables: [
				{
					name: "users",
					hash_key: "id",
					hash_key_type: "S",
					table_type: "standard",
					billing_mode: "PAY_PER_REQUEST",
					point_in_time_recovery: true,
				},
			],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("form data with secrets passes schema", () => {
		const data = buildValidFormData({
			secrets: [
				{ name: "postgres-password", generate: true, length: 32, special_chars: true },
				{ name: "api-token", generate: true, length: 48, special_chars: false },
			],
		});
		const result = vineFormSchema.safeParse(data);
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
			nosql_tables: [{ name: "ddb-1", hash_key: "id" }],
			secrets: [{ name: "s-1", generate: true, length: 32 }],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(true);
	});
});

describe("CreateVineInput → server action mapping", () => {
	it("vine fields map to vines table insert", () => {
		const data = buildValidFormData();
		const parsed = vineFormSchema.parse(data);

		expect(parsed.vine.project_name).toBe("test-project");
		expect(parsed.vine.environment_stage).toBe("development");
		expect(parsed.vine.region).toBe("eu-west-1");
		expect(parsed.vine.terraform_version).toBe("1.11.4");
		expect(parsed.vine.vineyard_id).toBe("550e8400-e29b-41d4-a716-446655440000");
		expect(parsed.vine.cloud_identity_id).toBe("660e8400-e29b-41d4-a716-446655440000");
	});

	it("vpc fields map to vine_network table insert", () => {
		const data = buildValidFormData();
		const parsed = vineFormSchema.parse(data);

		expect(parsed.network.provision_network).toBe(true);
		expect(parsed.network.cidr_block).toBe("10.0.0.0/16");
		expect(parsed.network.single_nat_gateway).toBe(true);
	});

	it("eks fields map to vine_cluster table insert", () => {
		const data = buildValidFormData();
		const parsed = vineFormSchema.parse(data);

		expect(parsed.cluster.cluster_version).toBe("1.32");
		expect(parsed.cluster.provider_config?.enable_karpenter).toBe(true);
		expect(parsed.cluster.instance_types).toEqual(["t3.medium"]);
		expect(parsed.cluster.node_min_size).toBe(2);
		expect(parsed.cluster.node_desired_size).toBe(2);
		expect(parsed.cluster.node_max_size).toBe(5);
		expect(parsed.cluster.cluster_admins).toEqual([{ username: "admin@example.com", groups: ["system:masters"] }]);
	});

	it("dns fields map to vine_dns table insert", () => {
		const data = buildValidFormData({
			dns: {
				enabled: true,
				zone_id: "Z123",
				domain_name: "example.com",
				provider_config: { acm_certificate: true, cloudfront_waf: true, application_waf: false },
			} as any,
		});
		const parsed = vineFormSchema.parse(data);

		expect(parsed.dns.enabled).toBe(true);
		expect(parsed.dns.zone_id).toBe("Z123");
		expect(parsed.dns.domain_name).toBe("example.com");
		expect(parsed.dns.provider_config?.acm_certificate).toBe(true);
		expect(parsed.dns.provider_config?.cloudfront_waf).toBe(true);
		expect(parsed.dns.provider_config?.application_waf).toBe(false);
	});

	it("repositories fields map to vine_repositories table insert", () => {
		const data = buildValidFormData({
			repositories: {
				apps_destination_repo: "git@github.com:org/apps-repo.git",
			} as any,
		});
		const parsed = vineFormSchema.parse(data);

		expect(parsed.repositories.apps_destination_repo).toBe("git@github.com:org/apps-repo.git");
	});

	it("omits auto-generated fields", () => {
		const data = buildValidFormData();
		const parsed = vineFormSchema.parse(data);

		expect(parsed.vine).not.toHaveProperty("id");
		expect(parsed.vine).not.toHaveProperty("user_id");
		expect(parsed.vine).not.toHaveProperty("status");
		expect(parsed.vine).not.toHaveProperty("created_at");
		expect(parsed.vine).not.toHaveProperty("updated_at");
		expect(parsed.vine).not.toHaveProperty("estimated_monthly_cost");
		expect(parsed.network).not.toHaveProperty("vine_id");
		expect(parsed.network).not.toHaveProperty("status");
		expect(parsed.cluster).not.toHaveProperty("cluster_name");
		expect(parsed.cluster).not.toHaveProperty("cluster_endpoint");
	});
});

describe("Validation edge cases", () => {
	it("rejects when vine is missing entirely", () => {
		const result = vineFormSchema.safeParse({ vpc: {}, cluster: {}, dns: {}, repositories: {} });
		expect(result.success).toBe(false);
	});

	it("rejects invalid environment_stage", () => {
		const data = buildValidFormData();
		(data.vine as any).environment_stage = "invalid";
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid cache engine", () => {
		const data = buildValidFormData({
			caches: [{ name: "test", engine: "memcached" as any }],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid dynamodb key type", () => {
		const data = buildValidFormData({
			nosql_tables: [{ name: "test", hash_key: "id", hash_key_type: "X" as any }],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid dynamodb billing mode", () => {
		const data = buildValidFormData({
			nosql_tables: [{ name: "test", hash_key: "id", billing_mode: "INVALID" as any }],
		});
		const result = vineFormSchema.safeParse(data);
		expect(result.success).toBe(false);
	});
});
