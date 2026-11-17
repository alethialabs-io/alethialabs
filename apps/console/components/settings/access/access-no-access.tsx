// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the access manager renders it from the route's answer or a live refusal.

import { RegionRefusal } from "@/components/errors/region-refusal";

/**
 * The Access page for a viewer without `member:view` — its own render, distinct from an empty list
 * and from a failed read (RUBRIC B4). Who may read the org's grants is decided by its owners and
 * admins. The console's one refused render.
 */
export function AccessNoAccess() {
	return <RegionRefusal refusal="forbidden" subject="access grants" />;
}
