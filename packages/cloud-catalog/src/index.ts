// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which clouds exist and which of them the product offers.
//
// The data is generated from packages/core/catalog/catalog.json, where each cloud carries an
// `availability` of `available` or `hidden`. This package has no dependencies, so the console,
// marketing, docs and @repo/ui can all import it.
//
// What is here is the BUILD-TIME answer. A self-hosted operator can re-enable a hidden cloud at run
// time; that setting is read on the server only (the console's lib/cloud-providers/availability.ts,
// and packages/core/catalog in Go). A static surface — marketing, docs, help text — reads these
// constants and is not affected by it.

import { AVAILABLE_CLOUDS, CLOUD_AVAILABILITY, CLOUD_LABELS, type CloudSlug } from "./generated";

export {
	ALL_CLOUDS,
	AVAILABLE_CLOUDS,
	CLOUD_AVAILABILITY,
	CLOUD_LABELS,
	HIDDEN_CLOUDS,
	PROVISIONABLE_CLOUDS,
} from "./generated";
export type { CloudAvailability, CloudSlug } from "./generated";

/** Narrows a string to a cloud slug the catalog lists. The match is exact: no trimming, no case folding. */
export function isCloudSlug(value: string): value is CloudSlug {
	return Object.hasOwn(CLOUD_AVAILABILITY, value);
}

/**
 * Joins cloud names into one phrase: "AWS", "AWS and GCP", "AWS, GCP, Azure and Hetzner". With no
 * argument it names the clouds offered at build time. An empty list gives an empty string.
 */
export function cloudListLabel(slugs: readonly CloudSlug[] = AVAILABLE_CLOUDS): string {
	const labels = slugs.map((slug) => CLOUD_LABELS[slug]);
	const last = labels.pop();
	if (last === undefined) return "";
	if (labels.length === 0) return last;
	return `${labels.join(", ")} and ${last}`;
}
