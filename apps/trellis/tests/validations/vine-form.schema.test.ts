import { describe, it, expect } from "vitest";
import { vineFormSchema, type VineFormData } from "@/lib/validations/vine-form.schema";

const validVine = {
	vine: {
		project_name: "my-project",
		vineyard_id: "550e8400-e29b-41d4-a716-446655440000",
		environment_stage: "development" as const,
		aws_region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		terraform_version: "1.11.4",
	},
	vpc: { provision_vpc: true, vpc_cidr: "10.0.0.0/16", single_nat_gateway: true },
	eks: { cluster_version: "1.32", enable_karpenter: true, instance_types: ["t3.medium"], node_min_size: 2, node_max_size: 5, node_desired_size: 2 },
	dns: { enabled: false },
	repositories: {},
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
};

describe("vineFormSchema", () => {
	describe("vine.project_name", () => {
		it("rejects empty project_name", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name with uppercase", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "MyProject" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name with spaces", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "my project" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name starting with hyphen", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "-my-project" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("accepts valid project_name", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "my-project-123" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects project_name > 25 chars", () => {
			const data = { ...validVine, vine: { ...validVine.vine, project_name: "a".repeat(26) } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("vine required fields", () => {
		it("rejects empty vineyard_id", () => {
			const data = { ...validVine, vine: { ...validVine.vine, vineyard_id: "" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty aws_region", () => {
			const data = { ...validVine, vine: { ...validVine.vine, aws_region: "" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty cloud_identity_id", () => {
			const data = { ...validVine, vine: { ...validVine.vine, cloud_identity_id: "" } };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("valid full form", () => {
		it("accepts valid vine with all required fields", () => {
			const result = vineFormSchema.safeParse(validVine);
			expect(result.success).toBe(true);
		});

		it("accepts valid vine with optional arrays empty", () => {
			const data = { ...validVine, databases: [], caches: [], queues: [], topics: [], nosql_tables: [], secrets: [] };
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("defaults arrays to [] when omitted", () => {
			const data = { vine: validVine.vine, vpc: validVine.vpc, eks: validVine.eks, dns: validVine.dns, repositories: validVine.repositories };
			const result = vineFormSchema.safeParse(data);
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
				...validVine,
				databases: [{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4 }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects database with empty name", () => {
			const data = {
				...validVine,
				databases: [{ name: "", engine: "aurora-postgresql" }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("nosql_tables array", () => {
		it("accepts empty array", () => {
			const result = vineFormSchema.safeParse({ ...validVine, nosql_tables: [] });
			expect(result.success).toBe(true);
		});

		it("accepts valid dynamodb table", () => {
			const data = {
				...validVine,
				nosql_tables: [{ name: "users", hash_key: "id", hash_key_type: "S", table_type: "standard", billing_mode: "PAY_PER_REQUEST" }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects dynamodb table without hash_key", () => {
			const data = {
				...validVine,
				nosql_tables: [{ name: "users" }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("secrets array", () => {
		it("accepts valid secret", () => {
			const data = {
				...validVine,
				secrets: [{ name: "postgres-password", generate: true, length: 32, special_chars: true }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects secret with empty name", () => {
			const data = {
				...validVine,
				secrets: [{ name: "" }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("queues and topics", () => {
		it("accepts valid queue", () => {
			const data = {
				...validVine,
				queues: [{ name: "email-processing", fifo: false, visibility_timeout: 30 }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("accepts valid topic", () => {
			const data = {
				...validVine,
				topics: [{ name: "user-events", subscriptions: [] }],
			};
			const result = vineFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});
	});
});
