// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE version comparator for the capability lanes.
//
// It exists because there were two, in opposite directions: `compareVersion` in services/aws.ts
// returned >0 when `a` was newer, and `compareVersionsDesc` in services/gcp.ts returned <0 when `a`
// was newer. Both were module-private, so nothing forced them to agree — and "which one is latest"
// is exactly the question a silently-inverted comparator gets wrong.
//
// Now that the lanes emit EVERY offered version rather than collapsing to the latest, the comparator
// stops being a reducer and becomes the sort order the picker shows. That makes one shared,
// unit-tested definition worth more than two private ones.

/**
 * Compares two dotted-numeric version strings ("16", "8.0", "15.4"). Returns >0 when `a` is newer,
 * <0 when `b` is newer, 0 when they order equally.
 *
 * Missing trailing segments count as 0, so "16" and "16.0" compare equal. A non-numeric segment
 * makes the pair incomparable (0) rather than guessing — cloud engine versions are occasionally
 * labelled ("8.0.mysql_aurora.3.05.2"), and inventing an order for those would be a wrong verdict
 * dressed as a right one.
 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] === undefined ? 0 : Number.parseInt(pa[i], 10);
		const y = pb[i] === undefined ? 0 : Number.parseInt(pb[i], 10);
		if (Number.isNaN(x) || Number.isNaN(y)) return 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/**
 * Sorts version strings newest-first — the order a version picker should offer them in. Returns a new
 * array; input order is preserved for versions that compare equal, so a stable upstream order (the
 * cloud's own listing) survives.
 */
export function sortVersionsDesc(versions: readonly string[]): string[] {
	return [...versions].sort((a, b) => compareVersions(b, a));
}

/**
 * Deduplicates version strings, keeping the newest-first order. Cloud APIs repeat the same version
 * across editions (Azure) and zones (Alibaba), so the lanes all need this.
 */
export function dedupeVersionsDesc(versions: readonly string[]): string[] {
	return sortVersionsDesc([...new Set(versions)]);
}
