// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth catch-all handler — owns OAuth callbacks, email-OTP verify,
// session, account linking, sign-out, AND (enterprise build) the organization
// plugin's HTTP surface (/api/auth/organization/*). Provider tokens persist to the
// `account` table.
//
// Server-side entitlement gate (project 14 / billing foundation F1). Pricing model:
// creating a workspace (org) is FREE — a single-member community org — but TEAMS and
// MEMBERS are the paid feature ("free org, pay to unlock teams"). The org plugin's UI
// hides team/member actions for unentitled users, but the HTTP endpoints underneath
// accept any authenticated request, so we wrap POST: team/member-mutation calls return
// 403 unless the actor's scope has the `organizations` entitlement. Org create/update
// is intentionally NOT gated. The check consumes the existing entitlement seam
// (getEntitlements → ee/ per-org resolution from the billing record), so an
// unsubscribed org gets the community baseline and the gate bites. Read/accept/leave
// flows stay open so a user invited into someone else's PAID org can still participate.

import { auth } from "@/lib/auth";
import { getOwnerScope } from "@/lib/auth/owner";
import { trustedIpFailure } from "@/lib/auth/trusted-ip";
import { getEntitlements } from "@/lib/authz/entitlements";
import { revokeMemberGrant } from "@/lib/authz/grants";
import { currentActor } from "@/lib/authz/guard";
import { runOrgCreate } from "@/lib/billing/pending-org-setup";
import { toNextJsHandler } from "better-auth/next-js";
import { orgAction, orgActionRefusal, stringField } from "./member-guards";

const handlers = toNextJsHandler(auth);

/** Serves Better Auth GET routes after verifying the trusted client-IP contract. */
export function GET(request: Request): Promise<Response> | Response {
	return trustedIpFailure(request) ?? handlers.GET(request);
}

/**
 * Organization-plugin actions that *consume* the paid TEAMS feature (manage teams,
 * add/manage members). Gated on the `organizations` entitlement. Deliberately
 * EXCLUDES org create/update (a free workspace) and invitee/read/exit actions
 * (accept-invitation, set-active, list*, leave, …) — those are how a user creates a
 * free workspace or joins/uses an org someone else pays for.
 */
const GATED_ORG_ACTIONS = new Set([
	"create-team",
	"update-team",
	"remove-team",
	"invite-member",
	"add-member",
	"remove-member",
	"update-member-role",
]);

/** The entitlement-gated `<action>` in /api/auth/organization/<action>, or null. */
function gatedOrgAction(pathname: string): string | null {
	const action = orgAction(pathname);
	return action !== null && GATED_ORG_ACTIONS.has(action) ? action : null;
}

/** The signed-in caller's user id and active org, or null when there is no session. */
async function sessionCaller(): Promise<{ userId: string; activeOrgId?: string } | null> {
	try {
		return await getOwnerScope();
	} catch {
		return null;
	}
}

/** 403 with an upgrade hint — the response an unentitled caller gets. */
function upgradeRequired(action: string): Response {
	return Response.json(
		{
			error: "upgrade_required",
			message:
				"Organizations and teams are a paid feature. Upgrade your plan to create or manage a team.",
			action,
		},
		{ status: 403 },
	);
}

export async function POST(req: Request): Promise<Response> {
	const ingressFailure = trustedIpFailure(req);
	if (ingressFailure) return ingressFailure;

	const action = gatedOrgAction(new URL(req.url).pathname);
	if (action) {
		// Resolve the caller's scope; if there's no session, fall through and let
		// Better Auth return its own 401 (don't mask auth errors as 403).
		try {
			const actor = await currentActor();
			if (!getEntitlements(actor).organizations) {
				return upgradeRequired(action);
			}
		} catch {
			// Unauthenticated (or scope unresolvable) → defer to the auth handler.
		}
	}
	// A caller who is not an active member may not manage the org, and the last active owner may
	// not leave it (#5472). better-auth reads neither `member.status` nor counts only active owners.
	// Without a session there is nothing to check; better-auth answers its own 401.
	const anyOrgAction = orgAction(new URL(req.url).pathname);
	const caller = anyOrgAction ? await sessionCaller() : null;
	if (anyOrgAction && caller) {
		const body: unknown = await req
			.clone()
			.json()
			.catch(() => null);
		const refusal = await orgActionRefusal(
			anyOrgAction,
			body,
			caller.userId,
			caller.activeOrgId,
		);
		if (refusal) return refusal;
		// better-auth's leave deletes the member row and fires no organization hook, so nothing
		// revoked the grants `afterRemoveMember` revokes on a removal. A member who left kept every
		// grant they held, and got their old scoped grants back if they were ever added again.
		if (anyOrgAction === "leave") {
			const response = await handlers.POST(req);
			const orgId = stringField(body, "organizationId");
			if (response.ok && orgId) {
				await revokeMemberGrant(orgId, caller.userId);
			}
			return response;
		}
	}
	// An organization create that fails gives back the paid-setup claim it took (#5445), so a retry is
	// not refused as "already being set up" by a request that is no longer running.
	if (new URL(req.url).pathname.endsWith("/organization/create")) {
		return runOrgCreate(() => handlers.POST(req));
	}
	return handlers.POST(req);
}
