// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { nosqlCapacityMode } from "@/lib/db/schema/enums";
import { type CloudProviderSlug, NOSQL } from "./generated/catalog";
import { isCloudProviderSlug } from "./provider-slug";

/**
 * A NoSQL table's capacity mode, normalised to what its cloud can actually build.
 *
 * WHY THIS EXISTS (#4320, maintainer ruling 2026-09-23). Azure Cosmos DB is serverless only here.
 * The canvas used to offer "Provisioned Throughput" on Azure, the provider emitted it per container,
 * and no resource read it — so a user who picked provisioned got serverless, silently. The option is
 * gone from the catalog now, but `project_nosql_tables.capacity_mode` is ONE enum column shared with
 * AWS (DynamoDB) and Alibaba (Tablestore), where `provisioned` is real, so the column stays and the
 * rows already saved on Azure still say `provisioned`.
 *
 * Normalised at READ time rather than by a data migration: which cloud a row is on is a join through
 * its cloud identity to the project's, and an `UPDATE` would have to restate that join in SQL. Every
 * reader instead asks this one function, which reads the catalog — the same table the inspector's
 * Capacity mode card is built from — so the display, the staged change and the deploy snapshot cannot
 * disagree about what a row means. It is derived, not an Azure special case: any cloud whose catalog
 * lists modes and omits this one gets the same answer (GCP's Firestore has only `on_demand`, which is
 * the same truth about a different product).
 *
 * A cloud whose catalog lists NO modes (Hetzner's in-cluster ScyllaDB) is left alone: an empty list
 * says "capacity mode means nothing here", not "on-demand".
 */
export type NosqlCapacityMode = (typeof nosqlCapacityMode.enumValues)[number];

/** The mode a table on `provider` actually gets for a stored `mode`. Null/undefined pass through, as
 * does everything when no cloud is known — "no cloud picked yet" is not a reason to rewrite a value. */
export function effectiveCapacityMode<M extends NosqlCapacityMode | null | undefined>(
	provider: CloudProviderSlug | null,
	mode: M,
): M | NosqlCapacityMode {
	if (!provider || !mode) return mode;
	const offered = NOSQL[provider].billingModes;
	if (offered.length === 0 || offered.some((m) => m.value === mode)) return mode;
	// The catalog's values are plain strings; narrow the first offered one to the enum rather than
	// cast it. A catalog value outside the enum leaves the stored mode alone — rewriting a row to a
	// value the column cannot hold would fail the next save.
	const fallback = nosqlCapacityMode.enumValues.find((v) => v === offered[0]?.value);
	return fallback ?? mode;
}

/** The server-side sibling, taking the placement's raw `cloud_provider` string (which also carries
 * connect-only clouds that have no NoSQL catalog entry — those pass through untouched). */
export function effectiveCapacityModeForCloud<M extends NosqlCapacityMode | null | undefined>(
	provider: string,
	mode: M,
): M | NosqlCapacityMode {
	return isCloudProviderSlug(provider) ? effectiveCapacityMode(provider, mode) : mode;
}

/**
 * Rewrite `capacity_mode` on a config whose cloud cannot build it; returns the SAME object otherwise.
 *
 * Identity is load-bearing, exactly as it is for `normalizeWafEnabled`: the canvas store derives
 * `dirty` from whether normalisation changed anything, and a fresh object every time would open every
 * project with unsaved changes.
 */
export function normalizeCapacityMode<C extends { capacity_mode?: NosqlCapacityMode | null }>(
	config: C,
	provider: CloudProviderSlug | null,
): C {
	const next = effectiveCapacityMode(provider, config.capacity_mode);
	return next === config.capacity_mode ? config : { ...config, capacity_mode: next };
}
