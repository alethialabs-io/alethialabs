// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The refusals the auth route applies to better-auth's organization and SSO endpoints BEFORE
// better-auth runs them (#5472, #5484), because better-auth itself does not read `member.status`:
//
// 1. A caller whose member row in the target org is not `active` may not manage it. better-auth
//    authorizes invite / update-role / remove (and the team, role and org actions) from
//    `member.role` alone, so a suspended admin could invite a second account they control, and
//    `afterAcceptInvitation` gave that account an ACTIVE admin grant.
// 2. `/organization/leave` is refused when the leaving member is the org's last ACTIVE owner.
//    better-auth counts suspended owners as owners, and leave fires no organization hook, so this
//    route is the only place the rule can run for it.
// 3. A caller whose member row in the org is not `active` may not change the org's SSO providers
//    (#5484). @better-auth/sso authorizes those from `member.role` alone too.

import { and, eq } from "drizzle-orm";
import { removalOwnerRefusal } from "@/lib/authz/active-owner";
import { getServiceDb } from "@/lib/db";
import { invitation, member, ssoProvider } from "@/lib/db/schema";

/**
 * Organization-plugin actions a caller manages the org through, and so may run only while their
 * member row there is `active`. Read and exit actions (list*, get*, set-active, accept/reject an
 * invitation, leave) and org create are not here: they act on the caller's own membership or on no
 * existing org.
 */
const STATUS_GATED_ORG_ACTIONS: ReadonlySet<string> = new Set([
	"invite-member",
	"add-member",
	"remove-member",
	"update-member-role",
	"cancel-invitation",
	"create-team",
	"update-team",
	"remove-team",
	"add-team-member",
	"remove-team-member",
	"update",
	"delete",
	"create-role",
	"update-role",
	"delete-role",
]);

/**
 * @better-auth/sso endpoints that change an org's identity providers. The plugin authorizes them
 * from `member.role` alone (`hasOrgAdminRole`), so a suspended admin could still register, edit or
 * delete the org's providers (#5484). Reads (`/sso/providers`, `/sso/get-provider`) and the sign-in
 * flow are not here.
 */
const STATUS_GATED_SSO_ACTIONS: ReadonlySet<string> = new Set([
	"register",
	"update-provider",
	"delete-provider",
	"request-domain-verification",
	"verify-domain",
]);

/** Whether `orgActionRefusal` may refuse `action`, and so needs the signed-in caller to decide. */
export function isGuardedOrgAction(action: string): boolean {
	return action === "leave" || STATUS_GATED_ORG_ACTIONS.has(action);
}

/** The `<action>` in /api/auth/organization/<action>, or null if not an org route. */
export function orgAction(pathname: string): string | null {
	const marker = "/organization/";
	const i = pathname.indexOf(marker);
	if (i === -1) return null;
	return pathname.slice(i + marker.length).split(/[/?]/)[0] ?? null;
}

/**
 * The `<action>` in /api/auth/sso/<action> when it is one `ssoActionRefusal` may refuse, else null.
 * Read the way `orgAction` reads an organization route: the first segment after the marker.
 */
export function guardedSsoAction(pathname: string): string | null {
	const marker = "/api/auth/sso/";
	const i = pathname.indexOf(marker);
	if (i === -1) return null;
	const action = pathname.slice(i + marker.length).split(/[/?]/)[0] ?? "";
	return STATUS_GATED_SSO_ACTIONS.has(action) ? action : null;
}

/** A non-empty string field of an unknown object (a parsed request body), else null. */
export function stringField(value: unknown, key: string): string | null {
	if (typeof value !== "object" || value === null || !(key in value)) return null;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "string" && field !== "" ? field : null;
}

/**
 * The org a status-gated action targets, resolved the way better-auth 1.7 resolves it: the
 * invitation's org for `cancel-invitation`; for `update-team`, `data.organizationId` and nothing
 * else from the body (better-auth reads `ctx.body.data.organizationId || activeOrganizationId` and
 * never a top-level `organizationId`, so honouring one here would let a body name an org the guard
 * checks while better-auth acts in another); otherwise `organizationId` from the body. Each falls
 * back to the session's active org.
 */
async function targetOrgId(
	action: string,
	body: unknown,
	activeOrgId: string | undefined,
): Promise<string | null> {
	if (action === "cancel-invitation") {
		const invitationId = stringField(body, "invitationId");
		if (!invitationId) return null;
		const [row] = await getServiceDb()
			.select({ organizationId: invitation.organizationId })
			.from(invitation)
			.where(eq(invitation.id, invitationId))
			.limit(1);
		return row?.organizationId ?? null;
	}
	if (action === "update-team") {
		const data: unknown =
			typeof body === "object" && body !== null && "data" in body
				? Reflect.get(body, "data")
				: null;
		return stringField(data, "organizationId") ?? activeOrgId ?? null;
	}
	return stringField(body, "organizationId") ?? activeOrgId ?? null;
}

/** The caller's member row in an org, or undefined when they have none. */
async function callerMember(
	orgId: string,
	userId: string,
): Promise<{ id: string; status: string } | undefined> {
	const [row] = await getServiceDb()
		.select({ id: member.id, status: member.status })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1);
	return row;
}

/** The 403 a caller whose member row in the target org is not `active` gets. */
function memberNotActive(): Response {
	return Response.json(
		{
			code: "MEMBER_NOT_ACTIVE",
			message: "Your membership in this team is not active, so you can't manage it.",
		},
		{ status: 403 },
	);
}

/**
 * The org an SSO action acts in, resolved the way @better-auth/sso 1.7 resolves it: `register`
 * checks org admin only for a body `organizationId` (without one the provider belongs to the user,
 * not to an org); the provider actions read the org off the stored provider named by `providerId`.
 */
async function ssoTargetOrgId(action: string, body: unknown): Promise<string | null> {
	if (action === "register") return stringField(body, "organizationId");
	const providerId = stringField(body, "providerId");
	if (!providerId) return null;
	const [row] = await getServiceDb()
		.select({ organizationId: ssoProvider.organizationId })
		.from(ssoProvider)
		.where(eq(ssoProvider.providerId, providerId))
		.limit(1);
	return row?.organizationId ?? null;
}

/**
 * The response that refuses SSO action `action` (one `guardedSsoAction` returned) for signed-in
 * user `userId`, or null to let @better-auth/sso handle it: refused when the user's member row in
 * the org the action targets is not `active` (#5484). A caller with no member row there, and a
 * provider with no org, are left to the plugin: it refuses a caller who is not an admin of the
 * provider's org, and for a provider with no org anyone but the user who registered it.
 */
export async function ssoActionRefusal(
	action: string,
	body: unknown,
	userId: string,
): Promise<Response | null> {
	if (!STATUS_GATED_SSO_ACTIONS.has(action)) return null;
	const orgId = await ssoTargetOrgId(action, body);
	if (!orgId) return null;
	const row = await callerMember(orgId, userId);
	return row && row.status !== "active" ? memberNotActive() : null;
}

/**
 * The response that refuses organization action `action` for signed-in user `userId`, or null to
 * let better-auth handle it. `body` is the request's parsed JSON body (null when it has none) and
 * `activeOrgId` the session's active org.
 *
 * A caller with NO member row in the target org is not refused here; better-auth refuses them.
 */
export async function orgActionRefusal(
	action: string,
	body: unknown,
	userId: string,
	activeOrgId: string | undefined,
): Promise<Response | null> {
	if (action === "leave") {
		const orgId = stringField(body, "organizationId");
		if (!orgId) return null;
		const row = await callerMember(orgId, userId);
		const refusal = row ? await removalOwnerRefusal(orgId, row.id) : null;
		return refusal
			? Response.json(
					{ code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER", message: refusal },
					{ status: 400 },
				)
			: null;
	}
	if (!STATUS_GATED_ORG_ACTIONS.has(action)) return null;
	const orgId = await targetOrgId(action, body, activeOrgId);
	if (!orgId) return null;
	const row = await callerMember(orgId, userId);
	if (!row || row.status === "active") return null;
	return memberNotActive();
}
