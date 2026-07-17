// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector's field engine is generic over each kind's config type, so the per-kind
// summary/get/set closures read typed config (no casts). These pin the runtime output of
// those closures — the payoff must behave exactly as before the typing sweep.

import { describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA,
	getKindConfig,
	type FieldCtx,
	type FieldOption,
} from "@/components/design-project/canvas/inspector/config-schema";
import { ADDABLE_KINDS } from "@/components/design-project/canvas/graph/node-registry";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

describe("getKindConfig", () => {
	it("resolves a schema for every addable kind", () => {
		for (const kind of ADDABLE_KINDS) {
			expect(getKindConfig(kind)).toBe(CONFIG_SCHEMA[kind]);
			expect(getKindConfig(kind)?.summary).toBeTypeOf("function");
		}
	});
});

describe("kind summaries", () => {
	const summary = (kind: Parameters<typeof getKindConfig>[0], config: object) =>
		getKindConfig(kind)?.summary(config as Record<string, unknown>, null);

	it("renders each kind's header line from typed config", () => {
		expect(summary("project", { project_name: "My App" })).toBe("My App");
		expect(
			summary("database", {
				engine_family: "postgres",
				min_capacity: 0.5,
				max_capacity: 4,
			}),
		).toBe("PostgreSQL · 0.5–4");
		expect(
			summary("cluster", {
				cluster_version: "1.30",
				node_min_size: 2,
				node_max_size: 5,
			}),
		).toBe("k8s 1.30 · 2–5 nodes");
		expect(summary("cache", { engine: "valkey", node_type: "cache.t3.micro" })).toBe(
			"Valkey · cache.t3.micro",
		);
		expect(summary("network", { provision_network: false, network_id: "vpc-1" })).toBe(
			"vpc-1",
		);
	});

	it("renders the bucket summary from its traits", () => {
		expect(
			summary("bucket", { versioning: true, encryption_enabled: true, public_access: false }),
		).toBe("versioned · encrypted · private");
		expect(
			summary("bucket", { versioning: false, encryption_enabled: false, public_access: true }),
		).toBe("public");
	});

	it("renders the registry summary as the provider's registry service name", () => {
		const registrySummary = (provider: CloudProviderSlug | null, config: object = {}) =>
			getKindConfig("registry")?.summary(
				config as Record<string, unknown>,
				provider,
			);
		expect(registrySummary("aws")).toBe("ECR");
		expect(registrySummary("gcp")).toBe("Artifact Registry");
		expect(registrySummary("azure")).toBe("ACR");
		// No provider yet → fall back to the name.
		expect(registrySummary(null, { name: "apps" })).toBe("apps");
	});

	it("renders in-cluster sizing summaries on hetzner (defaults + explicit)", () => {
		const hetzner = (kind: Parameters<typeof getKindConfig>[0], config: object) =>
			getKindConfig(kind)?.summary(config as Record<string, unknown>, "hetzner");
		expect(hetzner("database", { engine_family: "postgres" })).toBe(
			"PostgreSQL · 10 GiB × 1",
		);
		expect(
			hetzner("database", { engine_family: "postgres", storage_gb: 50, replicas: 3 }),
		).toBe("PostgreSQL · 50 GiB × 3");
		expect(hetzner("cache", { engine: "valkey", memory_gb: 4 })).toBe(
			"Valkey · 4 GiB × 1",
		);
		expect(
			hetzner("cache", {
				engine: "valkey",
				memory_gb: 4,
				storage_gb: 32,
				num_cache_nodes: 2,
			}),
		).toBe("Valkey · 32 GiB × 2");
		expect(hetzner("queue", {})).toBe("RabbitMQ · 8 GiB");
		expect(hetzner("queue", { storage_gb: 64 })).toBe("RabbitMQ · 64 GiB");
	});
});

describe("provider-gated field visibility (hetzner in-cluster sizing)", () => {
	/** Effective visibility of `key` on `kind` for a provider (default: visible). */
	const visible = (
		kind: Parameters<typeof getKindConfig>[0],
		key: string,
		provider: CloudProviderSlug | null,
		config: Record<string, unknown> = {},
	) => {
		const field = getKindConfig(kind)
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === key);
		expect(field).toBeDefined();
		const ctx: FieldCtx = { provider, config };
		return !field?.visibleWhen || field.visibleWhen(config, ctx);
	};

	it("shows storage_gb/replicas only on hetzner", () => {
		expect(visible("database", "storage_gb", "hetzner")).toBe(true);
		expect(visible("database", "replicas", "hetzner")).toBe(true);
		expect(visible("cache", "storage_gb", "hetzner")).toBe(true);
		expect(visible("queue", "storage_gb", "hetzner")).toBe(true);
		expect(visible("database", "storage_gb", "aws")).toBe(false);
		expect(visible("database", "replicas", "aws")).toBe(false);
		expect(visible("cache", "storage_gb", "gcp")).toBe(false);
		expect(visible("queue", "storage_gb", null)).toBe(false);
	});

	it("hides the managed-cloud knobs on hetzner", () => {
		// ACU-style serverless capacity is meaningless for CloudNativePG.
		expect(visible("database", "min_capacity", "hetzner")).toBe(false);
		expect(visible("database", "max_capacity", "hetzner")).toBe(false);
		expect(visible("database", "min_capacity", "aws")).toBe(true);
		// Cache SKUs / Multi-AZ and SQS-isms have no in-cluster equivalent.
		expect(visible("cache", "node_type", "hetzner")).toBe(false);
		expect(visible("cache", "multi_az", "hetzner")).toBe(false);
		expect(visible("cache", "node_type", "aws")).toBe(true);
		expect(visible("queue", "visibility_timeout", "hetzner")).toBe(false);
		expect(visible("queue", "ordered", "hetzner")).toBe(false);
		expect(visible("queue", "visibility_timeout", "azure")).toBe(true);
	});

	it("filters the database engine options to postgres on hetzner", () => {
		const field = getKindConfig("database")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "engine_family");
		const resolveOptions = (provider: CloudProviderSlug): FieldOption[] => {
			const options = field?.options;
			return typeof options === "function"
				? options({ provider, config: {} })
				: (options ?? []);
		};
		expect(resolveOptions("hetzner").map((o) => o.value)).toEqual(["postgres"]);
		expect(resolveOptions("aws").map((o) => o.value)).toEqual([
			"postgres",
			"mysql",
		]);
	});

	it("filters the cache engine options to valkey on hetzner (the chart always deploys Valkey)", () => {
		const field = getKindConfig("cache")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "engine");
		const resolveOptions = (provider: CloudProviderSlug): FieldOption[] => {
			const options = field?.options;
			return typeof options === "function"
				? options({ provider, config: {} })
				: (options ?? []);
		};
		expect(resolveOptions("hetzner").map((o) => o.value)).toEqual(["valkey"]);
		expect(resolveOptions("aws").map((o) => o.value)).toEqual([
			"redis",
			"valkey",
		]);
	});

	it("says Valkey in the hetzner cache summary even for a legacy engine:'redis' config", () => {
		expect(
			getKindConfig("cache")?.summary(
				{ engine: "redis", storage_gb: 16, num_cache_nodes: 2 },
				"hetzner",
			),
		).toBe("Valkey · 16 GiB × 2");
		// Managed clouds keep the honest Redis label.
		expect(
			getKindConfig("cache")?.summary(
				{ engine: "redis", node_type: "cache.t3.micro" },
				"aws",
			),
		).toBe("Redis · cache.t3.micro");
	});

	it("marks the nullable in-cluster sizing fields optional (clear → null, not 0)", () => {
		const optionalOf = (kind: "database" | "cache" | "queue", key: string) =>
			getKindConfig(kind)
				?.sections.flatMap((s) => s.fields)
				.find((f) => f.key === key)?.optional;
		expect(optionalOf("database", "storage_gb")).toBe(true);
		expect(optionalOf("database", "replicas")).toBe(true);
		expect(optionalOf("cache", "storage_gb")).toBe(true);
		expect(optionalOf("queue", "storage_gb")).toBe(true);
		// Required numbers keep the legacy clear→0 behavior.
		expect(optionalOf("database", "port")).toBeUndefined();
		expect(optionalOf("cache", "num_cache_nodes")).toBeUndefined();
	});
});

describe("field get/set escape hatches", () => {
	it("reads and writes the cluster instance type through the first array slot", () => {
		const field = getKindConfig("cluster")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "instance_types");
		expect(field?.get?.({ instance_types: ["m5.large"] })).toBe("m5.large");
		expect(field?.set?.("m5.xlarge", {})).toEqual({ instance_types: ["m5.xlarge"] });
	});

	it("normalizes the bucket name to S3-safe characters via the transform", () => {
		const field = getKindConfig("bucket")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "name");
		expect(field?.transform?.("My Assets_2")).toBe("myassets2");
		expect(field?.transform?.("static-files")).toBe("static-files");
	});

	it("round-trips bucket CORS origins through the comma-separated text field", () => {
		const field = getKindConfig("bucket")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "cors_origins");
		expect(field?.get?.({ cors_origins: ["https://a.com", "https://b.com"] })).toBe(
			"https://a.com, https://b.com",
		);
		expect(field?.set?.("https://a.com, https://b.com,", {})).toEqual({
			cors_origins: ["https://a.com", "https://b.com"],
		});
	});

	it("writes registry knobs into provider_config without clobbering siblings", () => {
		const field = getKindConfig("registry")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "immutable_tags");
		expect(field?.get?.({ provider_config: { immutable_tags: true } })).toBe(true);
		expect(
			field?.set?.(true, { name: "apps", provider_config: { vulnerability_scanning: true } }),
		).toEqual({
			provider_config: { vulnerability_scanning: true, immutable_tags: true },
		});
	});
});

describe("service config (W1)", () => {
	const field = (key: string) =>
		getKindConfig("service")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === key);
	const repoCfg = {
		type: "deployment",
		replicas: 2,
		source: { kind: "repo", repo_url: "https://github.com/acme/api.git", path: "." },
	};
	const imageCfg = {
		type: "job",
		replicas: 1,
		source: { kind: "image", image: "ghcr.io/org/api:1.4.0" },
	};
	const visible = (key: string, config: Record<string, unknown>) => {
		const f = field(key);
		const ctx: FieldCtx = { provider: null, config };
		return !f?.visibleWhen || f.visibleWhen(config, ctx);
	};

	it("summarizes from type · replicas · source basename (repo and image)", () => {
		const summary = (config: object) =>
			getKindConfig("service")?.summary(config as Record<string, unknown>, null);
		expect(summary(repoCfg)).toBe("deployment · 2 replicas · api");
		expect(summary(imageCfg)).toBe("job · 1 replica · api:1.4.0");
	});

	it("swaps the source discriminated union when the kind radio changes", () => {
		expect(field("source_kind")?.get?.(repoCfg)).toBe("repo");
		expect(field("source_kind")?.set?.("image", repoCfg)).toEqual({
			source: { kind: "image", image: "" },
		});
		expect(field("source_kind")?.set?.("repo", imageCfg)).toEqual({
			source: { kind: "repo", repo_url: "", path: "" },
		});
	});

	it("reads/writes repo_url and image only within their own branch", () => {
		expect(field("repo_url")?.get?.(repoCfg)).toBe("https://github.com/acme/api.git");
		// Reading the wrong branch is empty, never a crash on the missing union arm.
		expect(field("repo_url")?.get?.(imageCfg)).toBe("");
		expect(field("image")?.get?.(imageCfg)).toBe("ghcr.io/org/api:1.4.0");
		expect(field("repo_url")?.set?.("https://x/y", repoCfg)).toEqual({
			source: { kind: "repo", repo_url: "https://x/y", path: "." },
		});
	});

	it("shows repo + build fields only for a repo source, image field only for an image", () => {
		expect(visible("repo_url", repoCfg)).toBe(true);
		expect(visible("repo_url", imageCfg)).toBe(false);
		expect(visible("build_dockerfile", repoCfg)).toBe(true);
		expect(visible("build_dockerfile", imageCfg)).toBe(false);
		expect(visible("image", imageCfg)).toBe(true);
		expect(visible("image", repoCfg)).toBe(false);
	});

	it("round-trips nested resource requests/limits without clobbering siblings", () => {
		expect(field("requests_cpu")?.set?.("100m", {})).toEqual({
			resources: { requests: { cpu: "100m", memory: "" }, limits: { cpu: "", memory: "" } },
		});
		const cfg = {
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "500m", memory: "512Mi" },
			},
		};
		expect(field("requests_memory")?.get?.(cfg)).toBe("128Mi");
		expect(field("limits_cpu")?.set?.("1", cfg)).toEqual({
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "512Mi" },
			},
		});
	});

	it("toggles the optional probe and reveals the http path only for an http probe", () => {
		expect(field("probe_enabled")?.get?.({})).toBe(false);
		expect(field("probe_enabled")?.set?.(true, {})).toEqual({
			probe: { type: "http", port: 8080 },
		});
		expect(
			field("probe_enabled")?.set?.(false, { probe: { type: "http", port: 8080 } }),
		).toEqual({ probe: null });
		expect(visible("probe_path", { probe: { type: "http", port: 8080 } })).toBe(true);
		expect(visible("probe_path", { probe: { type: "tcp", port: 8080 } })).toBe(false);
	});

	it("edits backing-infra bindings through the dedicated bindings field type", () => {
		const bindings = field("bindings");
		expect(bindings?.type).toBe("bindings");
		expect(
			bindings?.get?.({
				bindings: [{ target: { kind: "database", name: "orders-db" }, inject: [] }],
			}),
		).toEqual([{ target: { kind: "database", name: "orders-db" }, inject: [] }]);
		expect(bindings?.set?.([], {})).toEqual({ bindings: [] });
	});
});
