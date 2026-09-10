// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ONE answer to "what does this grant row scope to?", consumed by BOTH policy engines.
//
// Alethia ships two swappable PDPs behind the same seam: the community `PostgresRbacPDP` (scoped
// RBAC over the `grants` table) and the enterprise OpenFGA engine (`expandGrant` → tuples). They
// must reach the same decision from the same row, and before this module they each answered this
// question for themselves, in code that never met:
//
//   * `PostgresRbacPDP` did not project `resource_type` at all — any non-null `resource_id` was
//     scoped to that id (`coversResource` keys on the id alone).
//   * `expandGrant` computed `orgWide = resourceId === null || resourceType === "org"` — so an
//     `org` kind carrying an id was ORGANIZATION-WIDE and the id was dropped before any tuple.
//
// One row, narrow on one engine and org-wide on the other, on an `allow` grant, with which engine
// you run decided by an instance-wide environment switch (#4584). Extracting the predicate is the
// fix; the point is not that the two agree today but that there is no longer a second place for
// them to disagree in.
//
// ── THE RULING (#4584) ──────────────────────────────────────────────────────────────────────────
// A non-null `resource_id` is NOT org-wide, on any engine. `resource_id NULL = org-wide (wildcard)`
// is the column's own contract (lib/db/schema/authz.ts), so a row that carries an id has said it
// is not the wildcard. OpenFGA is the side that changes.
//
// The `org` kind is then simply not a kind a grant can be SCOPED to — it has no per-instance
// object, and `ScopableType` is derived from the hierarchy table that says so. A row naming it
// alongside an id has therefore said two incompatible things, and neither reading can be taken:
// "org-wide" is the broader reading of an ambiguous request (the reason #4581 refuses the pair at
// both write boundaries rather than collapsing it), and "scoped to that id" invents a resource
// kind the row never named. So it confers NOTHING, on both engines — `kind: "none"`.
//
// An UNRECOGNISED `resource_type` lands in the same place, and that closes a second divergence for
// free: `expandGrant` already produced zero tuples for one (no object type to write on), while the
// Postgres PDP read it as an ordinary scoped grant on that id. `resource_type` is free `text` in
// Postgres, so this is reachable from any writer that does not go through the console — raw SQL in
// lib/authz/grants.ts and lib/authz/seed.ts among them.
//
// Both `none` cases fail CLOSED, which is the only direction a disagreement may be resolved in.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────────
// It does not remove OpenFGA tuples an ALREADY-EXISTING bad row wrote under the old reading. Those
// live on `org:<orgId>` and are indistinguishable there from the tuples of a legitimate org-wide
// grant conferring the same permission on the same subject, so deleting them blind would revoke
// real access. That is precisely the question the #4583 audit
// (docs/ops/grants-org-kind-with-resource-id.sql) answers per row, and it is the maintainer's to
// answer before any of this lands.

import { isScopableType, type ScopableType } from "@/lib/authz/fga-hierarchy";

/**
 * What a grant row scopes to.
 *
 * - `org` — organization-wide (the wildcard): every resource in the org, present and future.
 * - `resource` — this one instance and, through the hierarchy, its descendants.
 * - `none` — the row is self-contradictory and confers nothing. `reason` names which way.
 */
export type GrantTarget =
	| { readonly kind: "org" }
	| {
			readonly kind: "resource";
			readonly resourceType: ScopableType;
			readonly resourceId: string;
	  }
	| {
			readonly kind: "none";
			readonly reason: "org_kind_with_resource_id" | "unscopable_resource_kind";
	  };

/**
 * Classifies a `grants` row's scope. Total over the raw column types (`resource_type` is free
 * `text` and `resource_id` is nullable), so a row read straight back out of Postgres — which is
 * what `resyncRole` and `backfill` do on every boot — always lands on exactly one branch.
 */
export function grantTarget(
	resourceType: string,
	resourceId: string | null,
): GrantTarget {
	if (resourceId === null) return { kind: "org" };
	if (isScopableType(resourceType)) {
		return { kind: "resource", resourceType, resourceId };
	}
	return {
		kind: "none",
		reason:
			resourceType === "org"
				? "org_kind_with_resource_id"
				: "unscopable_resource_kind",
	};
}
