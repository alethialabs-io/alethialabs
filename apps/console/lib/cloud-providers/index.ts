// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Catalog data + provider types come straight from the generated SSOT (#940c removed the per-domain
// barrel shims); the non-catalog runtime helpers live in provider-slug.ts / region-groups.ts.
export {
	type CloudProviderSlug,
	type ConnectableCloudSlug,
	type CloudProviderMeta,
	PROVIDERS,
	REGION_LABELS,
	DEFAULT_REGION,
	REGION_MAP,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	INSTANCE_TYPE_MAP,
	DB_ENGINES,
	DB_CAPACITY,
	ENGINE_MAP,
	CACHE_NODE_TYPES,
	DEFAULT_CACHE_NODE,
	CACHE_NODE_MAP,
	NOSQL,
} from "./generated/catalog";
export { getProvider, CACHE_TTL_HOURS } from "./provider-slug";
export { groupRegions } from "./region-groups";
export { WAF_OPTIONS, CERT_OPTIONS } from "./dns";
export { MESSAGING } from "./messaging";
export { NETWORK } from "./network";
export { convertProjectConfig, type ConversionWarning, type ConversionSeverity } from "./convert";
export {
	useCloudProviderStore,
	useCloudProviderStore as useCloudProvider,
	useProviderSlug,
	useProviderMeta,
	type AnyCachedResources,
} from "@/lib/stores/use-cloud-provider-store";
