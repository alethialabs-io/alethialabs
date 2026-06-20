"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@/components/ui/badge";
import { EnterpriseGate } from "@/components/settings/enterprise-gate";
import { CustomRoles } from "@/components/settings/roles/custom-roles";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsHeader } from "@/components/settings/settings-header";
import {
	BUILT_IN_ROLES,
	type BuiltInRole,
	PERMISSIONS,
} from "@/lib/authz/registry";

// Short, user-facing descriptions of each built-in role (mirrors the docs).
const ROLE_META: Record<BuiltInRole, string> = {
	owner: "Full control of the organization, including members and billing.",
	admin: "Everything except billing — manage members, identities, and all infrastructure.",
	operator: "Operate infrastructure (plan, deploy, destroy); no members, identities, or billing.",
	viewer: "Read-only access to everything.",
};

const ROLE_ORDER: BuiltInRole[] = ["owner", "admin", "operator", "viewer"];

/** Count of permissions a role grants ("*" = the whole registry). */
function permissionCount(role: BuiltInRole): number {
	const grant = BUILT_IN_ROLES[role];
	return grant === "*" ? PERMISSIONS.length : grant.length;
}

export default function RolesPage() {
	return (
		<>
			<SettingsHeader
				title="Roles"
				description="Built-in roles bundle permissions. Assign them to members per organization, zone, or spec."
			/>

			<div className="grid gap-4 sm:grid-cols-2">
				{ROLE_ORDER.map((role) => (
					<SettingsCard key={role}>
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<span className="text-sm font-semibold capitalize text-foreground">
										{role}
									</span>
									<Badge variant="secondary" className="text-[10px]">
										Built-in
									</Badge>
								</div>
								<p className="text-xs text-muted-foreground">{ROLE_META[role]}</p>
							</div>
							<span className="shrink-0 text-xs font-medium text-muted-foreground">
								{permissionCount(role)} perms
							</span>
						</div>
					</SettingsCard>
				))}
			</div>

			<div className="mt-8">
				<SettingsHeader
					title="Custom roles"
					description="Create org-specific roles with a tailored permission set."
				/>
				<EnterpriseGate
					entitlement="customRoles"
					title="Custom roles"
					description="Define your own roles with a tailored permission matrix, scoped to your organization."
				>
					<CustomRoles />
				</EnterpriseGate>
			</div>
		</>
	);
}
