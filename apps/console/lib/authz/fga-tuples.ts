// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure expansion of Postgres grants → OpenFGA tuples (the IAM-like core). A role is
// a permission bundle; granting it writes one tuple per permission at the grant's
// scope. No SDK import — the ee/ writer takes these and calls the client. Pure ⇒
// unit-tested; the engine and the writer share this so they agree by construction.

import { descendantsOf } from "@/lib/authz/fga-hierarchy";
import { isOrgLevel } from "@/lib/authz/fga-mapping";
import {
	type GrantResource,
	grantResourceForEffect,
} from "@/lib/authz/grant-scope";
import { PERMISSIONS, type Resource } from "@/lib/authz/registry";
import {
	isGrantResourceType,
	UNKNOWN_RESOURCE_TYPE,
} from "@/lib/validations/grants";

/** An OpenFGA relationship tuple: `<user>` has `<relation>` on `<object>`. */
export interface FgaTuple {
	user: string;
	relation: string;
	object: string;
}

/** Who a grant is for, and whether it confers or excludes. */
export interface GrantPrincipal {
	orgId: string;
	principalType: "user" | "team";
	principalId: string;
	/** allow grants confer access; deny grants write exclusion tuples. */
	effect: "allow" | "deny";
}

/**
 * A grant the expander can expand: a principal plus a `GrantResource` (lib/authz/grant-scope.ts).
 *
 * A discriminated union on `resourceType` (#4582). The org arm has no `resourceId` field — typed
 * `never`, so not even a non-fresh object carrying one is assignable — and the resource arm
 * requires a non-null id on a `ScopableType`. `("org", <id>)` and `(<unknown kind>, <id>)` are
 * therefore not constructible from TypeScript; `tsc` is what refuses them, and
 * tests/authz/fga-tuples.test.ts pins that with `@ts-expect-error`.
 *
 * It used to be `resourceType: string; resourceId: string | null`, and the expander re-classified
 * every value through `targetForEffect`. The classification has not gone anywhere — it moved to
 * the two places a value ENTERS this type: `parseGrantResource` for a request (which refuses) and
 * `grantScopeFromRow` for a row already in the table (which applies the #4584 ruling).
 */
export type GrantScope = GrantPrincipal & GrantResource;

/**
 * The refusal for an `"org"` kind that also carries a resource id.
 *
 * The hazard is that `"org"` is the DEFAULT resource kind at both write boundaries, so a caller
 * who names a resource and forgets its kind writes a row that reads as scoped to one project and
 * is not, with the id sitting beside it in the row and in the audit trail. That is why the pair is
 * REFUSED rather than collapsed: collapsing silently would be choosing one reading of a request
 * that plainly says two things.
 *
 * Refusing at the WRITE boundaries rather than inside `expandGrant` is still deliberate: the id is
 * persisted before any expander runs, so a guard in the expander would leave the row in the table
 * for every other consumer to interpret — including the access UI, which joins nothing and renders
 * "organization" while carrying the id. Since #4582 the refusal lives in `parseGrantResource`,
 * and what makes both boundaries route through it is the compiler: `ScopedGrant` needs a
 * `GrantResource`, and a request's two strings become one only by being parsed.
 *
 * A row of this shape that is ALREADY in the table confers nothing on allow and excludes org-wide
 * on deny, on both engines (`grantTarget`/`targetForEffect`, the #4584 ruling).
 */
export const ORG_SCOPE_WITH_RESOURCE_ID =
	'An "org" grant is organization-wide and cannot carry a resource id. ' +
	"Name the resource's own type (project, runner, cloud_identity) with the id, or drop the id.";

/**
 * The refusal for an empty-string resource id. The write boundaries used to derive the kind from
 * the id's TRUTHINESS (`resourceId ? kind : "org"`) while storing the id as given, so `("project",
 * "")` was stored as `("org", "")` — the contradictory pair, reached without naming `"org"`.
 * Reading `""` as "no id" instead would turn a project-scoped request into an org-wide grant, so
 * it is refused.
 */
export const EMPTY_RESOURCE_ID =
	"A resource id cannot be empty. Omit it for an organization-wide grant.";

/** What `parseGrantResource` returns: the typed scope, or the refusal to send back. */
export type ParsedGrantResource =
	| { readonly ok: true; readonly resource: GrantResource }
	| { readonly ok: false; readonly error: string };

/**
 * Parses a write request's `(resource_type, resource_id)` into a `GrantResource`, or refuses it.
 *
 * The ONE place a request's two free strings become the typed scope, shared by both write
 * boundaries (app/server/actions/grants.ts and app/api/cli/grants/route.ts). The refusals: a kind
 * outside `GRANT_RESOURCE_TYPES` (`UNKNOWN_RESOURCE_TYPE`, #4734 — checked before the null-id case
 * so a misspelled kind sent without an id is not laundered into an org-wide grant), the `"org"`
 * kind with an id (`ORG_SCOPE_WITH_RESOURCE_ID`), and an empty id (`EMPTY_RESOURCE_ID`). A scopable kind with no id is org-wide, which is what both boundaries
 * stored before this existed.
 */
export function parseGrantResource(
	resourceType: string,
	resourceId: string | null,
): ParsedGrantResource {
	// "org" IS a `GrantResourceType`, so this cannot mask the org-with-an-id refusal below.
	if (!isGrantResourceType(resourceType)) {
		return { ok: false, error: UNKNOWN_RESOURCE_TYPE };
	}
	if (resourceType === "org") {
		return resourceId === null
			? { ok: true, resource: { resourceType: "org" } }
			: { ok: false, error: ORG_SCOPE_WITH_RESOURCE_ID };
	}
	// From here `resourceType` is a `ScopableType` — the `"org"` arm of `GrantResourceType` was
	// just returned from, and the compiler narrows on that, so no cast is needed.
	if (resourceId === null) return { ok: true, resource: { resourceType: "org" } };
	if (resourceId === "") return { ok: false, error: EMPTY_RESOURCE_ID };
	return { ok: true, resource: { resourceType, resourceId } };
}

/** The raw columns of a `grants` row that decide its scope, as read back out of Postgres. */
export interface GrantScopeRow {
	orgId: string;
	principalType: "user" | "team";
	principalId: string;
	effect: "allow" | "deny";
	/** Free text, as the column is. */
	resourceType: string;
	/** null ⇒ org-wide (the column's own contract). */
	resourceId: string | null;
}

/**
 * Narrows a row already in the table to a `GrantScope`, or null when it resolves to nothing for
 * its effect. Under the #4584 ruling only an ALLOW row can: the contradictory pair and an
 * unrecognised kind confer nothing, while a DENY row of either shape excludes org-wide
 * (`EMPTY_SCOPE_DENIES`) and comes back as the org arm. A null row has no object this writer can
 * attribute tuples to, so there is nothing to write, read or delete for it.
 *
 * Rows cannot be refused — they are already stored — so this is where the #4584 ruling is applied
 * instead, through `grantResourceForEffect` (which is `targetForEffect` with a type). It is what
 * the revoke paths and ee's `resyncRole`/`backfill` call; none of them builds a `GrantScope` from
 * the columns directly, because the type no longer lets them.
 */
export function grantScopeFromRow(row: GrantScopeRow): GrantScope | null {
	const resource = grantResourceForEffect(row.effect, row.resourceType, row.resourceId);
	if (resource === null) return null;
	const principal: GrantPrincipal = {
		orgId: row.orgId,
		principalType: row.principalType,
		principalId: row.principalId,
		effect: row.effect,
	};
	return { ...principal, ...resource };
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
 * - org-wide (`resourceType === "org"`) ⇒ each key becomes an org capability
 *   `org:<orgId> # <res>_<act>`.
 * - scoped to X:T ⇒ a key on T itself becomes `T:<X> # perm_<act>`; a key on a
 *   descendant type D becomes the container capability `T:<X> # D_<act>`; org-level
 *   keys and `create` are never conferred by a scoped grant (they stay org-wide).
 *
 * There is no "scopes to nothing" case any more: `GrantScope` cannot hold one. A row that confers
 * or excludes nothing is stopped one step earlier, by `grantScopeFromRow` returning null, and a
 * request that says two things is refused by `parseGrantResource`. Both of those apply
 * `targetForEffect`, which `PostgresRbacPDP` reads too — so "what does this row scope to?" is
 * still answered in one place for both engines; this function just no longer re-asks it.
 */
export function expandGrant(
	scope: GrantScope,
	permissionKeys: readonly string[],
): FgaTuple[] {
	const user = principalRef(scope);
	const d = scope.effect === "deny" ? "deny_" : ""; // relation infix for explicit-deny tuples
	const tuples: FgaTuple[] = [];

	if (scope.resourceType === "org") {
		for (const key of permissionKeys) {
			const def = BY_KEY.get(key);
			if (!def) continue;
			tuples.push({
				user,
				relation: `${def.resource}_${d}${def.action}`,
				object: `org:${scope.orgId}`,
			});
		}
		return tuples;
	}

	const objectRef = `${scope.resourceType}:${scope.resourceId}`;
	const descendants = new Set<Resource>(descendantsOf(scope.resourceType));
	for (const key of permissionKeys) {
		const def = BY_KEY.get(key);
		if (!def) continue;
		const { resource, action } = def;
		// No `isInstanceType(resource)` guard: `scope.resourceType` is a ScopableType, so
		// `resource === scope.resourceType` already proves it is one.
		if (resource === scope.resourceType && !isOrgLevel(resource, action)) {
			tuples.push({ user, relation: `perm_${d}${action}`, object: objectRef });
		} else if (descendants.has(resource) && !isOrgLevel(resource, action)) {
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
