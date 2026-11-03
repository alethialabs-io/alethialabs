// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Roles page's static parts — its copy, its frames, and the permission groups — in ONE plain
// module (no "use client"), because two renders draw them: the page (`roles-manager.tsx`,
// `permission-matrix.tsx`, both client modules) and its loading state (`roles-skeleton.tsx`, which
// the route's server `loading.tsx` renders). A server component that imports a constant from a
// "use client" file gets a client reference, not the value, so the shared parts live HERE.
//
// #6353 (RUBRIC B2): the skeleton used to redraw the page by hand, and the two drifted. Its detail
// panel was a 339px box of six bars where the page opens the Owner role — every permission granted,
// so every group of the matrix open — a panel far taller than the viewport. The grid stretched the
// rail to match, so the gate measured a 339px rail become 701px; and a 32px search bar stood where
// the real one is 36px, so everything under it landed 4px lower. Drawing both from here makes the
// frames, the copy and the open groups the same thing in both.

import {
	BUILT_IN_ROLE_DESCRIPTIONS,
	BUILT_IN_ROLE_LABELS,
	BUILT_IN_ROLE_NAMES,
	BUILT_IN_ROLES,
	PERMISSIONS,
	RESOURCES,
	type PermissionDef,
	type Resource,
} from "@/lib/authz/registry";

/** The page toolbar's one line of supporting copy. */
export const ROLES_DESCRIPTION = "Built-in roles plus the custom roles this organization defines.";

/** The master/detail grid: the rail and the detail panel, side by side from `lg`. */
export const ROLES_GRID_CLASS = "grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]";

/** The rail's frame. */
export const RAIL_CLASS = "rounded-lg border border-border bg-surface p-2 shadow-sm";

/** A rail bucket's heading ("Built-in", "Custom"). */
export const RAIL_HEADING_CLASS =
	"px-2.5 py-2 font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary";

/** A rail row's box. The active/hover background is the row's own. */
export const RAIL_ROW_CLASS =
	"flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left";

/** A rail row's role name. Its colour and weight are the row's own. */
export const RAIL_ROW_NAME_CLASS = "truncate text-ui-md";

/** A rail row's permission count. */
export const RAIL_ROW_COUNT_CLASS = "shrink-0 font-mono text-ui-2xs text-text-tertiary";

/** The rule between the rail's two buckets. */
export const RAIL_DIVIDER_CLASS = "my-2 h-px bg-border";

/** The one-line note a rail bucket shows when it has no rows. */
export const RAIL_NOTE_CLASS = "px-2.5 py-2 text-ui-xs text-text-tertiary";

/** The detail panel's frame. */
export const DETAIL_CLASS = "rounded-lg border border-border bg-surface shadow-sm";

/** The detail panel's header: the role's name, its kind pill, its description, its actions. */
export const DETAIL_HEADER_CLASS =
	"flex items-start justify-between gap-3 border-b border-border px-5 py-4";

/** The header's first line: the shield, the name and the kind pill. */
export const DETAIL_TITLE_ROW_CLASS = "flex items-center gap-2";

/** The size of the shield icon that opens the header's first line. */
export const DETAIL_ICON_SIZE = 15;

/** The role's name in the header. */
export const DETAIL_NAME_CLASS = "text-ui-lg font-semibold text-text-primary";

/** The "Built-in"/"Custom" pill beside the name. */
export const DETAIL_KIND_PILL_CLASS =
	"rounded-full border border-border-strong px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary";

/** The role's description under its name. */
export const DETAIL_DESCRIPTION_CLASS = "mt-1.5 text-ui-sm text-text-secondary";

/** The detail panel's permissions section. */
export const DETAIL_BODY_CLASS = "px-5 py-4";

/** The "Permissions (N)" line over the matrix. */
export const PERMISSIONS_LABEL_CLASS = "mb-3 text-ui-md font-medium text-text-primary";

/** The "(N)" in that line. */
export const PERMISSIONS_COUNT_CLASS = "font-mono text-ui-xs font-normal text-text-tertiary";

/** The detail panel's classification section, under the matrix. */
export const DETAIL_FOOTER_CLASS = "border-t border-border px-5 py-4";

/** The matrix: one bordered section per resource, stacked. */
export const MATRIX_CLASS = "space-y-2.5";

/** One resource group's frame. */
export const GROUP_CLASS = "overflow-hidden rounded-lg border border-border";

/** A group's header row (the collapsible trigger): label, granted/total pill, chevron. */
export const GROUP_TRIGGER_CLASS =
	"flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left";

/** The label and the pill, side by side in the header row. */
export const GROUP_LABEL_ROW_CLASS = "flex items-center gap-2";

/** A group's label. */
export const GROUP_LABEL_CLASS = "text-ui-md font-medium text-text-primary";

/** The "granted/total" pill's box. Its colours depend on whether anything is granted. */
export const GROUP_COUNT_CLASS = "rounded-full border px-1.5 py-0.5 font-mono text-ui-2xs";

/** The size of the chevron that ends a group's header row. */
export const GROUP_CHEVRON_SIZE = 15;

/** An open group's rows, under its header. */
export const GROUP_ROWS_CLASS = "border-t border-border";

/** One permission row: the action and its key on the left, the switch on the right. */
export const PERMISSION_ROW_CLASS =
	"flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0";

/** A permission row's action, the first of its two lines. */
export const PERMISSION_ACTION_CLASS = "text-ui-md capitalize text-text-primary";

/** A permission row's key, the second of its two lines. */
export const PERMISSION_KEY_CLASS = "truncate font-mono text-ui-2xs text-text-tertiary";

// "Per service" grouping — each resource type is its own section, so granting is
// granular (e.g. projects' plan/deploy/destroy independently of runners).
const RESOURCE_LABEL: Record<Resource, string> = {
	org: "Organization",
	project: "Projects",
	runner: "Runners",
	cloud_identity: "Cloud identities",
	job: "Jobs",
	connector: "Connectors",
	member: "Members",
	activity: "Activity",
	billing: "Billing",
	alert: "Alerts",
	fleet: "Fleet",
	support_case: "Support",
	cluster: "Cluster access",
};

/** One section of the matrix: a resource and the permissions on it. */
export interface PermissionGroup {
	resource: Resource;
	label: string;
	permissions: PermissionDef[];
}

/** The matrix's sections, in registry order; a resource with no permissions has none. */
export const PERMISSION_GROUPS: PermissionGroup[] = RESOURCES.map((resource) => ({
	resource,
	label: RESOURCE_LABEL[resource],
	permissions: PERMISSIONS.filter((p) => p.resource === resource),
})).filter((g) => g.permissions.length > 0);

/** How many of a group's permissions are in `selected`. A group with any opens on mount. */
export function grantedInGroup(group: PermissionGroup, selected: ReadonlySet<string>): number {
	return group.permissions.filter((p) => selected.has(p.key)).length;
}

/** A permission's action as its row shows it: `manage_members` → `manage members`. */
export function permissionActionLabel(action: string): string {
	return action.replace(/_/g, " ");
}

/** A role as the page's first paint shows it, without the data that has not arrived. */
export interface FirstRole {
	label: string;
	description: string;
	permissionKeys: string[];
}

/**
 * The role the detail panel shows on arrival: the first built-in, which the catalog lists first
 * and `RolesManager` selects when nothing else is. It is a registry template, so its name, its
 * description and its grants are known before any read answers — which is what lets the skeleton
 * draw the same open groups the page will.
 */
export function firstBuiltInRole(): FirstRole {
	const name = BUILT_IN_ROLE_NAMES[0];
	const grant = BUILT_IN_ROLES[name];
	return {
		label: BUILT_IN_ROLE_LABELS[name],
		description: BUILT_IN_ROLE_DESCRIPTIONS[name],
		permissionKeys: grant === "*" ? PERMISSIONS.map((p) => p.key) : [...grant],
	};
}

/** The built-in roles' names, in the order the rail lists them. */
export function builtInRoleLabels(): string[] {
	return BUILT_IN_ROLE_NAMES.map((name) => BUILT_IN_ROLE_LABELS[name]);
}
