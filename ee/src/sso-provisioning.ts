// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Access for a member who arrives through single sign-on (#6892).
//
// `@better-auth/sso` adds a person to their organization on their first sign-in through the
// organization's identity provider. It writes that `member` row with the generic adapter, so the
// organization plugin's lifecycle hooks (index.ts) are not part of that write. This module is the
// SSO path's own step: after a sign-in through an identity provider it gives the member the
// organization-wide grant their stored role maps to, reconciles seats, and records it — the same
// three things an accepted invitation does.
//
// What it grants, and to whom, is deliberately narrow:
//
//   * ONE role. Only a member whose stored role is {@link SSO_PROVISIONED_ROLE} — the role the SSO
//     plugin is configured to provision with, which core maps to the read-only viewer bundle — is
//     granted here. Any other stored role is left exactly as it is.
//   * ONLY through the organization's own provider. The organizations considered are the ones
//     that own a domain-verified SSO provider the user holds a sign-in account for. A membership
//     that came from anywhere else is not touched.
//   * ONLY a member with no access decision on record. A member who already holds any
//     user-principal grant in the organization (organization-wide or scoped, allow or deny) is
//     left alone, so a second sign-in writes nothing. So is a member of an organization that has
//     recorded a grant revocation since they joined: the activity log names the organization, not
//     the subject, so that member's state is a person's decision to make (the #3754 operator
//     command asks one), not a sign-in's.
//   * ONLY an active member. Core's `ensureMemberGrant` refuses anyone else, and this module
//     checks before it asks.
//
// Runtime access to core is through the injected capabilities only (see index.ts).

import { createAuthMiddleware } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";
import type { ScopeQueryRunner } from "./scope";

/**
 * The membership role the SSO plugin provisions a new member with, and the only stored role this
 * module grants. It is better-auth's least-privileged built-in role; core maps it to the viewer
 * bundle. index.ts passes this same constant to the SSO plugin as `defaultRole`, so the role that
 * is written and the role that is granted cannot drift apart.
 */
export const SSO_PROVISIONED_ROLE = "member";

/** The id of the Better Auth plugin {@link ssoProvisioningPlugin} returns. */
export const SSO_PROVISIONING_PLUGIN_ID = "alethia-sso-provisioning";

/**
 * The `@better-auth/sso` endpoints that complete a sign-in through an identity provider, as the
 * route patterns better-auth matches hooks against: the OIDC callback (shared and per-provider)
 * and the SAML assertion consumer. sso-provisioning.test.ts compares this list with the endpoints
 * the installed plugin actually mounts.
 */
export const SSO_SIGN_IN_PATHS: readonly string[] = [
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/saml2/sp/acs/:providerId",
];

/** The reason recorded in the activity log beside a grant this module wrote. */
export const SSO_GRANT_REASON =
  "Single sign-on: granted the viewer role on sign-in through the organization's identity provider.";

/**
 * One Better Auth plugin as the enterprise module hands it to core. Taken from core's own
 * `EnterpriseModule` type rather than from this package's `better-auth`, so a plugin built here is
 * typed as the thing core mounts.
 */
export type EnterpriseAuthPlugin = NonNullable<EnterpriseModule["authPlugins"]>[number];

/** The core capabilities this module uses; `db` only as a tagged-SQL runner. */
export interface SsoProvisioningCore
  extends Pick<
    CoreContext,
    "ensureMemberGrant" | "syncOrgSeats" | "recordActivity" | "emitAlertEvent"
  > {
  db: ScopeQueryRunner;
}

/**
 * What {@link ensureSsoMemberAccess} did for one member:
 *
 *  - `granted` — the organization-wide grant was written, seats reconciled, the grant recorded.
 *  - `already-granted` — the member holds a user-principal grant already; nothing was written.
 *  - `held` — the organization has recorded a grant revocation since the member joined.
 *  - `other-role` — the stored role is not {@link SSO_PROVISIONED_ROLE}.
 *  - `not-active` — the member row is not active.
 *  - `not-a-member` — there is no member row.
 *  - `refused` — core wrote no grant (the member changed while this ran).
 */
export type SsoAccessOutcome =
  | "granted"
  | "already-granted"
  | "held"
  | "other-role"
  | "not-active"
  | "not-a-member"
  | "refused";

/** One member's state in one organization, as the grant decision reads it. */
interface MembershipState {
  role: string;
  status: string;
  userGrants: number;
  revocationsSinceJoin: number;
}

/** A string column of a row, or a thrown error naming the column the query did not return. */
function stringColumn(row: object, column: string): string {
  const value: unknown = Reflect.get(row, column);
  if (typeof value === "string") return value;
  throw new Error(`sso-provisioning: row has no string "${column}"`);
}

/** A numeric column of a row, or a thrown error naming the column the query did not return. */
function numberColumn(row: object, column: string): number {
  const value: unknown = Reflect.get(row, column);
  if (typeof value === "number") return value;
  throw new Error(`sso-provisioning: row has no numeric "${column}"`);
}

/**
 * Reads one member's role, status, user-principal grant count and the organization's grant
 * revocations since they joined. Null when there is no member row. A row of a shape this module
 * does not understand throws, so a broken read is never taken for "no grants".
 */
async function readMembership(
  db: ScopeQueryRunner,
  organizationId: string,
  userId: string,
): Promise<MembershipState | null> {
  const rows = await db.execute(sql`
    select
      m.role,
      m.status,
      (select count(*)::int
         from grants g
        where g.org_id = m.organization_id and g.principal_type = 'user'
          and g.principal_id = m.user_id) as user_grants,
      (select count(*)::int
         from authz_activity_log a
        where a.org_id = m.organization_id and a.action = 'revoke'
          and a.resource_type = 'grant' and a.ts >= m.created_at) as revocations_since_join
    from member m
    where m.organization_id = ${organizationId}::uuid and m.user_id = ${userId}::uuid
    limit 1
  `);
  const row: unknown = rows[0];
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null) {
    throw new Error("sso-provisioning: membership query returned a non-object row");
  }
  return {
    role: stringColumn(row, "role"),
    status: stringColumn(row, "status"),
    userGrants: numberColumn(row, "user_grants"),
    revocationsSinceJoin: numberColumn(row, "revocations_since_join"),
  };
}

/**
 * Gives a member who signed in through their organization's identity provider the
 * organization-wide grant for {@link SSO_PROVISIONED_ROLE}, when — and only when — they are an
 * active member on that role with no access decision on record (see the file header).
 *
 * Idempotent: once the grant exists, every later call answers `already-granted` and writes
 * nothing — no grant, no seat reconciliation, no activity row. A member row that predates this
 * step and never received its grant is granted on the member's next sign-in by the same rule.
 *
 * The grant is written by core's `ensureMemberGrant`, the function the invitation path calls, so
 * the row and its OpenFGA mirror are the ones the rest of the product writes. It is recorded in
 * the activity log and raised as a `system.member.joined` event only after a re-read confirms the
 * grant exists, so the log never names a grant core declined to write.
 *
 * @param core the injected core capabilities
 * @param target the member (`userId`) and organization (`organizationId`); `email` only labels the event
 */
export async function ensureSsoMemberAccess(
  core: SsoProvisioningCore,
  target: { userId: string; organizationId: string; email?: string | null },
): Promise<SsoAccessOutcome> {
  const { userId, organizationId } = target;
  const before = await readMembership(core.db, organizationId, userId);
  if (!before) return "not-a-member";
  if (before.status !== "active") return "not-active";
  if (before.userGrants > 0) return "already-granted";
  if (before.role !== SSO_PROVISIONED_ROLE) {
    console.warn(
      `[sso] member ${userId} in org ${organizationId} holds no grant and has role "${before.role}", ` +
        `which single sign-on does not provision — no grant written on sign-in.`,
    );
    return "other-role";
  }
  if (before.revocationsSinceJoin > 0) {
    console.warn(
      `[sso] member ${userId} in org ${organizationId} holds no grant and the organization has ` +
        `recorded a grant revocation since they joined — no grant written on sign-in. An ` +
        `administrator can assign their access.`,
    );
    return "held";
  }

  await core.ensureMemberGrant(organizationId, userId, SSO_PROVISIONED_ROLE);
  const after = await readMembership(core.db, organizationId, userId);
  if (!after || after.userGrants === 0) return "refused";

  await core.syncOrgSeats(organizationId);
  core.recordActivity(
    { userId, orgId: organizationId },
    "join",
    { type: "member", id: userId },
    { reason: SSO_GRANT_REASON },
  );
  core.emitAlertEvent(organizationId, "system.member.joined", {
    title: `Member joined: ${target.email ?? userId}`,
    severity: "info",
    actor_id: userId,
    resource_type: "member",
    resource_id: userId,
  });
  return "granted";
}

/**
 * The organizations a user reaches through single sign-on: each one that owns a domain-verified
 * SSO provider the user holds a sign-in account for, and in which the user has a member row.
 */
async function ssoOrganizationsOf(db: ScopeQueryRunner, userId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    select distinct m.organization_id::text as organization_id
    from member m
    join sso_provider sp
      on sp.organization_id = m.organization_id and sp.domain_verified
    join account a
      on a.user_id = m.user_id and a.provider_id = sp.provider_id
    where m.user_id = ${userId}::uuid
    order by 1
  `);
  return rows.map((row: unknown) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("sso-provisioning: organization query returned a non-object row");
    }
    return stringColumn(row, "organization_id");
  });
}

/**
 * Runs {@link ensureSsoMemberAccess} for a user who has just signed in through an identity
 * provider, once per organization they reach through single sign-on, and reports what happened
 * in each.
 *
 * @param core the injected core capabilities
 * @param user the signed-in user; `email` only labels the event
 */
export async function provisionSsoSignIn(
  core: SsoProvisioningCore,
  user: { id: string; email?: string | null },
): Promise<{ organizationId: string; outcome: SsoAccessOutcome }[]> {
  const results: { organizationId: string; outcome: SsoAccessOutcome }[] = [];
  for (const organizationId of await ssoOrganizationsOf(core.db, user.id)) {
    const outcome = await ensureSsoMemberAccess(core, {
      userId: user.id,
      organizationId,
      email: user.email,
    });
    results.push({ organizationId, outcome });
  }
  return results;
}

/** Whether a better-auth route pattern is one of {@link SSO_SIGN_IN_PATHS}. */
export function isSsoSignInPath(path: string | undefined): boolean {
  return path !== undefined && SSO_SIGN_IN_PATHS.includes(path);
}

/**
 * The Better Auth plugin that runs {@link provisionSsoSignIn} after a sign-in through an identity
 * provider. It must be listed AFTER `sso()`: better-auth runs plugin after-hooks in plugin order,
 * and the SSO endpoint has by then created the session and the member row this step reads.
 *
 * A request that created no session (a refused or failed sign-in) does nothing. A failure of the
 * step itself is logged and does not fail the sign-in: the member is signed in without the grant,
 * and their next sign-in runs the step again.
 *
 * @param core the injected core capabilities
 */
export function ssoProvisioningPlugin(core: SsoProvisioningCore): EnterpriseAuthPlugin {
  return {
    id: SSO_PROVISIONING_PLUGIN_ID,
    hooks: {
      after: [
        {
          matcher: (context: { path?: string }) => isSsoSignInPath(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.newSession?.user;
            if (!user) return;
            try {
              await provisionSsoSignIn(core, { id: user.id, email: user.email });
            } catch (err) {
              console.error(
                `[sso] could not provision access for user ${user.id} after sign-in — they are ` +
                  `signed in without a grant; the next sign-in retries.`,
                err,
              );
            }
          }),
        },
      ],
    },
  };
}
