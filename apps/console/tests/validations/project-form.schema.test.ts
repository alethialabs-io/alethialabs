// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
	projectFormSchema,
	helmRegistryProviderConfigSchema,
} from "@/lib/validations/project-form.schema";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";

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

	// In-cluster sizing (compute-only clouds, e.g. Hetzner): the columns are nullable —
	// NULL/omitted means the mapper defaults apply — and clamped to the inspector's bounds.
	describe("in-cluster sizing fields (storage_gb / replicas)", () => {
		it("accepts explicit sizing on databases, caches, and queues", () => {
			const data = {
				...validProject,
				databases: [{ name: "primary", engine_family: "postgres", storage_gb: 50, replicas: 3 }],
				caches: [{ name: "primary", engine: "valkey", storage_gb: 32 }],
				queues: [{ name: "jobs", storage_gb: 16 }],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts null / omitted sizing (mapper defaults stay authoritative)", () => {
			const data = {
				...validProject,
				databases: [{ name: "primary", storage_gb: null, replicas: null }],
				caches: [{ name: "primary" }],
				queues: [{ name: "jobs", storage_gb: null }],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects negative, zero, fractional, and out-of-bounds sizing", () => {
			const bad = [
				{ databases: [{ name: "d", storage_gb: -5 }] },
				{ databases: [{ name: "d", replicas: 0 }] },
				{ databases: [{ name: "d", replicas: 6 }] },
				{ databases: [{ name: "d", storage_gb: 2048 }] },
				{ databases: [{ name: "d", storage_gb: 10.5 }] },
				{ caches: [{ name: "c", storage_gb: 0 }] },
				{ caches: [{ name: "c", storage_gb: 1024 }] },
				{ queues: [{ name: "q", storage_gb: -1 }] },
				{ queues: [{ name: "q", storage_gb: 512 }] },
			];
			const failures = bad
				.filter(
					(overrides) =>
						projectFormSchema.safeParse({ ...validProject, ...overrides }).success,
				)
				.map((overrides) => JSON.stringify(overrides));
			expect(failures).toEqual([]);
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

	describe("storage_buckets array (S3-safe naming)", () => {
		it("accepts a valid bucket", () => {
			const data = {
				...validProject,
				storage_buckets: [
					{
						name: "my-assets-1",
						versioning: true,
						encryption_enabled: true,
						public_access: false,
						cors_origins: ["https://app.example.com"],
					},
				],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts a minimal 3-char name and a 63-char name", () => {
			for (const name of ["abc", `a${"b".repeat(61)}c`]) {
				const data = { ...validProject, storage_buckets: [{ name }] };
				expect(projectFormSchema.safeParse(data).success).toBe(true);
			}
		});

		it("rejects uppercase, too-short, too-long, and hyphen-edged names", () => {
			const bad = [
				"MyBucket", // uppercase
				"ab", // 2 chars
				"a".repeat(64), // 64 chars
				"-assets", // leading hyphen
				"assets-", // trailing hyphen
				"my_bucket", // underscore
				"", // empty
			];
			const passed = bad.filter(
				(name) =>
					projectFormSchema.safeParse({ ...validProject, storage_buckets: [{ name }] })
						.success,
			);
			expect(passed).toEqual([]);
		});

		it("defaults to [] when omitted", () => {
			const result = projectFormSchema.safeParse(validProject);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.storage_buckets).toEqual([]);
				expect(result.data.container_registries).toEqual([]);
			}
		});
	});

	describe("container_registries array", () => {
		it("accepts a valid registry with provider knobs", () => {
			const data = {
				...validProject,
				container_registries: [
					{
						name: "apps",
						provider_config: { immutable_tags: true, vulnerability_scanning: true },
					},
				],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects a registry with an empty name", () => {
			const data = { ...validProject, container_registries: [{ name: "" }] };
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("strips the repository_url output column", () => {
			const data = {
				...validProject,
				container_registries: [
					{ name: "apps", repository_url: "123.dkr.ecr.amazonaws.com/apps" },
				],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.container_registries[0]).not.toHaveProperty("repository_url");
			}
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

	describe("services array — W3 bindings", () => {
		const serviceWith = (bindings: unknown) => ({
			...validProject,
			services: [
				{
					name: "api",
					type: "deployment",
					source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "." },
					env: [],
					ports: [],
					bindings,
				},
			],
		});

		it("accepts a service with a valid binding (target + injected facets)", () => {
			const data = serviceWith([
				{
					target: { kind: "database", name: "orders-db" },
					inject: [
						{ env: "DATABASE_HOST", from: "endpoint" },
						{ env: "DATABASE_PASSWORD", from: "password" },
					],
				},
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts a secret-kind binding with the value facet (#1207)", () => {
			const data = serviceWith([
				{
					target: { kind: "secret", name: "stripe-key" },
					inject: [{ env: "STRIPE_KEY", from: "value" }],
				},
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects an unknown injection facet", () => {
			const data = serviceWith([
				{ target: { kind: "database", name: "db" }, inject: [{ env: "X", from: "bogus" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("rejects an unknown binding target kind", () => {
			const data = serviceWith([
				{ target: { kind: "bucket", name: "assets" }, inject: [{ env: "X", from: "endpoint" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("rejects an empty target name", () => {
			const data = serviceWith([
				{ target: { kind: "cache", name: "" }, inject: [{ env: "REDIS_URL", from: "endpoint" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});
	});
});

// The chart-repo provider_config validator is parsed AGAIN server-side in writeComponents (the write
// action is a public entry point, and provider_config is spread whole into the persisted
// config_snapshot). These lock the two guarantees that fix relies on.
describe("helmRegistryProviderConfigSchema", () => {
	it("strips any key it never declared — a secret knob a crafted request tacks on can't be persisted", () => {
		const parsed = helmRegistryProviderConfigSchema.parse({
			registry_host: "registry.acme.io",
			// not part of the schema — a hostile/extra knob that must never reach the snapshot
			sneaky_token: "s3cr3t",
		});
		expect(parsed).toEqual({ registry_host: "registry.acme.io" });
		expect("sneaky_token" in parsed).toBe(false);
	});

	it("keeps the declared non-secret knobs", () => {
		expect(
			helmRegistryProviderConfigSchema.parse({ repo_url: "https://charts.acme.io" }),
		).toEqual({ repo_url: "https://charts.acme.io" });
	});

	it("fails closed on a malformed host that would break the seeded repo-cred match", () => {
		// a scheme+path where a bare host is required — waved through today, it yields a credential
		// URL no ArgoCD Application repoURL prefix-matches, surfacing only at deploy.
		expect(
			helmRegistryProviderConfigSchema.safeParse({ registry_host: "https://acme.io/charts" })
				.success,
		).toBe(false);
	});
});

// ── provider_config: shaped, stripped, and pinned to the catalog (#1412) ──────────────────────
//
// These bags are spread WHOLE into the Postgres-persisted config_snapshot, so they are shaped and
// STRIPPED rather than waved through as opaque JSONB. Stripping brings its own hazard — a knob the
// schema doesn't know is dropped SILENTLY — so each category is pinned against catalog.json from
// the other direction too.
//
// That parity check is not hypothetical: RegistryProviderConfig was missing `registry_url`, which
// four active registry connectors REQUIRE and which pullAuth uses as the dockerconfig `auths` key.
// A pull secret built without it authenticates against nothing.
describe("provider_config is pinned to the connector catalog", () => {
	const declaredKnobs = (category: "registry" | "dns") => {
		const keys = new Set<string>();
		for (const provider of getProvidersForCategory(category)) {
			for (const field of provider.providerConfigFields) {
				if (!field.secret) keys.add(field.key);
			}
		}
		return keys;
	};

	it("keeps every knob the registry connectors declare", () => {
		const declared = declaredKnobs("registry");
		expect(declared.size).toBeGreaterThan(0);

		const parsed = projectFormSchema.safeParse({
			...validProject,
			container_registries: [
				{
					name: "apps",
					provider_config: Object.fromEntries([...declared].map((k) => [k, `v-${k}`])),
				},
			],
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.container_registries[0].provider_config ?? {}));
		expect([...declared].filter((k) => !kept.has(k))).toEqual([]);
	});

	it("keeps every knob the dns connectors declare", () => {
		const declared = declaredKnobs("dns");
		expect(declared.size).toBeGreaterThan(0);

		const parsed = projectFormSchema.safeParse({
			...validProject,
			dns: {
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-1",
				// Cloudflare's `proxied` is a boolean; the rest of the bag is booleans too.
				provider_config: Object.fromEntries([...declared].map((k) => [k, k === "zone_id" ? "z" : true])),
			},
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.dns.provider_config ?? {}));
		expect([...declared].filter((k) => !kept.has(k))).toEqual([]);
	});

	it("strips a key no registry connector declares, so it can't reach the config snapshot", () => {
		const parsed = projectFormSchema.safeParse({
			...validProject,
			container_registries: [
				{
					name: "apps",
					// A token pasted into the wrong field would otherwise be stored verbatim.
					provider_config: { immutable_tags: true, password: "s3cr3t-should-not-persist" },
				},
			],
		});
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.container_registries[0].provider_config).toEqual({ immutable_tags: true });
	});
});

// ── the DNS connector selection is fail-closed (#1412) ────────────────────────────────────────
describe("dns connector selection", () => {
	const parseDns = (dns: Record<string, unknown>) =>
		projectFormSchema.safeParse({ ...validProject, dns });

	it("accepts cloud-native DNS with no connector", () => {
		expect(parseDns({ enabled: true, domain_name: "acme.io" }).success).toBe(true);
		expect(parseDns({ enabled: true, domain_name: "acme.io", provider: "native" }).success).toBe(
			true,
		);
	});

	it("accepts Cloudflare with a zone on the column", () => {
		// The column is the single source: dns_cloudflare.go prefers provider_config.zone_id but
		// falls back to project_dns.zone_id, so either satisfies the runtime.
		expect(
			parseDns({
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-123",
			}).success,
		).toBe(true);
	});

	// Fail-closed: without a zone, Cloudflare's own Validate rejects the job at compose time — far
	// from the design surface that could have said so.
	it("rejects Cloudflare with no zone anywhere", () => {
		expect(
			parseDns({ enabled: true, provider: "cloudflare", domain_name: "acme.io" }).success,
		).toBe(false);
	});

	// DNSProvider() hard-codes "cloudflare" and returns "" for any other non-native slug, which
	// DISABLES external-dns rather than falling back to the cloud. An unknown slug must not persist.
	it("rejects a slug the catalog doesn't have", () => {
		expect(
			parseDns({
				enabled: true,
				provider: "route53",
				domain_name: "acme.io",
				zone_id: "z",
			}).success,
		).toBe(false);
	});
});
