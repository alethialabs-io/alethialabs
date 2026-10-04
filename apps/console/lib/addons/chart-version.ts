// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE definition of what a catalog add-on's chart-version pin may be (#5525).
//
// A pin is stored in `project_addons.version` and the runner renders it into the ArgoCD
// Application's `spec.source.targetRevision`. That makes this check the injection boundary for the
// value: the runner marshals the manifest with yaml.v3 (packages/core/argocd/addons.go) rather than
// interpolating it, but a value that is not a plain version has no business reaching the cluster in
// any form, and a refusal here is the only place the user can still be told what went wrong.
//
// So the rule is narrow on purpose — an EXACT SemVer 2.0 version, optionally with a leading `v`
// (some chart repositories tag that way), at most 64 characters. A range (`^58`, `~58.2`, `>=58`,
// `*`) is refused: ArgoCD would resolve it at sync time, so the pin would move under the user — the
// opposite of pinning. Whitespace, newlines, quotes, `{{` and YAML document markers all fail the
// pattern because none of them is a SemVer character.
//
// This module imports nothing server-only, so the console form, the server action and the CLI route
// all ask the same question.

import { z } from "zod";

/** The longest chart version accepted. Real chart versions are well under this. */
export const CHART_VERSION_MAX_LENGTH = 64;

/**
 * SemVer 2.0 (semver.org's recommended pattern), with an optional leading `v`. JavaScript's `$`
 * without the `m` flag matches only at the end of the input, so a trailing newline is refused.
 */
const EXACT_SEMVER =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The sentence a refused version gets — written for the person who typed it. */
export const CHART_VERSION_REFUSAL =
	"A chart version must be one exact version, such as 58.2.1 or v1.4.0-rc.1. Ranges (^58, ~58.2, >=58, *), spaces and quotes are not accepted — leave it empty to use the catalog's default version.";

/** The sentence an over-long version gets. */
export const CHART_VERSION_TOO_LONG = `A chart version is at most ${CHART_VERSION_MAX_LENGTH} characters.`;

/** A non-empty, exact chart version. */
export const chartVersionSchema = z
	.string()
	.max(CHART_VERSION_MAX_LENGTH, CHART_VERSION_TOO_LONG)
	.regex(EXACT_SEMVER, CHART_VERSION_REFUSAL);

/**
 * Returns why `value` is not an acceptable chart version, or null when it is. An empty string is
 * acceptable: it means "no pin — use the catalog default".
 */
export function chartVersionError(value: string): string | null {
	if (value === "") return null;
	const parsed = chartVersionSchema.safeParse(value);
	return parsed.success ? null : (parsed.error.issues[0]?.message ?? CHART_VERSION_REFUSAL);
}

/**
 * What a write should do with the stored pin: `keep` it (the caller did not mention a version),
 * `clear` it (null or the empty string — the catalog default applies again), or `set` it.
 */
export type ChartVersionIntent =
	| { kind: "keep" }
	| { kind: "clear" }
	| { kind: "set"; version: string };

/**
 * Turns the `version` a caller sent into a write intent, refusing an invalid version with a sentence
 * the user can act on. `undefined` keeps the stored pin; `null` or `""` clears it.
 */
export function chartVersionIntent(value: string | null | undefined): ChartVersionIntent {
	if (value === undefined) return { kind: "keep" };
	if (value === null || value === "") return { kind: "clear" };
	const error = chartVersionError(value);
	if (error) throw new Error(`Invalid chart version: ${error}`);
	return { kind: "set", version: value };
}
