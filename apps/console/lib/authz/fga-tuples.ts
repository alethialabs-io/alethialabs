// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure expansion of Postgres grants → OpenFGA tuples (the IAM-like core). A role is
// a permission bundle; granting it writes one tuple per permission at the grant's
// scope. No SDK import — the ee/ writer takes these and calls the client. Pure ⇒
// unit-tested; the engine and the writer share this so they agree by construction.

import { descendantsOf } from "@/lib/authz/fga-hierarchy";
import { isOrgLevel } from "@/lib/authz/fga-mapping";
import { targetForEffect } from "@/lib/authz/grant-scope";
import { PERMISSIONS, type Resource } from "@/lib/authz/registry";

/** An OpenFGA relationship tuple: `<user>` has `<relation>` on `<object>`. */
export interface FgaTuple {
	user: string;
	relation: string;
	object: string;
}

export interface GrantScope {
	orgId: string;
	principalType: "user" | "team";
	principalId: string;
	/** allow grants confer access; deny grants write exclusion tuples. */
	effect: "allow" | "deny";
	/** Free text, as the column is. `grantTarget` classifies it; see lib/authz/grant-scope.ts. */
	resourceType: string;
	/** null ⇒ org-wide (the column's own contract); otherwise scoped to this resource. */
	resourceId: string | null;
}

/**
 * The pair `GrantScope` cannot represent honestly: an `"org"` resourceType carrying a
 * non-null resourceId.
 *
 * The hazard is that `"org"` is the DEFAULT resource kind at both write boundaries, so a caller
 * who names a resource and forgets its kind writes a row that reads as scoped to one project and
 * is not, with the id sitting beside it in the row and in the audit trail. That is why the pair is
 * REFUSED rather than collapsed: collapsing silently would be choosing one reading of a request
 * that plainly says two things.
 *
 * Refusing at the WRITE boundaries rather than inside `expandGrant` is still deliberate, and the
 * reason is unchanged: the id is persisted before any expander runs, so a guard in the expander
 * would leave the row in the table for every other consumer to interpret — including the access
 * UI, which joins nothing and renders "organization" while carrying the id.
 *
 * What HAS changed since #4581 is what the rest of the system makes of such a row if one is
 * already in the table. Both engines now route through `grantTarget` (lib/authz/grant-scope.ts),
 * which classifies the pair as conferring nothing at all. That is the #4584 ruling; the two
 * engines used to answer NARROW (Postgres) and ORGANIZATION-WIDE (OpenFGA) from the same row.
 *
 * A predicate plus a shared message, rather than a thrower, because the two boundaries report
 * differently: the server action throws, the CLI route returns a 400.
 */
export const ORG_SCOPE_WITH_RESOURCE_ID =
	'An "org" grant is organization-wide and cannot carry a resource id. ' +
	"Name the resource's own type (project, runner, cloud_identity) with the id, or drop the id.";

/** Whether a grant names the `"org"` kind while also carrying a resource id. */
export function orgScopeCarriesResourceId(
	resourceType: string,
	resourceId: string | null,
): boolean {
	return resourceId !== null && resourceType === "org";
}

const BY_KEY = new Map<string, (typeof PERMISSIONS)[number]>(
	PERMISSIONS.map((p) => [p.key, p]),
);

/** The OpenFGA subject string for a grant principal. */
function principalRef(scope: GrantScope): string {
	return scope.principalType === "team"
		? `team:${scope.principalId}#member`
		: `user:${scope.principalId}`;
}

/**
 * Expands a grant (its scope + the role's permission keys) into OpenFGA tuples.
 * - org-wide ⇒ each key becomes an org capability `org:<orgId> # <res>_<act>`.
 * - scoped to X:T ⇒ a key on T itself becomes `T:<X> # perm_<act>`; a key on a
 *   descendant type D becomes the container capability `T:<X> # D_<act>`; org-level
 *   keys and `create` are never conferred by a scoped grant (they stay org-wide).
 * - a scope that resolves to nothing ⇒ NO tuples at all.
 *
 * The three cases come from `grantTarget`, which `PostgresRbacPDP` reads too — the whole
 * point being that "what does this row scope to?" is answered in one place for both engines.
 */
export function expandGrant(
	scope: GrantScope,
	permissionKeys: readonly string[],
): FgaTuple[] {
	// The EFFECT is part of the question. An allow grant is being expanded into what it confers;
	// a deny grant into what it excludes, and for a row whose scope resolves to nothing those have
	// opposite safe answers. `targetForEffect` is the single place that distinction lives, shared
	// with `PostgresRbacPDP` — see `EMPTY_SCOPE_DENIES` in lib/authz/grant-scope.ts.
	const target = targetForEffect(scope.effect, scope.resourceType, scope.resourceId);
	// A self-contradictory row (an "org" kind carrying an id) or an unrecognised kind confers
	// nothing. Returning early rather than falling through a scoped branch is what keeps this
	// from writing tuples on an object type that does not exist.
	if (target.kind === "none") return [];

	const user = principalRef(scope);
	const deny = scope.effect === "deny";
	const d = deny ? "deny_" : ""; // relation infix for explicit-deny tuples
	const descendants =
		target.kind === "resource"
			? new Set<Resource>(descendantsOf(target.resourceType))
			: null;
	const tuples: FgaTuple[] = [];

	for (const key of permissionKeys) {
		const def = BY_KEY.get(key);
		if (!def) continue;
		const { resource, action } = def;

		if (target.kind === "org") {
			tuples.push({
				user,
				relation: `${resource}_${d}${action}`,
				object: `org:${scope.orgId}`,
			});
			continue;
		}

		const objectRef = `${target.resourceType}:${target.resourceId}`;
		// No `isInstanceType(resource)` guard here any more: `target.resourceType` is a
		// ScopableType, so `resource === target.resourceType` already proves it is one.
		if (resource === target.resourceType && !isOrgLevel(resource, action)) {
			tuples.push({ user, relation: `perm_${d}${action}`, object: objectRef });
		} else if (descendants?.has(resource) && !isOrgLevel(resource, action)) {
			tuples.push({ user, relation: `${resource}_${d}${action}`, object: objectRef });
		}
		// else: org-level / create / unrelated → not conferred by a scoped grant.
	}
	return tuples;
}

/** Hierarchy edge → the `parent` tuple `<child> # parent @ <parent>`. */
export function hierarchyTuple(edge: {
	childType: string;
	childId: string;
	parentType: string;
	parentId: string;
}): FgaTuple {
	return {
		user: `${edge.parentType}:${edge.parentId}`,
		relation: "parent",
		object: `${edge.childType}:${edge.childId}`,
	};
}

/** Team membership → `team:<teamId> # member @ user:<userId>`. */
export function teamMemberTuple(teamId: string, userId: string): FgaTuple {
	return { user: `user:${userId}`, relation: "member", object: `team:${teamId}` };
}
