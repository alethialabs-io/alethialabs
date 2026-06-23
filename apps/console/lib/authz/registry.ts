// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Registry-as-code (spec/mvp/07-auth-rbac-sso.md Part E): the single source of the
// resource × action matrix + the built-in role templates. Adding a capability is a
// one-line edit here; the exhaustive unions make a new action a compile error until
// it's handled, and the DB `permission`/`role` tables are seeded FROM this file
// (4.2) so code and data never drift.

/** Resource types the PDP reasons about. */
export const RESOURCES = [
	"org",
	"zone",
	"spec",
	"runner",
	"cloud_identity",
	"job",
	"connector",
	"member",
	"audit",
	"billing",
	"alert",
	// Managed warm-pool config (spec/mvp/26-fleet-controller.md). Provisions real cloud
	// VMs (cost), so it is an owner/admin-only operator capability — excluded from operators.
	"fleet",
] as const;
export type Resource = (typeof RESOURCES)[number];

/** Actions a principal can take on a resource. */
export const ACTIONS = [
	"view",
	"create",
	"edit",
	"plan",
	"deploy",
	"destroy",
	"manage_identities",
	"manage_members",
	"manage_connectors",
	"view_audit",
	"export_audit",
	"manage_billing",
	// Alerting config (spec/mvp/25-alerting-notifications.md): read the alert
	// channels/rules/deliveries vs mutate them.
	"view_alerts",
	"manage_alerts",
	// Granular cloud-identity operations (distinct per provision_job_type, so each
	// job type is independently grantable/deniable): CONNECTION_TEST, FETCH_RESOURCES.
	"test",
	"fetch_resources",
] as const;
export type Action = (typeof ACTIONS)[number];

/** A permission key is `resource:action` (the PK of the `permission` table). */
export type PermissionKey = `${Resource}:${Action}`;

export interface PermissionDef {
	key: PermissionKey;
	resource: Resource;
	action: Action;
	description: string;
}

/** Which actions are valid on which resource (the matrix). Default-deny: a pair
 *  not listed here is not a permission and can never be granted. */
const MATRIX: Partial<Record<Resource, readonly Action[]>> = {
	org: ["view", "edit", "manage_billing"],
	zone: ["view", "create", "edit", "destroy"],
	spec: ["view", "create", "edit", "plan", "deploy", "destroy"],
	runner: ["view", "create", "edit", "destroy", "deploy"],
	cloud_identity: ["view", "manage_identities", "test", "fetch_resources"],
	job: ["view", "create", "edit"],
	connector: ["view", "manage_connectors"],
	member: ["view", "manage_members"],
	audit: ["view_audit", "export_audit"],
	billing: ["manage_billing"],
	alert: ["view_alerts", "manage_alerts"],
	fleet: ["view", "create", "edit", "destroy"],
};

/** The full permission registry, derived from the matrix. */
export const PERMISSIONS: PermissionDef[] = RESOURCES.flatMap((resource) =>
	(MATRIX[resource] ?? []).map((action) => ({
		// `${Resource}:${Action}` is a valid PermissionKey by construction; TS widens
		// template literals with union holes to `string`, so narrow it here once.
		key: `${resource}:${action}` as PermissionKey,
		resource,
		action,
		description: `${action} a ${resource}`,
	})),
);

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

/** Built-in role templates (org_id NULL, is_builtin=true). Custom roles (ee/) are
 *  org-scoped copies with deltas. `"*"` = every permission. */
export type BuiltInRole = "owner" | "admin" | "operator" | "viewer";

/** Stable UUIDs for the built-in roles so the seed is idempotent by primary key. */
export const BUILTIN_ROLE_IDS: Record<BuiltInRole, string> = {
	owner: "00000000-0000-4000-8000-000000000001",
	admin: "00000000-0000-4000-8000-000000000002",
	operator: "00000000-0000-4000-8000-000000000003",
	viewer: "00000000-0000-4000-8000-000000000004",
};

export const BUILT_IN_ROLES: Record<BuiltInRole, PermissionKey[] | "*"> = {
	// Full control, including billing + member management.
	owner: "*",
	// Everything except billing.
	admin: ALL_KEYS.filter((k) => !k.startsWith("billing:")),
	// Operate infrastructure (plan/deploy/destroy + view); not identities/members/billing.
	// Also read alert config (operators care about ops alerts) but not mutate it.
	operator: PERMISSIONS.filter(
		(p) =>
			((["view", "create", "edit", "plan", "deploy", "destroy"] as Action[]).includes(
				p.action,
			) &&
				!["cloud_identity", "member", "billing", "audit", "fleet"].includes(p.resource)) ||
			p.action === "view_alerts",
	).map((p) => p.key),
	// Read-only (including alert config).
	viewer: PERMISSIONS.filter(
		(p) => p.action === "view" || p.action === "view_alerts",
	).map((p) => p.key),
};

/** True if `key` is a real permission (guards against typos / stale grants). */
export function isPermissionKey(key: string): key is PermissionKey {
	return ALL_KEYS.includes(key as PermissionKey);
}
