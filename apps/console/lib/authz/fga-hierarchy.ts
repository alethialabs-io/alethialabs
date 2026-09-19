// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The resource hierarchy DAG (parent types per instance resource). Single source of
// truth shared by the FGA model generator and the tuple expander, so they agree by
// construction. Org-level resources (org/member/activity/billing) and `job` are NOT
// instance types: job is ephemeral + high-volume and never individually shared, so
// its permissions resolve at the org (org-wide grants only).

import { lookup, typedKeys } from "@/lib/typed-object";
import type { Resource } from "@/lib/authz/registry";

/**
 * `as const satisfies` rather than a plain annotation, so `keyof typeof PARENTS` is the four
 * literals and not all of `Resource`. That is what makes `ScopableType` below a CLOSED union
 * derived from this table — add a row here and the scopable set grows with it; there is no
 * second list to keep in step. `satisfies` still holds every key and every parent to `Resource`,
 * so a typo is a compile error exactly as it was under the annotation.
 */
export const PARENTS = {
	project: ["org"],
	runner: ["org"],
	cloud_identity: ["org"],
	connector: ["org"],
} as const satisfies Partial<Record<Resource, readonly Resource[]>>;

/**
 * A resource kind a grant can be SCOPED to — the kinds with their own per-instance object.
 *
 * NOT `GRANT_SCOPES` (lib/queries/access-grants.ts), which is a read-side facet list and omits
 * `connector`: a connector-scoped grant expands correctly today, so adopting that list would make
 * working code uncompilable. The hierarchy table is the set the expander actually accepts.
 */
export type ScopableType = keyof typeof PARENTS;

/** The per-id resource types (those with a parent chain). */
export const INSTANCE_TYPES: readonly ScopableType[] = typedKeys(PARENTS);

const SCOPABLE = new Set<string>(INSTANCE_TYPES);

/** True when a resource has its own per-instance object (vs. an org-level capability). */
export function isInstanceType(resource: Resource): resource is ScopableType {
	return SCOPABLE.has(resource);
}

/**
 * Whether an arbitrary string (a `grants.resource_type` read back from the table, say — the
 * column is free text) names a kind a grant can be scoped to.
 */
export function isScopableType(value: string): value is ScopableType {
	return SCOPABLE.has(value);
}

/** Transitive ancestor types of a resource via PARENTS (excludes the resource itself). */
export function ancestorsOf(resource: Resource): Resource[] {
	const out = new Set<Resource>();
	// `lookup` reads an owned exact record by a possibly-absent key without casting — PARENTS is
	// now keyed by its four literals, and `resource` is any Resource.
	const stack: Resource[] = [...(lookup(PARENTS, resource) ?? [])];
	while (stack.length > 0) {
		const p = stack.pop();
		if (p === undefined || out.has(p)) continue;
		out.add(p);
		for (const pp of lookup(PARENTS, p) ?? []) stack.push(pp);
	}
	return [...out];
}

/** Instance types below `resource` in the hierarchy (its scopable descendants). */
export function descendantsOf(resource: Resource): ScopableType[] {
	return INSTANCE_TYPES.filter(
		(t) => t !== resource && ancestorsOf(t).includes(resource),
	);
}
