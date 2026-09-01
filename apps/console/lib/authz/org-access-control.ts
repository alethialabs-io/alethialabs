// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

/**
 * Better Auth's OWN role vocabulary is `owner | admin | member` (its
 * `plugins/organization/schema` `defaultRoles`), and two of those three are ours already. The
 * third is not, and it is not hypothetical: `member` is what the `member.role` column DEFAULTS
 * to, what the ee SSO plugin provisions JIT users with
 * (`organizationProvisioning.defaultRole`), and what an invitation sent with the plugin's own
 * default carries. Alethia's least-privileged role is `viewer`, so that is what it means here.
 *
 * IT COST AN OUTAGE FOR EVERY INVITED MEMBER (#3730). `ensureMemberGrant` narrowed
 * `member.role` with `toOrgRole` above, which answers null for `member` — and the function
 * treats null as "nothing to grant" and returns. So an accepted invitation wrote a `member` row
 * and NO grant, the PDP (which authorizes from grants, never from `member.role`) denied
 * `project:view`, and `/{org}` threw ForbiddenError out of its server component into the `[org]`
 * error boundary: "Couldn't load this page". The SSO plugin's own comment already asserted this
 * mapping existed — "the PDP then maps it to Alethia's viewer-scoped access" — so every
 * SSO-provisioned user was in the same hole.
 */
// A Map, not an object literal, and that is not a style choice: an object literal inherits
// Object.prototype, so `ALIASES["toString"]` answers a FUNCTION rather than undefined — truthy,
// so it would sail past the caller's `if (!resolved)` and index BUILTIN_ROLE_IDS with a
// non-role, writing a grant row with an undefined role_id. A Map has no prototype keys.
const MEMBERSHIP_ROLE_ALIASES: ReadonlyMap<string, OrgRole> = new Map([
	// Better Auth's built-in least-privileged role ⇒ ours.
	["member", "viewer"],
]);

/**
 * Resolves a stored membership role (`member.role`) to the PDP role whose permission bundle it
 * grants — our four, plus Better Auth's built-ins that are not spelled the same.
 *
 * Deliberately NOT a fallback. An unrecognised value returns null and the caller writes no
 * grant, because "anything I don't recognise means viewer" would turn a typo, a renamed role or
 * a deleted custom role into read access over the whole org. Use {@link toOrgRole} instead
 * wherever the question is "is this one of the roles a human may pick" (a role <select>), not
 * "what does this stored role grant".
 */
export function toPdpRole(value: string): OrgRole | null {
	return toOrgRole(value) ?? MEMBERSHIP_ROLE_ALIASES.get(value) ?? null;
}
