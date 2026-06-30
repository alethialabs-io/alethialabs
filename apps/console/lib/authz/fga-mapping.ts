// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Maps a (resource, action) authorization question to the OpenFGA (object, relation)
// it checks. Shared by the OpenFgaPdp (ee/) and the model-coverage tests, so the
// generated model and the engine agree by construction.

import type { Action, Resource } from "@/lib/authz/registry";

// Resources whose actions are org-level capabilities — they have no per-instance
// object, so they're always checked on the org. `job` is included: jobs are
// ephemeral + high-volume and never individually shared, so their permissions
// resolve org-wide (kept in sync with lib/authz/fga-hierarchy.ts, which excludes
// job from the instance types).
const ORG_LEVEL: ReadonlySet<Resource> = new Set<Resource>([
	"org",
	"member",
	"activity",
	"billing",
	"job",
	// Alert policies are org-scoped config — no per-instance object, resolved org-wide.
	"alert",
	// Fleet pools are global operator config — no per-instance object, resolved org-wide.
	"fleet",
]);

export interface FgaCheck {
	/** OpenFGA object, e.g. "org:<uuid>" or "project:<uuid>". */
	object: string;
	/** OpenFGA relation, e.g. "project_create" (org capability) or "can_view" (instance). */
	relation: string;
}

/**
 * True when the (resource, action) is an ORG-level capability rather than a
 * per-instance permission: org/member/activity/billing actions, and every `create`
 * (you create a resource of a type within the org, not on a specific instance).
 */
export function isOrgLevel(resourceType: Resource, action: Action): boolean {
	return action === "create" || ORG_LEVEL.has(resourceType);
}

/**
 * The OpenFGA check for an authorization question. Org-level/create actions, and
 * per-instance actions asked without a concrete id ("can I at all?"), resolve to the
 * org capability `<resource>_<action>` on `org:<orgId>`. A per-instance action with
 * an id resolves to `can_<action>` on `<resource>:<id>`.
 */
export function toCheck(
	resourceType: Resource,
	action: Action,
	opts: { id?: string; orgId: string },
): FgaCheck {
	if (isOrgLevel(resourceType, action) || !opts.id) {
		return {
			object: `org:${opts.orgId}`,
			relation: `${resourceType}_${action}`,
		};
	}
	return { object: `${resourceType}:${opts.id}`, relation: `can_${action}` };
}

/**
 * The OpenFGA checks to OR for an authorization question. Org-level/create/no-id ⇒
 * just the org capability. A per-instance action ⇒ the instance's `can_<action>` (a
 * scoped grant on it, or container inheritance) OR the org-wide `<type>_<action>`
 * capability — so org-wide grants authorize per-instance checks without leaf edges.
 */
export function checksFor(
	resourceType: Resource,
	action: Action,
	opts: { id?: string; orgId: string },
): FgaCheck[] {
	const orgCheck: FgaCheck = {
		object: `org:${opts.orgId}`,
		relation: `${resourceType}_${action}`,
	};
	if (isOrgLevel(resourceType, action) || !opts.id) return [orgCheck];
	return [
		{ object: `${resourceType}:${opts.id}`, relation: `can_${action}` },
		orgCheck,
	];
}
