// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type { CloudProviderSlug } from "./registry";
import { PROVIDERS } from "./registry";
import { REGION_MAP, DEFAULT_REGION } from "./regions";
import {
	INSTANCE_TYPE_MAP,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	AUTOSCALER,
} from "./compute";
import { ENGINE_MAP, DB_CAPACITY } from "./database";
import { CACHE_NODE_MAP, DEFAULT_CACHE_NODE } from "./cache";
import {
	HETZNER_CACHE_ENGINES,
	HETZNER_DB_ENGINES,
} from "./hetzner-services";
import { NOSQL } from "./nosql";

/** Engine families / cache engines Hetzner's in-cluster charts can back. */
const HETZNER_DB_ENGINE_SET = new Set<string>(HETZNER_DB_ENGINES);
const HETZNER_CACHE_ENGINE_SET = new Set<string>(HETZNER_CACHE_ENGINES);

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
			// Hetzner runs databases in-cluster via CloudNativePG (PostgreSQL-only). Any other
			// engine_family would be silently skipped by the chart mapper — remap fail-closed.
			if (
				targetProvider === "hetzner" &&
				db.engine_family &&
				!HETZNER_DB_ENGINE_SET.has(db.engine_family)
			) {
				warnings.push({
					severity: "warning",
					component: "Databases",
					message: `Database "${db.name}" used ${db.engine_family} — ${target.shortName} runs databases in-cluster via CloudNativePG, which is PostgreSQL-only. Engine switched to PostgreSQL.`,
				});
				db.engine_family = "postgres";
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
			// Hetzner's in-cluster cache chart is Valkey — keep the stored engine honest.
			if (
				targetProvider === "hetzner" &&
				cache.engine &&
				!HETZNER_CACHE_ENGINE_SET.has(cache.engine)
			) {
				warnings.push({
					severity: "info",
					component: "Caches",
					message: `Caches on ${target.shortName} run in-cluster as Valkey (Redis-compatible). Cache "${cache.name}" switched to Valkey.`,
				});
				cache.engine = "valkey";
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
		const hasFireQueues = data.queues.some((q) => q.ordered);
		if (hasFireQueues && targetProvider === "gcp") {
			warnings.push({
				severity: "warning",
				component: "Messaging",
				message: "FIFO queues have no direct Pub/Sub equivalent. Consider using ordering keys for partial ordering.",
			});
		}
	}

	return { data, warnings };
}
