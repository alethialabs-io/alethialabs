"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getEntitlements } from "@/lib/authz/entitlements";
import type { Entitlements } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { member, organization, session as sessionTable } from "@/lib/db/schema";

export interface WorkspaceOrg {
	id: string;
	name: string;
	role: string;
}

export interface WorkspaceContext {
	/** The org the request is currently scoped to (drives the PDP + RLS). */
	activeOrgId: string;
	/** Orgs the user belongs to; community = a single synthetic "Personal" workspace. */
	organizations: WorkspaceOrg[];
	entitlements: Entitlements;
}

/**
 * The dashboard's workspace context for the current session: the active org, the
 * orgs the user can switch to, and the feature entitlements (the client uses these
 * to gate the org switcher + admin surfaces). Community has no org plugin, so the
 * `member` table is empty and we synthesize the user's "Personal" workspace.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
	const { userId, activeOrgId } = await getOwnerScope();
	const actor = await getActiveScope(userId, activeOrgId);
	const entitlements = getEntitlements(actor);

	const rows = await getServiceDb()
		.select({ id: organization.id, name: organization.name, role: member.role })
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.where(eq(member.userId, userId));

	const organizations: WorkspaceOrg[] =
		rows.length > 0
			? rows
			: [{ id: userId, name: "Personal", role: "owner" }];

	return { activeOrgId: actor.orgId, organizations, entitlements };
}

/**
 * Switches the session's active organization. The personal org (orgId === userId)
 * is always allowed; any real org requires membership. Persists
 * session.active_organization_id, which getActiveScope() reads on the next request.
 * Community is single-org so this is effectively a no-op there.
 */
export async function setActiveOrganization(
	orgId: string,
): Promise<{ ok: boolean }> {
	const { userId, sessionId } = await getOwnerScope();

	if (orgId !== userId) {
		const [m] = await getServiceDb()
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
			.limit(1);
		if (!m) throw new Error("Not a member of that organization");
	}

	await getServiceDb()
		.update(sessionTable)
		.set({ activeOrganizationId: orgId })
		.where(eq(sessionTable.id, sessionId));

	return { ok: true };
}
