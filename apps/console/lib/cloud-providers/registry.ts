// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim over the generated catalog baseline (#1126). The provider slug types,
// the CloudProviderMeta interface, and the PROVIDERS metadata map are now generated from the single
// source of truth (packages/core/catalog/catalog.json → generated/catalog.ts) and re-exported here
// verbatim — same paths + symbols, ZERO behaviour change. The runtime narrows/helpers + CACHE_TTL_HOURS
// (which are NOT catalog data) still live here. #940c deletes this shim + repoints importers straight
// at the generated module.
import { cloudProvider } from "@/lib/db/schema/enums";
import type {
	CloudProviderSlug,
	ConnectableCloudSlug,
	CloudProviderMeta,
} from "./generated/catalog";
import { PROVIDERS } from "./generated/catalog";

/**
 * Clouds with full provisioning templates today — a curated SUBSET of the generated `cloud_provider`
 * enum. Every cloud a user can CONNECT (identity layer) is the full enum (`ConnectableCloudSlug`).
 */
export type { CloudProviderSlug, ConnectableCloudSlug, CloudProviderMeta };
/** Provider display + service-name metadata, keyed by slug (all connectable clouds). */
export { PROVIDERS };

/** The provisioning-slug values as a runtime set, kept in lockstep with the type via `satisfies`. */
const CLOUD_PROVIDER_SLUGS = [
	"aws",
	"gcp",
	"azure",
	"hetzner",
	"alibaba",
] as const satisfies readonly CloudProviderSlug[];
const CLOUD_PROVIDER_SLUG_SET = new Set<string>(CLOUD_PROVIDER_SLUGS);
const CONNECTABLE_SLUG_SET = new Set<string>(cloudProvider.enumValues);

/** Cast-free narrow: true when a string is a provisioning-capable cloud slug. */
export function isCloudProviderSlug(s: string): s is CloudProviderSlug {
	return CLOUD_PROVIDER_SLUG_SET.has(s);
}

/** Cast-free narrow: true when a string is a connectable cloud (the full cloud_provider enum). */
export function isConnectableCloudSlug(s: string): s is ConnectableCloudSlug {
	return CONNECTABLE_SLUG_SET.has(s);
}

/** A string as a provisioning slug, defaulting to `aws` when it isn't one. */
export function asCloudProviderSlug(s: string): CloudProviderSlug {
	return isCloudProviderSlug(s) ? s : "aws";
}

/** How long cached cloud resources are considered fresh (hours). */
export const CACHE_TTL_HOURS = 24;

/** Returns provider metadata, defaulting to AWS if slug is unrecognized. */
export function getProvider(slug: string): CloudProviderMeta {
	return isConnectableCloudSlug(slug) ? PROVIDERS[slug] : PROVIDERS.aws;
}
