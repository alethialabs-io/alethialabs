// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The kind half of a grant's scope, validated in ONE place for both write boundaries.
//
// `grants.resource_type` is free `text` in Postgres and both writers reached it through a bare
// string: `z.string().min(1).default("org")` on app/api/cli/grants/route.ts and an untyped
// `resourceType: string` on app/server/actions/grants.ts. #4581's `orgScopeCarriesResourceId`
// refuses only the `org`+id pair, so every OTHER unrecognised kind was accepted (#4734).
//
// ⚠ WHY A TYPO IS NOT A COSMETIC DEFECT. Since #4584, an uninterpretable scope confers nothing and
// — on a DENY row — excludes the WHOLE ORG (`EMPTY_SCOPE_DENIES`, lib/authz/grant-scope.ts). So an
// access admin who means "deny project:deploy on project P" and writes `projects` (plural) posts a
// request that returns 200 and denies `project:deploy` org-wide, on both PDPs. The quieter half is
// the allow direction: a typo'd allow also returns success and confers nothing on either engine,
// which reads to the admin as "granted".
//
// Refusing the kind at the boundary is what makes both halves visible at the moment they are
// written, which is the only moment the person who typed it is present.

import { INSTANCE_TYPES, type ScopableType } from "@/lib/authz/fga-hierarchy";

/** A resource kind a grant may name: a scopable instance kind, or the org-wide wildcard. */
export type GrantResourceType = ScopableType | "org";

/**
 * Every kind a grant's `resource_type` may hold, in the order the refusal names them.
 *
 * DERIVED from `INSTANCE_TYPES` — lib/authz/fga-hierarchy.ts's `PARENTS` table, which is the set
 * `grantTarget` and `expandGrant` actually accept — plus `"org"`, the wildcard kind that is not an
 * instance type and carries no id. Adding a row to that table widens both write boundaries with
 * it; there is no second list here to fall out of step with the expander.
 */
export const GRANT_RESOURCE_TYPES: readonly GrantResourceType[] = [
	"org",
	...INSTANCE_TYPES,
];

const ACCEPTED: ReadonlySet<string> = new Set<string>(GRANT_RESOURCE_TYPES);

/**
 * The refusal both write boundaries return for an unrecognised kind.
 *
 * It NAMES THE ACCEPTED SET, and builds that half of the sentence from `GRANT_RESOURCE_TYPES`
 * rather than spelling it out: a message that listed the kinds by hand would go stale the first
 * time the hierarchy table gains a row, and an admin correcting a typo against a stale list is
 * worse off than one reading none. A constant rather than an inlined string, mirroring
 * `ORG_SCOPE_WITH_RESOURCE_ID` (lib/authz/fga-tuples.ts), so both boundaries answer identically
 * and the wording stays greppable from either of them.
 */
export const UNKNOWN_RESOURCE_TYPE = `Unknown resource_type. A grant is scoped to one of: ${GRANT_RESOURCE_TYPES.join(", ")}.`;

/**
 * Whether a string names a kind a grant may be written with.
 *
 * Total over arbitrary text on purpose — both callers hold a value that has been through nothing
 * stronger than "is a non-empty string" — and the narrowing is what lets a caller go on to treat
 * it as a `GrantResourceType` without a cast.
 */
export function isGrantResourceType(value: string): value is GrantResourceType {
	return ACCEPTED.has(value);
}
