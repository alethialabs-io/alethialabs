// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The resource hierarchy DAG (parent types per instance resource). Single source of
// truth shared by the FGA model generator and the tuple expander, so they agree by
// construction. Org-level resources (org/member/activity/billing) and `job` are NOT
// instance types: job is ephemeral + high-volume and never individually shared, so
// its permissions resolve at the org (org-wide grants only).

import type { Resource } from "@/lib/authz/registry";

export const PARENTS: Partial<Record<Resource, Resource[]>> = {
	project: ["org"],
	runner: ["org"],
	cloud_identity: ["org"],
	connector: ["org"],
};

/** The per-id resource types (those with a parent chain). */
export const INSTANCE_TYPES = Object.keys(PARENTS) as Resource[];

/** True when a resource has its own per-instance object (vs. an org-level capability). */
export function isInstanceType(resource: Resource): boolean {
	return resource in PARENTS;
}

/** Transitive ancestor types of a resource via PARENTS (excludes the resource itself). */
export function ancestorsOf(resource: Resource): Resource[] {
	const out = new Set<Resource>();
	const stack = [...(PARENTS[resource] ?? [])];
	while (stack.length > 0) {
		const p = stack.pop();
		if (p === undefined || out.has(p)) continue;
		out.add(p);
		for (const pp of PARENTS[p] ?? []) stack.push(pp);
	}
	return [...out];
}

/** Instance types below `resource` in the hierarchy (its scopable descendants). */
export function descendantsOf(resource: Resource): Resource[] {
	return INSTANCE_TYPES.filter(
		(t) => t !== resource && ancestorsOf(t).includes(resource),
	);
}
