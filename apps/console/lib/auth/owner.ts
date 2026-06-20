// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Returns the authenticated user's id — the owner scope passed to
 * withOwnerScope() for the per-owner RLS backstop. Identity comes from Better
 * Auth (Phase D); the contract (a uuid string or throw) is stable so every caller stays the same. Throws on no session.
 */
export async function requireOwner(): Promise<string> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	return session.user.id;
}

/** Like requireOwner() but returns null instead of throwing. */
export async function getOwner(): Promise<string | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	return session?.user?.id ?? null;
}

export interface OwnerScope {
	userId: string;
	sessionId: string;
	/** The org the session has switched to (enterprise org plugin); undefined in community. */
	activeOrgId?: string;
}

/**
 * Like requireOwner() but also surfaces the session id and the selected active
 * organization, so currentActor() can resolve a multi-org scope and
 * setActiveOrganization() can persist the choice. activeOrganizationId is set by the
 * enterprise organization plugin; absent in community → read defensively.
 */
export async function getOwnerScope(): Promise<OwnerScope> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	return {
		userId: session.user.id,
		sessionId: session.session.id,
		activeOrgId: readActiveOrgId(session.session),
	};
}

/** Reads session.activeOrganizationId without assuming the org-plugin types are present. */
function readActiveOrgId(s: object): string | undefined {
	if ("activeOrganizationId" in s && typeof s.activeOrganizationId === "string") {
		return s.activeOrganizationId;
	}
	return undefined;
}
