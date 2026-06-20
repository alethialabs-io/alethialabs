// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth catch-all handler — owns OAuth callbacks, email-OTP verify,
// session, account linking, sign-out, AND (enterprise build) the organization
// plugin's HTTP surface (/api/auth/organization/*). Provider tokens persist to the
// `account` table.
//
// Server-side entitlement gate (spec 14 / billing foundation F1): the organization
// plugin's UI hides "create team" for unentitled users, but the HTTP endpoints
// underneath accept any authenticated request. This is the single choke point, so we
// wrap POST: any org-creation / membership-mutation call is rejected with 403 unless
// the actor's scope is entitled to `organizations`. The check consumes the existing
// entitlement seam (getEntitlements → ee/ per-org resolution), so it enforces "an
// unsubscribed user cannot create a team" the moment the seam resolves per-org —
// today it follows the ee/ license flag, after F2 it follows the org's subscription.
// Read/accept/leave flows stay open so a user invited into someone else's PAID org
// can still participate.

import { auth } from "@/lib/auth";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);

export const { GET } = handlers;

/**
 * Organization-plugin actions that *consume* the paid orgs/teams feature (create an
 * org, manage teams, manage members). Gated on the `organizations` entitlement.
 * Deliberately excludes invitee/read/exit actions (accept-invitation, set-active,
 * list*, leave, …) — those are how a user joins/uses an org someone else pays for.
 */
const GATED_ORG_ACTIONS = new Set([
	"create",
	"update",
	"create-team",
	"update-team",
	"remove-team",
	"invite-member",
	"add-member",
	"remove-member",
	"update-member-role",
]);

/** The `<action>` in /api/auth/organization/<action>, or null if not an org route. */
function gatedOrgAction(pathname: string): string | null {
	const marker = "/organization/";
	const i = pathname.indexOf(marker);
	if (i === -1) return null;
	const action = pathname.slice(i + marker.length).split(/[/?]/)[0];
	return GATED_ORG_ACTIONS.has(action) ? action : null;
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
	return handlers.POST(req);
}
