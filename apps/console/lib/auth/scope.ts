// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEnterprise } from "@/lib/enterprise";
import type { Actor } from "@/lib/authz/types";

/**
 * Resolves a verified user's active tenancy scope — the seam between identity and
 * authorization (spec 07 Part F, seam 2). Community is single-tenant: the user's
 * personal org is their own id, so `orgId === userId` (the optional `activeOrgId` is
 * ignored — there is only the personal org). The `ee/` Teams build registers a
 * resolver that maps the user to their selected organization (validating membership)
 * — without touching any call site.
 */
export async function getActiveScope(
	userId: string,
	activeOrgId?: string,
): Promise<Actor> {
	const resolve = getEnterprise()?.resolveScope;
	if (resolve) return resolve(userId, activeOrgId);
	return { userId, orgId: userId };
}
