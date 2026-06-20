// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Action, PermissionKey, Resource } from "./registry";

// Pure decision helpers for the PDP. Kept free of DB/IO so the authorization logic
// is unit-testable without a database (PostgresRbacPDP gathers rows via SQL, then
// decides here). The SQL gathering is integration-tested at DB standup.

/** The permission key for a (resource, action) pair. */
export function permissionKey(resource: Resource, action: Action): PermissionKey {
	return `${resource}:${action}`;
}

/**
 * Given the `resource_id`s of the actor's grants that already match the org,
 * principal, and required permission, decide whether they cover the target
 * resource. A `null` grant resource_id is org-wide (covers everything); otherwise
 * the grant must name the resource itself or one of its ancestors (a higher-scope
 * grant flows down the Org→Zone→Spec hierarchy). Empty ⇒ default-deny.
 */
export function coversResource(
	grantResourceIds: ReadonlyArray<string | null>,
	resourceId: string | undefined,
	ancestorIds: ReadonlyArray<string>,
): boolean {
	if (grantResourceIds.length === 0) return false;
	if (grantResourceIds.some((id) => id === null)) return true; // org-wide
	if (!resourceId) return false; // scoped grant but no concrete target
	const covering = new Set<string>([resourceId, ...ancestorIds]);
	return grantResourceIds.some((id) => id !== null && covering.has(id));
}

/**
 * The final allow/deny decision for a permission on a resource. Allow grants and
 * explicit-deny grants are evaluated with the SAME coverage rule (a grant covers the
 * resource itself or any ancestor — so a deny scoped to a zone OR to one spec both
 * exclude correctly). Explicit deny ALWAYS wins (no specificity ranking, IAM-style):
 * allowed ⇔ an allow covers AND no deny covers.
 */
export function decide(
	allowResourceIds: ReadonlyArray<string | null>,
	denyResourceIds: ReadonlyArray<string | null>,
	resourceId: string | undefined,
	ancestorIds: ReadonlyArray<string>,
): boolean {
	if (coversResource(denyResourceIds, resourceId, ancestorIds)) return false;
	return coversResource(allowResourceIds, resourceId, ancestorIds);
}
