// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Registry-as-code (dataroom/spec/mvp/07-auth-rbac-sso.md Part E): the single source of the
// resource × action matrix + the built-in role templates. Adding a capability is a
// one-line edit here; the exhaustive unions make a new action a compile error until
// it's handled, and the DB `permission`/`role` tables are seeded FROM this file
// (4.2) so code and data never drift.

import { isEnumMember } from "@/lib/coerce";

/** Resource types the PDP reasons about. */
export const RESOURCES = [
	"org",
	"project",
	"runner",
	"cloud_identity",
	"job",
	"connector",
	"member",
	"activity",
	"billing",
	"alert",
	// Managed warm-pool config (dataroom/spec/mvp/26-fleet-controller.md). Provisions real cloud
	// VMs (cost), so it is an owner/admin-only operator capability — excluded from operators.
	"fleet",
	// Support cases (help-desk). Any org member may open/track/reply to their own cases;
	// `manage` is the staff-triage capability (owner/admin only — staff answer out-of-band).
	"support_case",
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
	"view_activity",
	"export_activity",
	"manage_billing",
	// Alerting config (dataroom/spec/mvp/25-alerting-notifications.md): read the alert
	// channels/rules/deliveries vs mutate them.
	"view_alerts",
	"manage_alerts",
	// Cloud-identity connection verify (server-side; re-run via the "Re-verify" affordance).
	"test",
	// Support cases: post a reply to a case thread vs triage/assign/resolve (staff).
	"reply",
	"manage_support",
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
	project: ["view", "create", "edit", "plan", "deploy", "destroy"],
	runner: ["view", "create", "edit", "destroy", "deploy"],
	cloud_identity: ["view", "manage_identities", "test"],
	job: ["view", "create", "edit"],
	connector: ["view", "manage_connectors"],
	member: ["view", "manage_members"],
	activity: ["view_activity", "export_activity"],
	billing: ["manage_billing"],
	alert: ["view_alerts", "manage_alerts"],
	fleet: ["view", "create", "edit", "destroy"],
	support_case: ["view", "create", "reply", "manage_support"],
};

/** Customer-facing support actions every org member holds on their own cases. */
const SUPPORT_MEMBER_ACTIONS: readonly Action[] = ["view", "create", "reply"];

/** The full permission registry, derived from the matrix. */
export const PERMISSIONS: PermissionDef[] = RESOURCES.flatMap((resource) =>
	(MATRIX[resource] ?? []).map((action) => ({
		// `${Resource}:${Action}` is a valid PermissionKey by construction; TS widens
		// template literals with union holes to `string`, so narrow it here once.
		key: `${resource}:${action}`,
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

/** Human descriptions for the built-in roles — the single source (was duplicated in the
 *  CLI roles route and the roles-manager UI). Seeded onto the built-in `role` rows. */
export const BUILT_IN_ROLE_DESCRIPTIONS: Record<BuiltInRole, string> = {
	owner: "Full control, including billing and member management.",
	admin: "Everything except billing.",
	operator: "Operate infrastructure (plan/deploy/destroy) and read alerts.",
	viewer: "Read-only access.",
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
				!["cloud_identity", "member", "billing", "activity", "fleet"].includes(p.resource)) ||
			p.action === "view_alerts" ||
			(p.resource === "support_case" && SUPPORT_MEMBER_ACTIONS.includes(p.action)),
	).map((p) => p.key),
	// Read-only (including alert config), PLUS opening/replying to their OWN support cases —
	// support is a right, not a privilege, so even a read-only teammate can ask for help.
	// The tiered support RLS keeps a viewer's visibility to cases they opened; `manage_support`
	// (see-all + triage) stays owner/admin-only.
	viewer: PERMISSIONS.filter(
		(p) =>
			p.action === "view" ||
			p.action === "view_alerts" ||
			(p.resource === "support_case" && SUPPORT_MEMBER_ACTIONS.includes(p.action)),
	).map((p) => p.key),
};

/** True if `key` is a real permission (guards against typos / stale grants). */
export function isPermissionKey(key: string): key is PermissionKey {
	return isEnumMember(key, ALL_KEYS);
}
