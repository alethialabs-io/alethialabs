// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the roles route renders it on the server when the catalog read is refused, and
// the manager renders it when a live refetch is.

import { ShieldOff } from "lucide-react";
import { EmptyState } from "@repo/ui/empty";

/**
 * The Roles page for a viewer without `member:view` — its own render, distinct from an empty rail
 * and from a failed read (RUBRIC B4). Roles are member-management configuration; who may see them
 * is decided by the org's owners and admins.
 */
export function RolesNoAccess() {
	return (
		<EmptyState
			className="border border-border bg-surface-sunken"
			icon={<ShieldOff />}
			title="No access to roles"
			description="You don't have permission to view roles for this organization. Ask an owner or admin for access."
		/>
	);
}
