// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the route renders it on the server when the viewer lacks `org:manage_tokens`, and
// the page renders it when a live read is refused.

import { EmptyState } from "@repo/ui/empty";
import { ShieldOff } from "lucide-react";

/**
 * The service tokens page for a viewer without `org:manage_tokens` — its own render, distinct from an
 * empty list and from a failed read. Who holds the permission is the org's roles' answer; the page
 * says which permission it is, never asks who may.
 */
export function TokensNoAccess() {
	return (
		<EmptyState
			className="border border-border bg-surface-sunken"
			data-state="forbidden"
			icon={<ShieldOff />}
			level={2}
			title="You can't manage service tokens"
			description="Listing and creating them needs the Manage tokens permission, which your role doesn't include. Ask someone who manages roles if you need it."
		/>
	);
}
