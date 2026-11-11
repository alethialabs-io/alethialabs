// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a deprecated catalogue add-on means for one environment (#6543).
//
// A deprecation has two phases, split by the entry's `removalDate`:
//
//   before   a new install is still accepted, but the console steers it to the replacement: the
//            palette marks the add-on, and its card leads with the replacement instead of the form.
//   from     a NEW install is refused, by `enableAddon`, so the CLI and the console cannot disagree.
//
// In both phases an environment that ALREADY has the add-on keeps it. It deploys, it can be
// reconfigured and pinned, and it is shown the reason, the date and the migration guide. Removing an
// add-on from a running cluster is the user's decision, never the catalogue's.
//
// It imports nothing server-only, so the client card calls it directly.

import type { AddOnDeprecation } from "./types";

/** The deprecation as the console shows it: the catalogue marker plus the replacement's name. */
export interface AddOnDeprecationView extends AddOnDeprecation {
	/** The replacement's display name, resolved from the catalogue. */
	replacementName: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a `YYYY-MM-DD` removal date as the start of that day in UTC. Returns null for anything else,
 * including a well-formed string that names no real day (`2027-02-30`), so a typo cannot quietly
 * move the date.
 */
export function parseRemovalDate(date: string): Date | null {
	const m = ISO_DATE.exec(date);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const at = new Date(Date.UTC(y, mo - 1, d));
	if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
		return null;
	}
	return at;
}

/**
 * Whether the add-on has stopped taking NEW installs at `now`: true from the start of the removal
 * day (UTC). An unparseable date counts as closed — the catalogue test refuses one, and failing
 * closed means a broken marker cannot keep a retired chart open for new installs.
 */
export function closedToNewInstalls(dep: AddOnDeprecation, now: Date): boolean {
	const at = parseRemovalDate(dep.removalDate);
	return at === null || now.getTime() >= at.getTime();
}

/**
 * The sentence refusing a new install of a deprecated add-on, or null when the install is allowed:
 * the add-on is not deprecated, its removal date has not arrived, or the environment already has it
 * (a reconfigure is never refused). Shown verbatim by the console and the CLI.
 */
export function newInstallRefusal(
	def: { name: string; deprecated?: AddOnDeprecation | null },
	replacementName: string,
	alreadyInstalled: boolean,
	now: Date,
): string | null {
	const dep = def.deprecated;
	if (!dep || alreadyInstalled || !closedToNewInstalls(dep, now)) return null;
	return `${def.name} is deprecated and no longer accepts new installs (since ${dep.removalDate}). ${dep.reason} Enable ${replacementName} (${dep.replacementId}) instead; ${dep.migrationGuideUrl} explains the move.`;
}
