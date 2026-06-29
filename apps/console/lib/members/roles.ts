// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Inviteable org roles for the member-invite UI. Lives in a plain module (not the
// `"use server"` actions file, which may only export async functions) so both the server
// action (getInviteContext) and the client dialog can share it.

/** A role the invite dialog can offer (value + label + one-line blurb). */
export interface InviteRoleOption {
	value: string;
	label: string;
	description: string;
}

// The roles a teammate can be invited as (owner is the org creator, never invited). These
// map 1:1 to the Better Auth org AC roles in lib/authz/org-access-control.ts; the blurbs
// summarise each role's PDP power (lib/authz/registry.ts) for the invite picker.
export const INVITE_ROLES: InviteRoleOption[] = [
	{
		value: "admin",
		label: "Admin",
		description: "Manage members, invitations and all resources.",
	},
	{
		value: "operator",
		label: "Operator",
		description: "Create, deploy and destroy resources.",
	},
	{
		value: "viewer",
		label: "Viewer",
		description: "Read-only access across the organization.",
	},
];
