// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEnterprise } from "@/lib/enterprise";
import type { Actor, Entitlements } from "@/lib/authz/types";

/** Community baseline — every enterprise feature off. */
const COMMUNITY: Entitlements = {
	organizations: false,
	sso: false,
	customRoles: false,
	auditExport: false,
};

/**
 * Feature entitlements for a scope (spec 07 Part F, seam 5). The gate lives in
 * `ee/` (it reads a signed license); core has no `if (licensed)` anywhere — it just
 * asks. Community always returns the all-off baseline.
 */
export function getEntitlements(actor: Actor): Entitlements {
	const fn = getEnterprise()?.entitlements;
	return fn ? fn(actor) : COMMUNITY;
}
