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
import { findOwnerScope } from "@/lib/auth/owner";
import { trustedIpFailure } from "@/lib/auth/trusted-ip";
import { getEntitlements } from "@/lib/authz/entitlements";
import { revokeMemberGrant } from "@/lib/authz/grants";
import { currentActor } from "@/lib/authz/guard";
import { cancelPendingInvitationsFrom } from "@/lib/authz/member-exit";
import { runOrgCreate } from "@/lib/billing/pending-org-setup";
import { getServiceDb } from "@/lib/db";
import { toNextJsHandler } from "better-auth/next-js";
import { z } from "zod";
import {
	guardedSsoAction,
	isGuardedOrgAction,
	orgAction,
	orgActionRefusal,
	ssoActionRefusal,
	stringField,
} from "./member-guards";

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

/**
 * The 500 an organization action gets when the session could not be READ (as opposed to there being
 * none). The member guards below cannot run without the caller, and skipping them would hand the
 * request to better-auth unchecked, so the request is refused instead (#5472).
 */
function sessionLookupFailed(): Response {
	return Response.json(
		{
			code: "SESSION_LOOKUP_FAILED",
			message: "We couldn't check your session. Try again in a moment.",
		},
		{ status: 500 },
	);
}

/** The part of better-auth's remove-member response that names who was removed, and from where. */
const removedMemberResponse = z.object({
	member: z.object({ userId: z.string().min(1), organizationId: z.string().min(1) }),
});

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
	// A caller who is not an active member of an org may not change its SSO providers (#5484).
	// @better-auth/sso reads `member.role` and not `member.status`. As below, no session is left to
	// the plugin's own 401, and a session that could not be read refuses the request.
	const ssoAction = guardedSsoAction(new URL(req.url).pathname);
	if (ssoAction) {
		let ssoCaller: { userId: string } | null;
		try {
			ssoCaller = await findOwnerScope();
		} catch (error) {
			console.error("[auth] session lookup failed before an SSO action:", error);
			return sessionLookupFailed();
		}
		if (ssoCaller) {
			const body: unknown = await req
				.clone()
				.json()
				.catch(() => null);
			const refusal = await ssoActionRefusal(ssoAction, body, ssoCaller.userId);
			if (refusal) return refusal;
		}
		return handlers.POST(req);
	}
	// A caller who is not an active member may not manage the org, and the last active owner may
	// not leave it (#5472). better-auth reads neither `member.status` nor counts only active owners.
	// Without a session there is nothing to check; better-auth answers its own 401. A session that
	// could not be READ is not "no session": for an action the guards may refuse, the route fails
	// closed on it rather than skipping them. Other organization actions do not read the session here.
	const requested = orgAction(new URL(req.url).pathname);
	const guardedAction = requested !== null && isGuardedOrgAction(requested) ? requested : null;
	let caller: { userId: string; activeOrgId?: string } | null = null;
	if (guardedAction) {
		try {
			caller = await findOwnerScope();
		} catch (error) {
			console.error("[auth] session lookup failed before an organization action:", error);
			return sessionLookupFailed();
		}
	}
	if (guardedAction && caller) {
		const body: unknown = await req
			.clone()
			.json()
			.catch(() => null);
		const refusal = await orgActionRefusal(
			guardedAction,
			body,
			caller.userId,
			caller.activeOrgId,
		);
		if (refusal) return refusal;
		// better-auth's leave deletes the member row and fires no organization hook, so nothing
		// revoked the grants `afterRemoveMember` revokes on a removal. A member who left kept every
		// grant they held, and got their old scoped grants back if they were ever added again.
		// The invitations a member sent go with them when they leave or are removed (#5484), as they
		// do on suspension: left pending, they become acceptable again if the inviter is re-added.
		if (guardedAction === "leave") {
			const response = await handlers.POST(req);
			const orgId = stringField(body, "organizationId");
			if (response.ok && orgId) {
				await revokeMemberGrant(orgId, caller.userId);
				await cancelPendingInvitationsFrom(getServiceDb(), orgId, caller.userId);
			}
			return response;
		}
		// remove-member's response names the member better-auth removed, so the guard does not have
		// to re-resolve `memberIdOrEmail` the way better-auth does.
		if (guardedAction === "remove-member") {
			const response = await handlers.POST(req);
			if (response.ok) {
				const removed = removedMemberResponse.safeParse(
					await response
						.clone()
						.json()
						.catch(() => null),
				);
				if (removed.success) {
					const { organizationId, userId } = removed.data.member;
					await cancelPendingInvitationsFrom(getServiceDb(), organizationId, userId);
				} else {
					console.error(
						"[auth] remove-member succeeded but its response named no member; their pending invitations were not cancelled",
					);
				}
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
