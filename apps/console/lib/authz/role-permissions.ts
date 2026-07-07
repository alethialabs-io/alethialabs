// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { rolePermission } from "@/lib/db/schema";

/**
 * The permission keys a role grants (`role_permission` → keys). The expansion unit
 * for the FGA tuple writer: a role is a permission bundle, so granting it writes one
 * tuple per key. Injected into ee/ via CoreContext.
 */
export async function rolePermissionKeys(roleId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ key: rolePermission.permission_key })
		.from(rolePermission)
		.where(eq(rolePermission.role_id, roleId));
	return rows.map((r) => r.key);
}
