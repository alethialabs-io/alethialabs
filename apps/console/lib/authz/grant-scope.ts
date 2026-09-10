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
// you run decided by an instance-wide environment switch (#4584).
//
// ⚠ WHAT EXTRACTING THE PREDICATE DOES AND DOES NOT BUY. It removes ONE class of divergence — two
// readers of a row's scope reaching different conclusions. It does NOT make divergence impossible
// by construction, and an earlier version of this comment said it did. The two engines share a
// PREDICATE; they do not share STATE. `backfill` only ever writes (it never deletes), the sync
// calls are fire-and-forget (`void … .catch`), and Postgres stays authoritative — so a store that
// has drifted from the table still answers differently from one that has not, and no predicate
// can fix that. The deny question immediately below is a live example: the same predicate, asked a
// question it does not answer, produces a NEW divergence. Store/table skew is a separate problem
// and is still open.
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
// ⚠ THAT REASONING HOLDS FOR `effect = 'allow'` ONLY, AND THE DENY DIRECTION IS UNDECIDED.
//
// An earlier version of this comment said "both `none` cases fail CLOSED, which is the only
// direction a disagreement may be resolved in". That is FALSE for a deny row, and it is exactly
// the sentence someone would later quote to justify widening this predicate.
//
// `grantTarget` answers ONE question: what does this row CONFER? `PostgresRbacPDP` asks it twice —
// once of the allow rows and once of the deny rows — and for the deny rows the question is what
// does this row EXCLUDE. Those are different questions, and a `none` answer means opposite things:
// conferring nothing is fail-CLOSED, excluding nothing is fail-OPEN. Concretely, for
//
//     (user U, effect='deny', permission_key='project:deploy', resource_type='org', resource_id=P)
//     + an org-wide ALLOW of project:deploy for U
//
// dropping the deny row hands U a `deploy` on P that BOTH engines refuse today — and, because the
// tuples that deny row already wrote are still in the store and `backfill` never deletes them, it
// also opens a divergence in the opposite direction on precisely the rows this work exists to fix.
//
// So the deny side is held behind `EMPTY_SCOPE_DENIES` below, and the ruling is the maintainer's.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────────
// It does not remove OpenFGA tuples an ALREADY-EXISTING bad row wrote under the old reading. Those
// live on `org:<orgId>` and are indistinguishable there from the tuples of a legitimate org-wide
// grant conferring the same permission on the same subject, so deleting them blind would revoke
// real access. That is precisely the question the #4583 audit
// (docs/ops/grants-scope-contradictions.sql) answers per row, and it is the maintainer's to answer
// before any of this lands.

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
 * ⚠ UNDECIDED — AWAITING THE MAINTAINER'S RULING (#4584, the deny direction).
 *
 * What a DENY row that scopes to nothing EXCLUDES. `grantTarget` cannot answer this: it answers
 * what a row CONFERS, and a deny row is asked the opposite question (see the note at the top of
 * this file). Flip this one constant when the ruling lands — `denyTarget` below, both PDP engines
 * and every fixture that exercises them read it, so nothing else has to move.
 *
 * `"nothing"` — CURRENT, and it is FAIL-OPEN. A deny row that scopes to nothing excludes nothing,
 *   so a subject who is denied a permission on one resource today gets it back. It is symmetric
 *   with the allow side and it is the reading that makes the row simply not exist.
 *
 * `"the_whole_org"` — the exclusion applies org-wide. Fail-CLOSED. It is also what OpenFGA does
 *   for the `org`-kind pair TODAY (pre-#4584), and what the tuples an existing bad row has
 *   ALREADY WRITTEN still say — `backfill` never deletes them — so it is the only option under
 *   which no deployed store's deny behaviour changes at all.
 *
 * A third reading — "excludes only the resource it names", i.e. what `PostgresRbacPDP` does today
 * — is deliberately ABSENT, and the reason is a finding rather than a preference: OpenFGA cannot
 * express it. There is no object of that type and id to hang a deny tuple on, which is why
 * `GrantTarget`'s `resource` arm is typed `ScopableType` and cannot hold one. Choosing it would
 * re-open the divergence in a new place rather than close it, so the two options above are the
 * two that are expressible on BOTH engines.
 *
 * The annotation is the full union on purpose: it keeps every branch below type-checking, so
 * changing the value is genuinely a one-line edit and not a compile error hunt.
 */
export const EMPTY_SCOPE_DENIES: "nothing" | "the_whole_org" = "nothing";

/**
 * What a row resolves to for the engine that is asking about EXCLUSIONS.
 *
 * Identical to `grantTarget` except for the `none` case, which is the one where "confers" and
 * "excludes" come apart. Both engines call THIS for a deny row and `grantTarget` for an allow row,
 * so whichever way the ruling goes they move together.
 */
export function denyTarget(
	resourceType: string,
	resourceId: string | null,
): GrantTarget {
	const target = grantTarget(resourceType, resourceId);
	if (target.kind !== "none") return target;
	return EMPTY_SCOPE_DENIES === "the_whole_org" ? { kind: "org" } : target;
}

/**
 * The target a row resolves to for a given effect — the single entry point both engines use, so
 * neither can forget that the two effects ask different questions.
 */
export function targetForEffect(
	effect: "allow" | "deny",
	resourceType: string,
	resourceId: string | null,
): GrantTarget {
	return effect === "deny"
		? denyTarget(resourceType, resourceId)
		: grantTarget(resourceType, resourceId);
}

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
