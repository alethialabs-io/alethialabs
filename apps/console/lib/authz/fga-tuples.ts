// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure expansion of Postgres grants → OpenFGA tuples (the IAM-like core). A role is
// a permission bundle; granting it writes one tuple per permission at the grant's
// scope. No SDK import — the ee/ writer takes these and calls the client. Pure ⇒
// unit-tested; the engine and the writer share this so they agree by construction.

import { descendantsOf, isInstanceType } from "@/lib/authz/fga-hierarchy";
import { isOrgLevel } from "@/lib/authz/fga-mapping";
import { PERMISSIONS, RESOURCES, type Resource } from "@/lib/authz/registry";

const RESOURCE_SET = new Set<string>(RESOURCES);
function isResource(s: string): s is Resource {
	return RESOURCE_SET.has(s);
}

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
	resourceType: string;
	/** null / "org" resourceType ⇒ org-wide; otherwise scoped to this resource. */
	resourceId: string | null;
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
 */
export function expandGrant(
	scope: GrantScope,
	permissionKeys: readonly string[],
): FgaTuple[] {
	const user = principalRef(scope);
	const deny = scope.effect === "deny";
	const d = deny ? "deny_" : ""; // relation infix for explicit-deny tuples
	const orgWide = scope.resourceId === null || scope.resourceType === "org";
	const scopedType: Resource | null =
		!orgWide && isResource(scope.resourceType) ? scope.resourceType : null;
	const descendants = scopedType ? new Set(descendantsOf(scopedType)) : null;
	const tuples: FgaTuple[] = [];

	for (const key of permissionKeys) {
		const def = BY_KEY.get(key);
		if (!def) continue;
		const { resource, action } = def;

		if (orgWide) {
			tuples.push({
				user,
				relation: `${resource}_${d}${action}`,
				object: `org:${scope.orgId}`,
			});
			continue;
		}

		const objectRef = `${scope.resourceType}:${scope.resourceId}`;
		if (
			resource === scope.resourceType &&
			isInstanceType(resource) &&
			!isOrgLevel(resource, action)
		) {
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
