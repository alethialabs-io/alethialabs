// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { specFormSchema } from "@/lib/validations/spec-form.schema";

const validSpec = {
	spec: {
		project_name: "my-project",
		zone_id: "550e8400-e29b-41d4-a716-446655440000",
		environment_stage: "development" as const,
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		terraform_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: { cluster_version: "1.32", provider_config: { enable_karpenter: true }, instance_types: ["t3.medium"], node_min_size: 2, node_max_size: 5, node_desired_size: 2 },
	dns: { enabled: false },
	repositories: {},
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
};

describe("specFormSchema", () => {
	describe("spec.project_name", () => {
		it("rejects empty project_name", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name with uppercase", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "MyProject" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name with spaces", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "my project" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name starting with hyphen", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "-my-project" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("accepts valid project_name", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "my-project-123" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects project_name > 25 chars", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, project_name: "a".repeat(26) } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("spec required fields", () => {
		it("rejects empty zone_id", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, zone_id: "" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty region", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, region: "" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty cloud_identity_id", () => {
			const data = { ...validSpec, spec: { ...validSpec.spec, cloud_identity_id: "" } };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("valid full form", () => {
		it("accepts valid spec with all required fields", () => {
			const result = specFormSchema.safeParse(validSpec);
			expect(result.success).toBe(true);
		});

		it("accepts valid spec with optional arrays empty", () => {
			const data = { ...validSpec, databases: [], caches: [], queues: [], topics: [], nosql_tables: [], secrets: [] };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("defaults arrays to [] when omitted", () => {
			const data = { spec: validSpec.spec, network: validSpec.network, cluster: validSpec.cluster, dns: validSpec.dns, repositories: validSpec.repositories };
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.databases).toEqual([]);
				expect(result.data.caches).toEqual([]);
				expect(result.data.queues).toEqual([]);
				expect(result.data.topics).toEqual([]);
				expect(result.data.nosql_tables).toEqual([]);
				expect(result.data.secrets).toEqual([]);
			}
		});
	});

	describe("databases array", () => {
		it("accepts databases with valid entries", () => {
			const data = {
				...validSpec,
				databases: [{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4 }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects database with empty name", () => {
			const data = {
				...validSpec,
				databases: [{ name: "", engine: "aurora-postgresql" }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("nosql_tables array", () => {
		it("accepts empty array", () => {
			const result = specFormSchema.safeParse({ ...validSpec, nosql_tables: [] });
			expect(result.success).toBe(true);
		});

		it("accepts valid nosql table", () => {
			const data = {
				...validSpec,
				nosql_tables: [{ name: "users", partition_key: "id", partition_key_type: "S", table_type: "standard", capacity_mode: "on_demand" }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects nosql table without partition_key", () => {
			const data = {
				...validSpec,
				nosql_tables: [{ name: "users" }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("secrets array", () => {
		it("accepts valid secret", () => {
			const data = {
				...validSpec,
				secrets: [{ name: "postgres-password", generate: true, length: 32, special_chars: true }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects secret with empty name", () => {
			const data = {
				...validSpec,
				secrets: [{ name: "" }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("queues and topics", () => {
		it("accepts valid queue", () => {
			const data = {
				...validSpec,
				queues: [{ name: "email-processing", ordered: false, visibility_timeout: 30 }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("accepts valid topic", () => {
			const data = {
				...validSpec,
				topics: [{ name: "user-events", subscriptions: [] }],
			};
			const result = specFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});
	});
});
