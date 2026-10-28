// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the access manager renders it from the route's answer or a live refusal.

import { ShieldOff } from "lucide-react";
import { EmptyState } from "@repo/ui/empty";

/**
 * The Access page for a viewer without `member:view` — its own render, distinct from an empty list
 * and from a failed read (RUBRIC B4). Who may read the org's grants is decided by its owners and
 * admins.
 */
export function AccessNoAccess() {
	return (
		<EmptyState
			className="border border-border bg-surface-sunken"
			icon={<ShieldOff />}
			title="No access to grants"
			description="You don't have permission to view this organization's access grants. Ask an owner or admin for access."
		/>
	);
}
