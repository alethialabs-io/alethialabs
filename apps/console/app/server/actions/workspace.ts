"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { NotOrgMemberError } from "@/lib/auth/errors";
import { getOwnerScope } from "@/lib/auth/owner";
import { getServiceDb } from "@/lib/db";
import { member, session as sessionTable } from "@/lib/db/schema";

// The workspace READ (`getWorkspaceContext`) moved to the read router as `workspace.context`
// (`lib/rpc/procedures/workspace.ts`, ADR 0005 D1, #6114). What stays here is the one write.

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
		if (!m) throw new NotOrgMemberError();
	}

	await getServiceDb()
		.update(sessionTable)
		.set({ activeOrganizationId: orgId })
		.where(eq(sessionTable.id, sessionId));

	return { ok: true };
}
