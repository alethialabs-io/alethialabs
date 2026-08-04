// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import {
	AUTOSCALER,
	CACHE_NODE_MAP,
	type CloudProviderSlug,
	DB_CAPACITY,
	DEFAULT_CACHE_NODE,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	DEFAULT_REGION,
	ENGINE_MAP,
	INSTANCE_TYPE_MAP,
	NOSQL,
	PROVIDERS,
	REGION_MAP,
	cacheEngines,
	dbEngines,
} from "./generated/catalog";
/**
 * Engines the TARGET cloud can back, from the catalog.
 *
 * These were two hardcoded Hetzner sets. That was fine while Hetzner was the only cloud with an
 * engine ceiling — it isn't: Azure Managed Redis and ApsaraDB KVStore have no Valkey, so converting
 * an AWS project carrying `engine: "valkey"` to either one produced a config whose engine that cloud
 * cannot build, and nothing said so. Reading the catalog covers every cloud, including the next one.
 */
const dbFamiliesFor = (provider: CloudProviderSlug): Set<string> =>
	new Set(dbEngines(provider).map((e) => e.family));
/** The cache engine column is a pgEnum, so the catalog's strings are narrowed to it here. A catalog
 * value outside the enum is DROPPED rather than cast — it would save through the form and then fail
 * on insert, which is a worse failure than not offering it. */
type CacheEngineValue = NonNullable<
	NonNullable<ProjectFormData["caches"]>[number]["engine"]
>;
const CACHE_ENGINE_VALUES: readonly string[] = ["redis", "valkey"];
const cacheEnginesFor = (provider: CloudProviderSlug): CacheEngineValue[] =>
	cacheEngines(provider)
		.map((e) => e.value)
		.filter((v): v is CacheEngineValue => CACHE_ENGINE_VALUES.includes(v));

export type ConversionSeverity = "info" | "warning" | "error";

export interface ConversionWarning {
	severity: ConversionSeverity;
	component: string;
	message: string;
}

/** Converts a project form config from one cloud provider to another, mapping all provider-specific values. */
export function convertProjectConfig(
	source: ProjectFormData,
	sourceProvider: CloudProviderSlug,
	targetProvider: CloudProviderSlug,
): { data: ProjectFormData; warnings: ConversionWarning[] } {
	if (sourceProvider === targetProvider) {
		return { data: structuredClone(source), warnings: [] };
	}

	const warnings: ConversionWarning[] = [];
	const data = structuredClone(source);
	const target = PROVIDERS[targetProvider];

	// --- Region ---
	const regionMap = REGION_MAP[sourceProvider]?.[targetProvider] ?? {};
	const mappedRegion = regionMap[data.project.region];
	if (mappedRegion) {
		data.project.region = mappedRegion;
	} else if (data.project.region) {
		warnings.push({
			severity: "error",
			component: "Region",
			message: `Region "${data.project.region}" has no equivalent on ${target.shortName}. Defaulting to ${DEFAULT_REGION[targetProvider]}.`,
		});
		data.project.region = DEFAULT_REGION[targetProvider];
	}

	// --- Cluster ---
	const instanceMap = INSTANCE_TYPE_MAP[sourceProvider]?.[targetProvider] ?? {};
	const mappedTypes = (data.cluster.instance_types ?? []).map((t) => {
		const mapped = instanceMap[t];
		if (!mapped) {
			warnings.push({
				severity: "warning",
				component: "Cluster",
				message: `Instance type "${t}" has no known equivalent on ${target.shortName}. Defaulting to ${DEFAULT_INSTANCE_TYPE[targetProvider]}.`,
			});
			return DEFAULT_INSTANCE_TYPE[targetProvider];
		}
		return mapped;
	});
	data.cluster.instance_types = [...new Set(mappedTypes)];

	data.cluster.cluster_version = DEFAULT_K8S_VERSION[targetProvider];
	warnings.push({
		severity: "info",
		component: "Cluster",
		message: `Kubernetes version set to ${DEFAULT_K8S_VERSION[targetProvider]} (latest for ${target.clusterService}).`,
	});

	const sourceAutoscaler = AUTOSCALER[sourceProvider];
	const targetAutoscaler = AUTOSCALER[targetProvider];
	const sourceAutoscalerEnabled =
		data.cluster.provider_config?.[sourceAutoscaler.providerConfigKey];
	data.cluster.provider_config = {
		[targetAutoscaler.providerConfigKey]: !!sourceAutoscalerEnabled,
	};
	if (sourceAutoscalerEnabled) {
		warnings.push({
			severity: "info",
			component: "Cluster",
			message: `${sourceAutoscaler.label} replaced with ${targetAutoscaler.label}.`,
		});
	}

	// --- Databases ---
	if (data.databases && data.databases.length > 0) {
		const engineMap = ENGINE_MAP[sourceProvider]?.[targetProvider] ?? {};
		const targetCapacity = DB_CAPACITY[targetProvider];
		for (const db of data.databases) {
			if (db.engine) {
				const mapped = engineMap[db.engine];
				if (mapped) {
					db.engine = mapped;
				} else {
					warnings.push({
						severity: "warning",
						component: "Databases",
						message: `Engine "${db.engine}" has no equivalent on ${target.shortName}.`,
					});
				}
			}
			// An engine the target cloud cannot back would be silently skipped at deploy — remap
			// fail-closed to the cloud's first offered family and SAY so.
			const targetFamilies = dbFamiliesFor(targetProvider);
			if (
				db.engine_family &&
				targetFamilies.size > 0 &&
				!targetFamilies.has(db.engine_family)
			) {
				const fallback = [...targetFamilies][0];
				warnings.push({
					severity: "warning",
					component: "Databases",
					message:
						targetProvider === "hetzner"
							? `Database "${db.name}" used ${db.engine_family} — ${target.shortName} runs databases in-cluster via CloudNativePG, which is PostgreSQL-only. Engine switched to PostgreSQL.`
							: `Database "${db.name}" used ${db.engine_family}, which ${target.shortName} does not offer. Engine switched to ${fallback}.`,
				});
				db.engine_family = fallback;
			}
			if (db.min_capacity != null) {
				db.min_capacity = Math.max(targetCapacity.min, db.min_capacity);
			}
			if (db.max_capacity != null) {
				db.max_capacity = Math.min(targetCapacity.max, db.max_capacity);
			}
		}
		warnings.push({
			severity: "info",
			component: "Databases",
			message: `Database capacity units changed to ${DB_CAPACITY[targetProvider].unit}.`,
		});
	}

	// --- Caches ---
	if (data.caches && data.caches.length > 0) {
		const nodeMap = CACHE_NODE_MAP[sourceProvider]?.[targetProvider] ?? {};
		for (const cache of data.caches) {
			// Same for the cache engine: keep the stored engine honest against what the target can
			// actually run. Hetzner's chart is Valkey; Azure and Alibaba have no Valkey at all.
			const targetCacheEngines = cacheEnginesFor(targetProvider);
			if (
				cache.engine &&
				targetCacheEngines.length > 0 &&
				!targetCacheEngines.includes(cache.engine)
			) {
				const fallback = targetCacheEngines[0];
				warnings.push({
					severity: "info",
					component: "Caches",
					message:
						targetProvider === "hetzner"
							? `Caches on ${target.shortName} run in-cluster as Valkey (Redis-compatible). Cache "${cache.name}" switched to Valkey.`
							: `${target.shortName} does not offer ${cache.engine}. Cache "${cache.name}" switched to ${fallback}.`,
				});
				cache.engine = fallback;
			}
			if (cache.node_type) {
				const mapped = nodeMap[cache.node_type];
				if (mapped) {
					cache.node_type = mapped;
				} else {
					warnings.push({
						severity: "warning",
						component: "Caches",
						message: `Cache node type "${cache.node_type}" has no equivalent on ${target.shortName}. Defaulting to ${DEFAULT_CACHE_NODE[targetProvider]}.`,
					});
					cache.node_type = DEFAULT_CACHE_NODE[targetProvider];
				}
			}
		}
	}

	// --- Network ---
	if (data.network.provision_network === false || data.network.network_id) {
		data.network.provision_network = true;
		data.network.network_id = undefined;
		warnings.push({
			severity: "warning",
			component: "Network",
			message: `Existing network cannot be reused across providers. Switched to provisioning a new ${target.networkName}.`,
		});
	}

	// --- DNS / WAF ---
	const sourceDnsConfig = data.dns.provider_config ?? {};
	const hasWaf = Object.values(sourceDnsConfig).some((v) => v === true);
	data.dns.provider_config = {};
	if (hasWaf) {
		warnings.push({
			severity: "info",
			component: "DNS",
			message: `WAF rules differ between providers. Review ${target.shortName} WAF configuration.`,
		});
	}
	if (data.dns.zone_id) {
		data.dns.zone_id = undefined;
		data.dns.domain_name = undefined;
		warnings.push({
			severity: "warning",
			component: "DNS",
			message: `DNS zone cleared — select a ${target.dnsService} zone in the target account.`,
		});
	}

	// --- NoSQL ---
	if (data.nosql_tables && data.nosql_tables.length > 0) {
		const targetNosql = NOSQL[targetProvider];
		if (targetNosql.portabilityNote) {
			warnings.push({
				severity: "warning",
				component: "NoSQL",
				message: targetNosql.portabilityNote,
			});
		}
		if (!targetNosql.supportsRangeKey) {
			for (const table of data.nosql_tables) {
				if (table.sort_key) {
					warnings.push({
						severity: "warning",
						component: "NoSQL",
						message: `Table "${table.name}" uses a range key, which ${targetNosql.serviceName} does not support. It will be ignored.`,
					});
				}
			}
		}
	}

	// --- Messaging ---
	if (data.queues && data.queues.length > 0) {
		const hasOrderedQueues = data.queues.some((q) => q.ordered);
		// This warned about GCP until #1812, on the grounds that "FIFO queues have no direct Pub/Sub
		// equivalent". Pub/Sub's `message_ordering` is now carried, so that sentence became false —
		// and it pointed at the one cloud of the three that DOES honor the switch while saying
		// nothing about the cloud that does not. Alibaba is the documented `queue:ordered` exclusion
		// (infra/offer-exclusions.yaml), so it is the conversion that actually loses something.
		if (hasOrderedQueues && targetProvider === "alibaba") {
			warnings.push({
				severity: "warning",
				component: "Messaging",
				message:
					"Ordered delivery is not applied on Alibaba Cloud — its queue service publishes no ordering guarantee, so these queues will be created unordered.",
			});
		}
	}

	return { data, warnings };
}
