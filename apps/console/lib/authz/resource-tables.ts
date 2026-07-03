// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Maps listable resource types to their backing table, and lists all instance ids of
// a type within an org. Used by both PDP engines for `listAccessible`'s org-wide path
// (an org-wide grant ⇒ every resource of that type in the org).

import { eq } from "drizzle-orm";
import type { Resource } from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runners, projects } from "@/lib/db/schema";

const RESOURCE_TABLE = {
	project: projects,
	job: jobs,
	runner: runners,
	cloud_identity: cloudIdentities,
} as const;

/** Every instance id of `resourceType` in the org (empty for non-listable types). */
export async function listOrgResourceIds(
	resourceType: Resource,
	orgId: string,
): Promise<string[]> {
	const table = RESOURCE_TABLE[resourceType as keyof typeof RESOURCE_TABLE];
	if (!table) return [];
	const rows = await getServiceDb()
		.select({ id: table.id })
		.from(table)
		.where(eq(table.org_id, orgId));
	return rows.map((r) => r.id);
}
