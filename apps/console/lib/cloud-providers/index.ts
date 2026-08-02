// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Catalog data + provider types come straight from the generated SSOT (#940c removed the per-domain
// barrel shims); the non-catalog runtime helpers live in provider-slug.ts / region-groups.ts.
export {
	type CloudProviderSlug,
	type ConnectableCloudSlug,
	type CloudProviderMeta,
	// The abstract database engine axis ("postgres" | "mysql"). Exported because the keyless gate,
	// the inspector's engine label and the store normalizer all key on it, and a bare `string` there
	// would let a typo through every one of them.
	type EngineFamily,
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
	// Resolves an abstract engine family (postgres/mysql) to the provider's engine row. The canvas
	// stores the FAMILY in `engine_family` while capability rows are keyed on the engine VALUE, so
	// the version picker needs this to join the two.
	dbEngine,
	CACHE_NODE_TYPES,
	DEFAULT_CACHE_NODE,
	CACHE_NODE_MAP,
	NOSQL,
} from "./generated/catalog";
export {
	dbEngineFamily,
	keylessUnavailableReason,
	keylessUnavailableReasonForCloud,
	normalizeKeylessAuth,
} from "./keyless";
export {
	KEYLESS_CELLS,
	type KeylessCell,
	type KeylessCellState,
} from "./generated/keyless-cells";
export { getProvider, CACHE_TTL_HOURS } from "./provider-slug";
export { groupRegions } from "./region-groups";
export { WAF_OPTIONS, CERT_OPTIONS } from "./dns";
export { MESSAGING } from "./messaging";
export { NETWORK } from "./network";
export { convertProjectConfig, type ConversionWarning, type ConversionSeverity } from "./convert";

// The cloud-provider STORE is deliberately not re-exported here. It is a client zustand store that
// imports `@/app/server/actions/cloud-resources`, so re-exporting it pulled better-auth and the
// database config into the module graph of anything that touched this barrel — including build-time
// tooling that only wants the catalog data. Import it from `@/lib/stores/use-cloud-provider-store`.
