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
// ⚠ THAT REASONING IS ABOUT `effect = 'allow'`. THE DENY DIRECTION IS A SEPARATE, RULED QUESTION.
//
// THE RULING (#4584, the maintainer's, and made knowingly — the option chosen stated this
// asymmetry explicitly):
//
//     allow  → confers NOTHING       (fail-closed: an ambiguous request is not a grant)
//     deny   → excludes ORG-WIDE     (fail-closed: an ambiguous exclusion is not a licence)
//
// ⚠ THE TWO ANSWERS ARE DIFFERENT VALUES AND THAT IS THE POINT — DO NOT "SIMPLIFY" IT AWAY.
// What is symmetric here is the DIRECTION (both fail closed), not the value. An earlier version of
// this comment said "both `none` cases fail CLOSED, which is the only direction a disagreement may
// be resolved in" while the code dropped BOTH — which is fail-closed for allow and fail-OPEN for
// deny. That sentence was false, and it is exactly the sentence a future reader would quote to
// collapse these two answers back into one.
//
// They cannot be one answer because they are not one question. `grantTarget` answers "what does
// this row CONFER?"; a deny row is asked "what does it EXCLUDE?", and `targetForEffect` is the
// seam where the second question gets its own answer. Concretely, for
//
//     (user U, effect='deny', permission_key='project:deploy', resource_type='org', resource_id=P)
//     + an org-wide ALLOW of project:deploy for U
//
// dropping the deny row would hand U a `deploy` on P that BOTH engines refuse today — and, because
// the tuples that deny row already wrote are still in the store and `backfill` never deletes them,
// it would also open a divergence in the opposite direction on precisely the rows this work exists
// to fix. `EMPTY_SCOPE_DENIES` below records the decision and the alternative it rejected.
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
 * What a DENY row whose scope resolves to nothing EXCLUDES. **RULED: the whole org** (#4584).
 *
 * A named constant rather than an inlined `{ kind: "org" }` on purpose. The decision stays
 * greppable, and the option that was REJECTED stays visible next to the one that was taken —
 * `"nothing"` is not dead weight in this union, it is the record of a choice.
 *
 * `"the_whole_org"` — TAKEN. The exclusion applies org-wide. Fail-closed: a row that cannot say
 *   what it excludes has not licensed anything. It is also what OpenFGA does for the `org`-kind
 *   pair TODAY (pre-#4584) and what the tuples every deployed store has ALREADY WRITTEN still say
 *   — `backfill` only ever writes — so NO DEPLOYED STORE'S DENY BEHAVIOUR CHANGES.
 *
 * `"nothing"` — REJECTED. Symmetric with the allow side by VALUE, and fail-OPEN: a subject denied
 *   a permission today gets it back, on both engines, from a row nobody edited.
 *
 * ⚠ A third reading — "excludes only the resource it names", i.e. what `PostgresRbacPDP` does
 * today — IS NOT ON THE MENU, and the reason is a finding rather than a preference: **OpenFGA
 * cannot express it.** It looks like the obvious right answer until you try to write the tuple.
 * The object would have to be `<resource_type>:<resource_id>`, which for the bad pair is
 * `org:<project-uuid>` — an object that does not exist; and writing `project:<uuid>` instead would
 * require KNOWING the id names a project, which is precisely what the row never says. (This is
 * also why `GrantTarget`'s `resource` arm is typed `ScopableType` and cannot hold one.) Choosing
 * it would move the divergence to a new place rather than close it. That collapsed a three-way
 * choice to two, and is what the ruling was made on.
 *
 * The annotation is the full union on purpose: it keeps `denyTarget`'s branches type-checking, so
 * the rejected option stays a real, compilable alternative rather than a comment about one.
 */
export const EMPTY_SCOPE_DENIES: "nothing" | "the_whole_org" = "the_whole_org";

/**
 * What a row resolves to for the engine that is asking about EXCLUSIONS.
 *
 * Identical to `grantTarget` except for the `none` case, which is the one where "confers" and
 * "excludes" come apart: an uninterpretable scope confers nothing and excludes the whole org
 * (#4584). Both engines call THIS for a deny row and `grantTarget` for an allow row, so the two
 * cannot drift.
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
