// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure resolver that folds a project's + an environment's classification assignments into the
// frozen per-dimension map captured in a job's `config_snapshot` (B1.1). Kept separate from the
// DB read helpers in lib/queries/classification.ts so it is trivially unit-testable and reused by
// buildConfigSnapshot. The runner (B1.2+) maps the result onto per-cloud resource tags/labels.

import type { AssignedValue } from "@/lib/queries/classification";
import type { ClassificationSnapshot } from "@/types/jsonb.types";

/**
 * Resolves the effective classification for a provisioning job into the frozen
 * `{ dimension_key: value_slug[] }` snapshot map. Environment assignments OVERRIDE the
 * project's per dimension: if the environment pins any value on a dimension, that dimension's
 * project values are replaced entirely (not merged) — the environment is the more specific
 * scope. Dimensions the environment doesn't touch inherit the project's values; dimensions
 * only the environment carries are added.
 *
 * Output keys and value arrays are lexicographically sorted and de-duplicated so the snapshot
 * (and its downstream `configuration_hash`) is deterministic regardless of DB row order. The
 * returned object is frozen — it is an immutable point-in-time capture.
 *
 * @param projectAssignments  the project resource's assigned classification chips
 * @param environmentAssignments  the target environment's assigned classification chips
 */
export function resolveClassificationSnapshot(
	projectAssignments: readonly AssignedValue[],
	environmentAssignments: readonly AssignedValue[],
): ClassificationSnapshot {
	// Project layer is the base.
	const byDimension = new Map<string, Set<string>>();
	for (const a of projectAssignments) {
		const set = byDimension.get(a.dimension_key) ?? new Set<string>();
		set.add(a.value);
		byDimension.set(a.dimension_key, set);
	}

	// Environment layer overrides per dimension: collect env values per dimension first, then
	// replace (never merge) the project's entry for every dimension the environment touches.
	const envByDimension = new Map<string, Set<string>>();
	for (const a of environmentAssignments) {
		const set = envByDimension.get(a.dimension_key) ?? new Set<string>();
		set.add(a.value);
		envByDimension.set(a.dimension_key, set);
	}
	for (const [dimension, values] of envByDimension) {
		byDimension.set(dimension, values);
	}

	// Canonical, deterministic output: sorted dimension keys, sorted value slugs.
	const snapshot: ClassificationSnapshot = {};
	for (const dimension of [...byDimension.keys()].sort()) {
		const values = byDimension.get(dimension);
		if (!values) continue;
		snapshot[dimension] = [...values].sort();
	}
	Object.freeze(snapshot);
	return snapshot;
}
