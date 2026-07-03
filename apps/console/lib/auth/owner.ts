// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getInjectedActor } from "@/lib/authz/actor-context";

/**
 * Reads the current Better Auth session, tolerating a failed lookup. A stale/expired token that the
 * optimistic middleware let through (or a transient DB hiccup) makes the session-table query throw;
 * we treat that as "no session" so callers can redirect to sign-in instead of 500-ing the page.
 */
async function safeGetSession() {
	try {
		return await auth.api.getSession({ headers: await headers() });
	} catch (error) {
		console.error("[auth] session lookup failed:", error);
		return null;
	}
}

/**
 * Returns the authenticated user's id — the owner scope passed to
 * withOwnerScope() for the per-owner RLS backstop. Identity comes from Better
 * Auth (Phase D); the contract (a uuid string or throw) is stable so every caller stays the same. Throws on no session.
 *
 * An actor bound via runWithActor() (the MCP token path) short-circuits the session
 * read — its userId is the owner.
 */
export async function requireOwner(): Promise<string> {
	const injected = getInjectedActor();
	if (injected) return injected.userId;
	const session = await safeGetSession();
	if (!session?.user) throw new Error("Unauthorized");
	return session.user.id;
}

/** Like requireOwner() but returns null instead of throwing (also on a failed session lookup). */
export async function getOwner(): Promise<string | null> {
	const session = await safeGetSession();
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
	const injected = getInjectedActor();
	if (injected) {
		// MCP token path: no Better Auth session row exists. Synthesize a scope from
		// the already-resolved actor (sessionId is unused on this path).
		return {
			userId: injected.userId,
			sessionId: "",
			activeOrgId:
				injected.orgId === injected.userId ? undefined : injected.orgId,
		};
	}
	const session = await safeGetSession();
	if (!session?.user) throw new Error("Unauthorized");
	return {
		userId: session.user.id,
		sessionId: session.session.id,
		activeOrgId: readActiveOrgId(session.session),
	};
}

/** Reads session.activeOrganizationId without assuming the org-plugin types are present. */
function readActiveOrgId(s: object): string | undefined {
	if (
		"activeOrganizationId" in s &&
		typeof s.activeOrganizationId === "string"
	) {
		return s.activeOrganizationId;
	}
	return undefined;
}
