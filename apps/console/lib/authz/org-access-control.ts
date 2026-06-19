// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth organization-plugin access control, defining OUR membership roles
// (owner / admin / operator / viewer) so the org-plugin's role vocabulary matches
// the PDP's — one role model end-to-end. This names the roles + their org-management
// permissions (who can manage members/invitations/the org); the real per-resource
// authorization is the PDP (grants), not this AC. Shared by the browser auth client
// and the ee organization() plugin (injected via CoreContext, so ee/ stays
// type-only on core).

import { createAccessControl } from "better-auth/plugins/access";

export const ORG_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

// Org-management actions the plugin gates (distinct from PDP resource actions).
const statement = {
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
} as const;

export const orgAc = createAccessControl(statement);

// owner = full org control; admin = manage members/invitations; operator + viewer
// hold no org-management rights (their power is PDP resource access via grants).
export const orgRoles = {
	owner: orgAc.newRole({
		organization: ["update", "delete"],
		member: ["create", "update", "delete"],
		invitation: ["create", "cancel"],
	}),
	admin: orgAc.newRole({
		member: ["create", "update", "delete"],
		invitation: ["create", "cancel"],
	}),
	operator: orgAc.newRole({}),
	viewer: orgAc.newRole({}),
};

/** Narrows a free-form string to an OrgRole (no unsafe cast). */
export function toOrgRole(value: string): OrgRole | null {
	switch (value) {
		case "owner":
		case "admin":
		case "operator":
		case "viewer":
			return value;
		default:
			return null;
	}
}
