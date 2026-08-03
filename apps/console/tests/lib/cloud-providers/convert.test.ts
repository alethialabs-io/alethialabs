// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
	convertProjectConfig,
	type ConversionWarning,
} from "@/lib/cloud-providers/convert";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/**
 * Builds a minimal ProjectFormData fixture exercising every branch of the
 * converter. Only the fields the converter reads are populated; the object is
 * cast at the call boundary so we keep the SUT's real types intact.
 */
function makeConfig(overrides: Record<string, unknown> = {}): ProjectFormData {
	const base = {
		project: { region: "eu-central-1" },
		cluster: {
			instance_types: ["t3.medium", "t3.large"],
			cluster_version: "1.30",
			provider_config: { enable_karpenter: true },
		},
		network: { provision_network: true, network_id: undefined },
		dns: { provider_config: {}, zone_id: undefined, domain_name: undefined },
		databases: [],
		caches: [],
		nosql_tables: [],
		queues: [],
		...overrides,
	};
	return base as never;
}

/** Picks warnings for a single component. */
function byComponent(
	warnings: ConversionWarning[],
	component: string,
): ConversionWarning[] {
	return warnings.filter((w) => w.component === component);
}

describe("convertProjectConfig — identity (same provider)", () => {
	it("returns a deep clone with no warnings and does not mutate the source", () => {
		const source = makeConfig();
		const { data, warnings } = convertProjectConfig(source, "aws", "aws");

		expect(warnings).toEqual([]);
		expect(data).not.toBe(source);
		expect(data.cluster.instance_types).not.toBe(source.cluster.instance_types);
		// untouched values survive verbatim
		expect(data.project.region).toBe("eu-central-1");
		expect(data.cluster.instance_types).toEqual(["t3.medium", "t3.large"]);
	});
});

describe("convertProjectConfig — region remap", () => {
	it.each([
		["aws", "gcp", "eu-central-1", "europe-west3"],
		["aws", "azure", "eu-central-1", "germanywestcentral"],
		["gcp", "aws", "europe-west3", "eu-central-1"],
		["azure", "gcp", "germanywestcentral", "europe-west3"],
	] as const)(
		"%s -> %s maps region %s to %s",
		(from, to, region, expected) => {
			const { data, warnings } = convertProjectConfig(
				makeConfig({ project: { region } }),
				from,
				to,
			);
			expect(data.project.region).toBe(expected);
			expect(byComponent(warnings, "Region")).toEqual([]);
		},
	);

	it("falls back to the target default region with an error warning when unmapped", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ project: { region: "ap-northeast-2" } }), // not in aws->gcp map
			"aws",
			"gcp",
		);
		expect(data.project.region).toBe("europe-west1"); // DEFAULT_REGION.gcp
		const regionWarnings = byComponent(warnings, "Region");
		expect(regionWarnings).toHaveLength(1);
		expect(regionWarnings[0].severity).toBe("error");
		expect(regionWarnings[0].message).toContain("ap-northeast-2");
		expect(regionWarnings[0].message).toContain("europe-west1");
	});

	it("emits no region warning when the source region is empty", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({ project: { region: "" } }),
			"aws",
			"gcp",
		);
		expect(byComponent(warnings, "Region")).toEqual([]);
	});
});

describe("convertProjectConfig — cluster instance types", () => {
	it("maps known instance types and deduplicates collisions", () => {
		// c5.large and c5.xlarge both map to c2-standard-4 on gcp -> deduped
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				cluster: {
					instance_types: ["c5.large", "c5.xlarge", "t3.medium"],
					provider_config: {},
				},
			}),
			"aws",
			"gcp",
		);
		expect(data.cluster.instance_types).toEqual(["c2-standard-4", "e2-medium"]);
		// none of the mapped types produced a warning
		expect(
			byComponent(warnings, "Cluster").filter((w) => w.severity === "warning"),
		).toEqual([]);
	});

	it("falls back to the default instance type with a warning for unknown types", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				cluster: { instance_types: ["x9.mega"], provider_config: {} },
			}),
			"aws",
			"azure",
		);
		expect(data.cluster.instance_types).toEqual(["Standard_D2s_v5"]); // DEFAULT_INSTANCE_TYPE.azure
		const clusterWarn = byComponent(warnings, "Cluster").find(
			(w) => w.severity === "warning",
		);
		expect(clusterWarn?.message).toContain("x9.mega");
	});

	it("always resets the k8s version to the target default with an info warning", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ cluster: { instance_types: [], provider_config: {} } }),
			"aws",
			"gcp",
		);
		expect(data.cluster.cluster_version).toBe("1.35"); // DEFAULT_K8S_VERSION.gcp
		const info = byComponent(warnings, "Cluster").find(
			(w) => w.message.includes("Kubernetes version"),
		);
		expect(info?.severity).toBe("info");
		expect(info?.message).toContain("GKE");
	});
});

describe("convertProjectConfig — autoscaler remap", () => {
	it("translates an enabled source autoscaler to the target key with an info warning", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				cluster: {
					instance_types: [],
					provider_config: { enable_karpenter: true },
				},
			}),
			"aws",
			"gcp",
		);
		expect(data.cluster.provider_config).toEqual({ enable_autopilot: true });
		const info = byComponent(warnings, "Cluster").find((w) =>
			w.message.includes("Karpenter"),
		);
		expect(info?.severity).toBe("info");
		expect(info?.message).toContain("Autopilot");
	});

	it("carries a disabled autoscaler across without an autoscaler warning", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				cluster: {
					instance_types: [],
					provider_config: { enable_karpenter: false },
				},
			}),
			"aws",
			"azure",
		);
		expect(data.cluster.provider_config).toEqual({
			enable_cluster_autoscaler: false,
		});
		expect(
			byComponent(warnings, "Cluster").some((w) =>
				w.message.includes("replaced with"),
			),
		).toBe(false);
	});
});

describe("convertProjectConfig — databases", () => {
	it("remaps engine and clamps capacity to the target capacity model", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				databases: [
					{
						name: "primary",
						engine: "aurora-postgresql",
						min_capacity: 0.5, // below gcp min (1) -> clamps up to 1
						max_capacity: 200, // above gcp max (96) -> clamps down to 96
					},
				],
			}),
			"aws",
			"gcp",
		);
		const db = data.databases[0];
		expect(db.engine).toBe("cloudsql-postgresql");
		expect(db.min_capacity).toBe(1);
		expect(db.max_capacity).toBe(96);
		const info = byComponent(warnings, "Databases").find(
			(w) => w.severity === "info",
		);
		expect(info?.message).toContain("vCPU"); // DB_CAPACITY.gcp.unit
	});

	it("warns when an engine has no equivalent but leaves it unchanged", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				databases: [{ name: "x", engine: "oracle-rac" }],
			}),
			"aws",
			"gcp",
		);
		expect(data.databases[0].engine).toBe("oracle-rac");
		const warn = byComponent(warnings, "Databases").find(
			(w) => w.severity === "warning",
		);
		expect(warn?.message).toContain("oracle-rac");
	});

	it("emits no Databases warnings when there are none", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({ databases: [] }),
			"aws",
			"gcp",
		);
		expect(byComponent(warnings, "Databases")).toEqual([]);
	});

	it("remaps a non-postgres engine_family to postgres when converting to hetzner", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				databases: [
					{ name: "orders", engine: "aurora-mysql", engine_family: "mysql" },
				],
			}),
			"aws",
			"hetzner",
		);
		// Without this remap the Hetzner chart mapper (CloudNativePG = postgres-only)
		// would silently drop the database from the deploy.
		expect(data.databases[0].engine_family).toBe("postgres");
		const warn = byComponent(warnings, "Databases").find((w) =>
			w.message.includes("CloudNativePG"),
		);
		expect(warn?.severity).toBe("warning");
		expect(warn?.message).toContain("orders");
		expect(warn?.message).toContain("PostgreSQL");
	});

	it("leaves a postgres engine_family untouched when converting to hetzner", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				databases: [
					{
						name: "primary",
						engine: "aurora-postgresql",
						engine_family: "postgres",
					},
				],
			}),
			"aws",
			"hetzner",
		);
		expect(data.databases[0].engine_family).toBe("postgres");
		expect(
			byComponent(warnings, "Databases").some((w) =>
				w.message.includes("CloudNativePG"),
			),
		).toBe(false);
	});

	it("does not remap engine_family for managed-cloud targets", () => {
		const { data } = convertProjectConfig(
			makeConfig({
				databases: [
					{ name: "orders", engine: "aurora-mysql", engine_family: "mysql" },
				],
			}),
			"aws",
			"gcp",
		);
		expect(data.databases[0].engine_family).toBe("mysql");
	});
});

describe("convertProjectConfig — caches", () => {
	it("maps a known cache node type", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ caches: [{ name: "c", node_type: "cache.t3.medium" }] }),
			"aws",
			"gcp",
		);
		expect(data.caches[0].node_type).toBe("M2");
		expect(byComponent(warnings, "Caches")).toEqual([]);
	});

	it("defaults unknown cache node types with a warning", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ caches: [{ name: "c", node_type: "cache.giant" }] }),
			"aws",
			"gcp",
		);
		expect(data.caches[0].node_type).toBe("M1"); // DEFAULT_CACHE_NODE.gcp
		expect(byComponent(warnings, "Caches")[0].message).toContain("cache.giant");
	});

	it("switches the cache engine to valkey when converting to hetzner", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ caches: [{ name: "sessions", engine: "redis" }] }),
			"aws",
			"hetzner",
		);
		// The in-cluster chart is Valkey — keeping engine:"redis" would be dishonest.
		expect(data.caches[0].engine).toBe("valkey");
		const info = byComponent(warnings, "Caches").find(
			(w) => w.severity === "info",
		);
		expect(info?.message).toContain("Valkey");
	});

	it("leaves a valkey cache engine alone when converting to hetzner", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({ caches: [{ name: "sessions", engine: "valkey" }] }),
			"aws",
			"hetzner",
		);
		expect(data.caches[0].engine).toBe("valkey");
		expect(
			byComponent(warnings, "Caches").some((w) => w.severity === "info"),
		).toBe(false);
	});
});

describe("convertProjectConfig — network", () => {
	it("forces provisioning a new network and clears a referenced network id", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				network: { provision_network: false, network_id: "vpc-123" },
			}),
			"aws",
			"gcp",
		);
		expect(data.network.provision_network).toBe(true);
		expect(data.network.network_id).toBeUndefined();
		const warn = byComponent(warnings, "Network")[0];
		expect(warn.severity).toBe("warning");
		expect(warn.message).toContain("VPC Network"); // gcp networkName
	});

	it("leaves a fresh-provision network alone with no warning", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({
				network: { provision_network: true, network_id: undefined },
			}),
			"aws",
			"gcp",
		);
		expect(byComponent(warnings, "Network")).toEqual([]);
	});
});

describe("convertProjectConfig — DNS / WAF", () => {
	it("clears WAF config and zone, emitting both warnings", () => {
		const { data, warnings } = convertProjectConfig(
			makeConfig({
				dns: {
					provider_config: { enable_waf: true },
					zone_id: "Z123",
					domain_name: "example.com",
				},
			}),
			"aws",
			"gcp",
		);
		expect(data.dns.provider_config).toEqual({});
		expect(data.dns.zone_id).toBeUndefined();
		expect(data.dns.domain_name).toBeUndefined();

		const dnsWarnings = byComponent(warnings, "DNS");
		expect(dnsWarnings.some((w) => w.severity === "info")).toBe(true);
		const zoneWarn = dnsWarnings.find((w) => w.severity === "warning");
		expect(zoneWarn?.message).toContain("Cloud DNS"); // gcp dnsService
	});

	it("does not emit a WAF info warning when no WAF flag is set", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({
				dns: { provider_config: { enable_waf: false }, zone_id: undefined },
			}),
			"aws",
			"gcp",
		);
		expect(byComponent(warnings, "DNS")).toEqual([]);
	});
});

describe("convertProjectConfig — NoSQL", () => {
	it("warns about portability and range keys when target lacks range support", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({
				nosql_tables: [
					{ name: "events", partition_key: "pk", sort_key: "sk" },
				],
			}),
			"aws",
			"gcp", // Firestore: supportsRangeKey=false, has portabilityNote
		);
		const nosql = byComponent(warnings, "NoSQL");
		expect(nosql).toHaveLength(2);
		expect(nosql.some((w) => w.message.includes("Firestore"))).toBe(true);
		expect(nosql.some((w) => w.message.includes("range key"))).toBe(true);
	});

	it("does not warn about range keys when target supports them", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({
				nosql_tables: [
					{ name: "events", partition_key: "pk", sort_key: "sk" },
				],
			}),
			"aws",
			"azure", // Cosmos DB: supportsRangeKey=true, has portabilityNote
		);
		const nosql = byComponent(warnings, "NoSQL");
		expect(nosql.some((w) => w.message.includes("range key"))).toBe(false);
		// portability note still surfaces
		expect(nosql.some((w) => w.message.includes("Cosmos DB"))).toBe(true);
	});
});

// #1812 — this suite used to assert the opposite cloud. The warning named GCP ("no direct Pub/Sub
// equivalent") while Pub/Sub was the one being wired, and said nothing about Alibaba, which is the
// documented `queue:ordered` exclusion. Converting to a cloud that honors the switch loses nothing
// and must stay silent; converting to the one that does not is the whole point of the warning.
describe("convertProjectConfig — messaging", () => {
	it("warns about ordered queues only when converting to Alibaba", () => {
		const toAlibaba = convertProjectConfig(
			makeConfig({ queues: [{ name: "q", ordered: true }] }),
			"aws",
			"alibaba",
		);
		expect(
			byComponent(toAlibaba.warnings, "Messaging").some((w) =>
				w.message.includes("Ordered delivery is not applied on Alibaba Cloud"),
			),
		).toBe(true);

		// The three clouds that carry the switch stay silent.
		for (const target of ["gcp", "azure", "aws"] as const) {
			const converted = convertProjectConfig(
				makeConfig({ queues: [{ name: "q", ordered: true }] }),
				target === "aws" ? "gcp" : "aws",
				target,
			);
			expect(byComponent(converted.warnings, "Messaging")).toEqual([]);
		}
	});

	it("does not warn for non-ordered queues to Alibaba", () => {
		const { warnings } = convertProjectConfig(
			makeConfig({ queues: [{ name: "q", ordered: false }] }),
			"aws",
			"alibaba",
		);
		expect(byComponent(warnings, "Messaging")).toEqual([]);
	});
});

// #1420 — the target cloud's engine ceiling now comes from the catalog, so it covers every cloud
// rather than only Hetzner. Azure Managed Redis and ApsaraDB KVStore have no Valkey: converting a
// project carrying `engine: "valkey"` to either used to keep the value, and the deploy quietly
// produced Redis because no provider read the field at all.
describe("convertProjectConfig — cache engines the target cannot run", () => {
	const valkeyCache = makeConfig({ caches: [{ name: "sessions", engine: "valkey" }] });

	it("remaps to Redis on the clouds with no Valkey product, and says why", () => {
		for (const cloud of ["azure", "alibaba"] as const) {
			const { data: config, warnings } = convertProjectConfig(valkeyCache, "aws", cloud);
			expect(config.caches?.[0]?.engine).toBe("redis");
			expect(
				byComponent(warnings, "Caches").some((w) => /does not offer/i.test(w.message)),
			).toBe(true);
		}
	});

	it("leaves it alone where the engine really is offered", () => {
		const { data: config, warnings } = convertProjectConfig(valkeyCache, "aws", "gcp");
		expect(config.caches?.[0]?.engine).toBe("valkey");
		expect(byComponent(warnings, "Caches").some((w) => /does not offer/i.test(w.message))).toBe(
			false,
		);
	});

	it("keeps Hetzner's own wording — the reason there is in-cluster, not a missing product", () => {
		const redisCache = makeConfig({ caches: [{ name: "sessions", engine: "redis" }] });
		const { data: config, warnings } = convertProjectConfig(redisCache, "aws", "hetzner");
		expect(config.caches?.[0]?.engine).toBe("valkey");
		expect(byComponent(warnings, "Caches").some((w) => /in-cluster/i.test(w.message))).toBe(true);
	});
});

// The database side gained the same generalization. Its Hetzner behaviour must not change.
describe("convertProjectConfig — database families the target cannot run", () => {
	it("still switches MySQL to PostgreSQL on Hetzner, in Hetzner's words", () => {
		const mysql = makeConfig({ databases: [{ name: "main", engine_family: "mysql" }] });
		const { data: config, warnings } = convertProjectConfig(mysql, "aws", "hetzner");
		expect(config.databases?.[0]?.engine_family).toBe("postgres");
		expect(byComponent(warnings, "Databases").some((w) => /CloudNativePG/i.test(w.message))).toBe(
			true,
		);
	});

	it("leaves MySQL alone on a cloud whose catalog offers it", () => {
		const mysql = makeConfig({ databases: [{ name: "main", engine_family: "mysql" }] });
		const { data: config } = convertProjectConfig(mysql, "aws", "gcp");
		expect(config.databases?.[0]?.engine_family).toBe("mysql");
	});
});
