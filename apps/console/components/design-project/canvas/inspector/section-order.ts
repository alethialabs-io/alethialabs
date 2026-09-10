// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { SectionDef, SectionTier } from "./config-schema";

/**
 * The order every component card reads in, outermost promise first:
 *
 *   essentials — the portable fields. What you'd set on any cloud.
 *   sizing     — capacity and scale.
 *   security   — access, encryption, admins.
 *   advanced   — provider-specific knobs, collapsed and badged with the cloud they belong to.
 *
 * A database, a queue and a bucket are different resources, but a person configuring any of them
 * asks the same four questions in the same order. Before this, each kind's card read in whatever
 * order its schema happened to be written in — a cache put Network above Sizing, nosql put
 * Replication last but called it Advanced, and the tiers existed only as a badge. The order is
 * applied at RENDER, so a schema author cannot get it wrong by writing the sections in a
 * different order.
 */
export const TIER_ORDER: readonly SectionTier[] = [
	"essentials",
	"sizing",
	"security",
	"advanced",
] as const;

/** A section's tier, defaulting to `essentials` (the schema's own default). */
export function tierOf(section: SectionDef): SectionTier {
	return section.tier ?? "essentials";
}

/**
 * The sections in tier order. Stable within a tier — a kind's own ordering of its essentials is
 * meaningful (General before Capacity) and is preserved.
 */
export function sortSections<S extends SectionDef>(sections: S[]): S[] {
	return [...sections].sort(
		(a, b) => TIER_ORDER.indexOf(tierOf(a)) - TIER_ORDER.indexOf(tierOf(b)),
	);
}
