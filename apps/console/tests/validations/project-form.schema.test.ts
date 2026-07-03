// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

const validProject = {
	project: {
		project_name: "my-project",
		environment_stage: "development" as const,
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		iac_version: "1.11.4",
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

describe("projectFormSchema", () => {
	// project_name is now a free-text display name (Vercel-style); the URL slug is derived
	// from it via slugify in createProject. Only empty / all-symbol / over-length are rejected.
	describe("project.project_name", () => {
		it("rejects empty project_name", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("accepts free-text names (uppercase, spaces, apostrophes)", () => {
			for (const project_name of ["My Project", "Acme Cloud", "Bob's API"]) {
				const data = { ...validProject, project: { ...validProject.project, project_name } };
				expect(projectFormSchema.safeParse(data).success).toBe(true);
			}
		});

		it("accepts a slug-shaped name", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "my-project-123" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects a name that slugifies to nothing", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "@#$%" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects project_name > 50 chars", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "a".repeat(51) } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("project required fields", () => {
		it("rejects empty region", () => {
			const data = { ...validProject, project: { ...validProject.project, region: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty cloud_identity_id", () => {
			const data = { ...validProject, project: { ...validProject.project, cloud_identity_id: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("valid full form", () => {
		it("accepts valid project with all required fields", () => {
			const result = projectFormSchema.safeParse(validProject);
			expect(result.success).toBe(true);
		});

		it("accepts valid project with optional arrays empty", () => {
			const data = { ...validProject, databases: [], caches: [], queues: [], topics: [], nosql_tables: [], secrets: [] };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("defaults arrays to [] when omitted", () => {
			const data = { project: validProject.project, network: validProject.network, cluster: validProject.cluster, dns: validProject.dns, repositories: validProject.repositories };
			const result = projectFormSchema.safeParse(data);
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
				...validProject,
				databases: [{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4 }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects database with empty name", () => {
			const data = {
				...validProject,
				databases: [{ name: "", engine: "aurora-postgresql" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("nosql_tables array", () => {
		it("accepts empty array", () => {
			const result = projectFormSchema.safeParse({ ...validProject, nosql_tables: [] });
			expect(result.success).toBe(true);
		});

		it("accepts valid nosql table", () => {
			const data = {
				...validProject,
				nosql_tables: [{ name: "users", partition_key: "id", partition_key_type: "S", table_type: "standard", capacity_mode: "on_demand" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects nosql table without partition_key", () => {
			const data = {
				...validProject,
				nosql_tables: [{ name: "users" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("secrets array", () => {
		it("accepts valid secret", () => {
			const data = {
				...validProject,
				secrets: [{ name: "postgres-password", generate: true, length: 32, special_chars: true }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects secret with empty name", () => {
			const data = {
				...validProject,
				secrets: [{ name: "" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("queues and topics", () => {
		it("accepts valid queue", () => {
			const data = {
				...validProject,
				queues: [{ name: "email-processing", ordered: false, visibility_timeout: 30 }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("accepts valid topic", () => {
			const data = {
				...validProject,
				topics: [{ name: "user-events", subscriptions: [] }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});
	});
});
