// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register(core)` runs once at app boot
// (via the core's allowlisted lib/enterprise.ts loader); it receives core
// capabilities and returns the implementations the seams consult. Only TYPE imports
// from core (`@/...`) are used (erased at compile time) — runtime data access goes
// through `core.db`, so this package never imports core runtime internals.

import type {
  EnterpriseEditionReport,
  EnterpriseEntrypoint,
  LicenseState,
} from "@alethia/enterprise-api";
import { sso } from "@better-auth/sso";
import { OpenFgaClient } from "@openfga/sdk";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import type { EnterpriseAgentPolicy } from "@/lib/approvals/enterprise-policy";
import type { Entitlements, ResolvedScope } from "@/lib/authz/types";
import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";
import { agentPolicy, type EntitlementResolver } from "./agent-policy";
import { FgaTupleSync } from "./fga-tuple-sync";
import {
  graceEndsAt,
  type InstanceLicense,
  licenseGrants,
  licenseState,
  resolveInstanceLicense,
} from "./license";
import { OpenFgaPdp } from "./openfga-pdp";
import { newOrgSetupHooks } from "./new-org-setup-hooks";
import { orgSlugHooks } from "./org-slug-hooks";
import { resolveActiveScope } from "./scope";
import {
  type EnterpriseAuthPlugin,
  SSO_PROVISIONED_ROLE,
  ssoProvisioningPlugin,
} from "./sso-provisioning";

/** One OpenFGA client when configured (shared by the engine + the dual-write writer). */
function buildFgaClient(core: CoreContext): OpenFgaClient | null {
  if (!core.fga.isEnabled()) return null;
  const cfg = core.fga.getConfig();
  return new OpenFgaClient({
    apiUrl: cfg.apiUrl,
    storeId: cfg.storeId,
    authorizationModelId: cfg.modelId,
  });
}

/** Every enterprise feature on — the grant for a licensed instance / a paid org. */
const ALL_ENTITLEMENTS: Entitlements = {
  organizations: true,
  teams: true,
  sso: true, // OIDC + SAML via @better-auth/sso
  customRoles: true,
  activityExport: true,
  alerting: true,
  advancedAlerting: true,
  byoRunners: true,
  managedPools: true,
  agentPolicy: true, // the governance toggles of ./agent-policy
  // A licensed instance gets the enterprise tier's quotas (mirrors the ladder in
  // core's planEntitlements("enterprise"); inlined to keep this package type-only on core).
  quotas: {
    maxConcurrentJobs: null,
    priorityLevel: 30,
    includedRunnerMinutes: 20_000,
    activityRetentionDays: 365,
  },
  // NOTE: AI is no longer a plan entitlement — it's a standalone metered product with its
  // own tier ladder (console lib/billing/ai-plan.ts, resolved per-org via resolveAiTier).
};

/**
 * The entitlements the instance licence grants to every organization at `now`, or null when it
 * grants none. It grants only when the licence verified and its state at `now` is one that grants
 * (`active`, `expiring` or `grace`; see ./license `licenseState`). Every other state is null, so
 * the caller falls back to what the organization's own plan gives it.
 */
export function licensedEntitlements(instance: InstanceLicense, now: Date): Entitlements | null {
  if (instance.license === undefined || !licenseGrants(licenseState(instance, now, true))) return null;
  return instance.license.entitlements ?? ALL_ENTITLEMENTS;
}

/** The names of the capability switches that are on in a set of entitlements. Quotas are not switches. */
function capabilityNames(entitlements: Entitlements): string[] {
  const entries: [string, unknown][] = Object.entries(entitlements);
  return entries.filter(([, value]) => value === true).map(([name]) => name);
}

/** An instant in Unix seconds as an ISO 8601 string, or null when there is none. */
function isoInstant(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * The report this package makes about the instance it is loaded into: the state of the instance
 * licence at `now`, the capabilities that licence grants, and every module of
 * {@link ENTERPRISE_FEATURES} with whether it is built.
 *
 * The state is ./license `licenseState` at `now`. The capabilities are listed exactly when
 * {@link licensedEntitlements} grants, and the list is empty in every other state — the report and
 * the entitlement resolver decide from the same function, so they cannot disagree. A licence that
 * is installed and was not verified is `invalid`; no installed licence is `none`.
 *
 * @param instance the resolved instance licence
 * @param features the module registry to report
 * @param now the instant the licence's end is compared against
 * @param licenseInstalled whether the operator installed a licence at all
 */
export function editionReport(
  instance: InstanceLicense,
  features: readonly EnterpriseFeature[],
  now: Date,
  licenseInstalled: boolean,
): EnterpriseEditionReport {
  const state: LicenseState = licenseState(instance, now, licenseInstalled);
  const granted = licensedEntitlements(instance, now);
  // The claims of a licence are named only when it was verified; an unverified one names nothing.
  const license = instance.verified ? instance.license : undefined;
  return {
    license: {
      state,
      subject: license?.subject ?? null,
      tier: license?.tier ?? null,
      expiresAt: isoInstant(license?.expiresAt),
      graceEndsAt: isoInstant(license ? graceEndsAt(license) : null),
    },
    capabilities: granted === null ? [] : capabilityNames(granted),
    features: features.map(({ id, built }) => ({ id, built })),
  };
}

/** Reads a string `organizationId` off an unknown request body, else null. */
function bodyOrgId(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "organizationId" in body) {
    const value = body.organizationId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * One enterprise module's registration entry: what it adds to the instance when `register(core)`
 * runs: Better Auth plugins (endpoints and before/after hooks), appended after `organization()` and
 * `sso()` in the order of {@link ENTERPRISE_FEATURES}, and — for the one module that provides it —
 * the approval engine's agent policy.
 */
export interface EnterpriseFeature {
  /** The module's name; for the ones below it is also its directory under `ee/src/`. */
  id: string;
  /** Whether the module is built. A planned module holds its place with `built: false`. */
  built: boolean;
  /** The Better Auth plugins this module mounts, built from the injected core capabilities. */
  authPlugins: (core: CoreContext) => EnterpriseAuthPlugin[];
  /**
   * The agent policy this module gives the approval engine (core's
   * lib/approvals/enterprise-policy.ts), built from the module's entitlement resolver. At most one
   * entry provides it; `register` mounts the first.
   */
  agentPolicy?: (resolveEntitlements: EntitlementResolver) => EnterpriseAgentPolicy;
}

/** The entry of a module that is planned and not built: it registers nothing. */
function notBuilt(id: string): EnterpriseFeature {
  return { id, built: false, authPlugins: () => [] };
}

/**
 * Every enterprise module, in registration order. A module that is not built yet holds its place
 * with a {@link notBuilt} entry. The unit that builds it replaces that one line with the entry its
 * own directory exports and adds the import for it; `register` below does not change.
 */
export const ENTERPRISE_FEATURES: readonly EnterpriseFeature[] = [
  // Access for a member who arrives through single sign-on (./sso-provisioning).
  {
    id: "sso-provisioning",
    built: true,
    authPlugins: (core) => [ssoProvisioningPlugin(core)],
  },
  // Enforced single sign-on — ee/src/enforced-sso/
  notBuilt("enforced-sso"),
  // Identity-provider group to role mapping — ee/src/group-mapping/
  notBuilt("group-mapping"),
  // SCIM provisioning — ee/src/scim/
  notBuilt("scim"),
  // Audit-log streaming — ee/src/audit-stream/
  notBuilt("audit-stream"),
  // Second factor and session policy — ee/src/session-policy/
  notBuilt("session-policy"),
  // Agent policy: a different approver and the OAuth client allow-list (./agent-policy).
  {
    id: "agent-policy",
    built: true,
    authPlugins: () => [],
    agentPolicy,
  },
];

export const register: EnterpriseEntrypoint<CoreContext, EnterpriseModule> = (
  core,
) => {
  const fgaClient = buildFgaClient(core);
  const slugHooks = orgSlugHooks(core.reservedOrgSlugRefusal, core.orgSlugShapeRefusal);
  const setupHooks = newOrgSetupHooks(core.newOrgSetup);
  const tupleSync = fgaClient ? new FgaTupleSync(core, fgaClient) : undefined;

  // Per-org entitlement resolution, and the answer both entitlement gates in this file read (team
  // creation and single sign-on registration; the invitation gate asks core a billing question
  // and is not one of them). An instance licence that grants (see licensedEntitlements) unlocks
  // its entitlements for every organization
  // — an explicit entitlements claim in the licence narrows it, else the full set; otherwise the
  // org's plan + subscription status (from its billing record, via core) decides — so an
  // unsubscribed org falls back to the community baseline and the org-creation gate bites. The
  // licence is a signed JWT verified offline (see ./license).
  const resolveEntitlements = async (orgId: string): Promise<Entitlements> => {
    const granted = licensedEntitlements(await resolveInstanceLicense(), new Date());
    return granted ?? core.resolveOrgEntitlements(orgId);
  };

  // Resolve + log the instance license once at boot (fire-and-forget — never blocks or crashes
  // register). A verified licence in a granting state ⇒ every org is enterprise; otherwise per-org
  // billing decides, and the reason (no licence / bad signature / no built-in key) is surfaced so a
  // misconfigured licence is diagnosable.
  void resolveInstanceLicense().then((instance) => {
    if (instance.verified) {
      const exp = instance.license?.expiresAt;
      console.info(
        `[license] instance licence verified (${instance.license?.subject ?? "unknown"}, tier=${
          instance.license?.tier ?? "enterprise"
        }${
          exp ? `, expires ${new Date(exp * 1000).toISOString()}, grace ${instance.license?.graceDays ?? 0} days` : ", no end"
        }, state=${licenseState(instance, new Date(), true)})`,
      );
    } else {
      console.info(
        `[license] instance not licensed — ${instance.reason}; using per-org billing`,
      );
    }
  });

  return {
    // Better Auth organization plugin: orgs / teams / members / invitations.
    authPlugins: [
      organization({
        creatorRole: "owner",
        // Group-based grants: a grant can target a team (grants.principal_type='team').
        // `defaultTeam.enabled: false` — DON'T let better-auth auto-create a per-org
        // default team on org create: that implicit team trips the Enterprise
        // `beforeCreateTeam` gate below (a new org has no `teams` entitlement), which
        // would 403 the whole `/organization/create`. Teams are created explicitly
        // (and stay Enterprise-gated); orgs don't need a default one.
        teams: { enabled: true, defaultTeam: { enabled: false } },
        // Membership roles = the PDP roles (owner/admin/operator/viewer), injected
        // from core so the org-plugin role vocabulary matches end-to-end.
        ac: core.orgAc,
        roles: core.orgRoles,
        // Send the invitation email (the drafted emails/invite.tsx) via core.
        sendInvitationEmail: async (data) => {
          await core.sendInviteEmail({
            to: data.email,
            inviterName:
              data.inviter.user.name ?? data.inviter.user.email ?? "A teammate",
            workspaceName: data.organization.name,
            role: typeof data.role === "string" ? data.role : data.role[0],
            token: data.id,
          });
          core.emitAlertEvent(data.organization.id, "system.member.invited", {
            title: `Member invited: ${data.email}`,
            severity: "info",
            actor_id: data.inviter.user.id,
            resource_type: "member",
          });
        },
        // Sync org membership → PDP grants on every lifecycle event, so the PDP
        // (which authorizes from grants, not member.role) actually grants access.
        organizationHooks: {
          // A slug a console route / the marketing zone / a sibling app owns (#5445), or one that
          // breaks the org-slug shape every form checks (#5509), is refused HERE, in the endpoint,
          // so a request that skips the console's forms is refused too.
          beforeUpdateOrganization: async (data) => {
            await slugHooks.beforeUpdateOrganization(data);
            return setupHooks.beforeUpdateOrganization(data);
          },
          // The reserved-slug and slug-shape refusals first; then the paid create-a-team marker is kept only for the
          // user who owns that charge's setup record, and stamped with them (#5445).
          beforeCreateOrganization: async (data) => {
            await slugHooks.beforeCreateOrganization(data);
            return setupHooks.beforeCreateOrganization(data);
          },
          // An invitation accepted by someone who is ALREADY in the team is refused with a reason
          // (#5445). better-auth's accept does not check, and `member` is unique on (organization,
          // user) — so the insert failed with a raw unique violation the person saw only as an
          // unexplained error. Before the index it inserted a second row: a second billable seat.
          //
          // An invitation whose inviter is no longer an active member of the org is refused too
          // (#5472): better-auth's accept does not re-check the inviter, so an admin who invited a
          // second account they control and was then suspended or removed still got it in at the
          // role they chose. This holds for every invitation that is accepted through better-auth,
          // including the ones `POST /api/cli/orgs/:id/members` and `provisionOrg` insert directly.
          //
          // A member whose row is NOT active (suspended) is refused with that reason instead (#5463):
          // "already a member, nothing to accept" told them they were in when they are locked out,
          // and an invitation does not reactivate a membership — reactivating is an admin's action.
          beforeAcceptInvitation: async ({ invitation, user }) => {
            if (await core.isOrgMember(invitation.organizationId, user.id)) {
              if (await core.isNonActiveMember(invitation.organizationId, user.id)) {
                throw new APIError("FORBIDDEN", {
                  code: "MEMBER_NOT_ACTIVE",
                  message:
                    "Your membership in this team is not active, and an invitation can't reactivate it. Ask a team admin to reactivate your membership.",
                });
              }
              throw new APIError("BAD_REQUEST", {
                code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
                message: "You're already a member of this team, so there is nothing to accept.",
              });
            }
            const refusal = await core.inviterRefusal(
              invitation.organizationId,
              invitation.inviterId,
            );
            if (refusal) {
              throw new APIError("FORBIDDEN", { code: "INVITER_NOT_ACTIVE", message: refusal });
            }
          },
          // Pay-to-collaborate: a card-less Pro trial is solo. Block invites until
          // the org is on a paid (or card-backed) subscription — enforced here so
          // it holds regardless of the client (the UI shows the upsell separately).
          //
          // An inviter whose membership is not active is refused too (#5472): better-auth
          // authorizes an invitation from `member.role` alone, so a suspended admin could invite a
          // second account they control and `afterAcceptInvitation` granted it as an active admin.
          // The auth route refuses this before better-auth runs; this hook holds it inside
          // better-auth's create-invitation endpoint, whichever HTTP route reached that endpoint.
          // It does NOT see an invitation row written outside better-auth: `POST
          // /api/cli/orgs/:id/members` inserts one directly, and is authorized by `authorizeCliOrg`
          // (an ACTIVE member row and the route's permission in the path org, #5480) and by the PDP,
          // which denies a member who is not active. `beforeAcceptInvitation` re-checks the inviter
          // of every invitation at acceptance, whichever path wrote it.
          beforeCreateInvitation: async ({ invitation, inviter }) => {
            if (await core.isNonActiveMember(invitation.organizationId, inviter.id)) {
              throw new APIError("FORBIDDEN", {
                code: "MEMBER_NOT_ACTIVE",
                message: "Your membership in this team is not active, so you can't invite.",
              });
            }
            if (!(await core.canOrgInvite(invitation.organizationId))) {
              throw new APIError("FORBIDDEN", {
                message:
                  "Add a payment method to invite teammates — trials are single-member.",
              });
            }
          },
          // Teams are an Enterprise capability. Block creation server-side so the
          // gate holds regardless of the client (the UI shows the upsell separately).
          // Decided from the same entitlements the organization's scope carries: the
          // instance licence when it grants, else the organization's plan.
          beforeCreateTeam: async ({ team }) => {
            if (!(await core.canOrgCreateTeams(team.organizationId, resolveEntitlements))) {
              throw new APIError("FORBIDDEN", {
                message: "Teams require an Enterprise plan.",
              });
            }
          },
          afterCreateOrganization: async (data) => {
            await core.ensureMemberGrant(data.organization.id, data.user.id, "owner");
            await setupHooks.afterCreateOrganization(data);
          },
          afterAddMember: async ({ organization: org, user, member }) => {
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // Per-seat billing: a new billable member bumps the subscription quantity.
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "join", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.joined", {
              title: `Member joined: ${user.email ?? user.id}`,
              severity: "info",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          // Accepting an invitation creates the member row via a DIFFERENT code path
          // than /organization/add-member: Better Auth fires afterAcceptInvitation
          // here, NOT afterAddMember. Without this hook an accepted member gets a
          // member row but NO PDP grant — and the PDP authorizes from grants, not
          // member.role, so they'd have zero access. Mirror afterAddMember so an
          // invited member is wired (grant + seat + activity) exactly like a direct add.
          afterAcceptInvitation: async ({
            organization: org,
            user,
            member,
          }) => {
            if (!member.role) {
              // An invitation with no role yields a member with no mappable role, so
              // ensureMemberGrant writes nothing (leaving the member ungranted). It now says so
              // itself for EVERY unmappable role — see core's `toPdpRole` / #3730, where
              // better-auth's own `member` role was unmapped and this branch never fired because
              // the role was present, just unrecognised. Kept because this one is the acceptance
              // path's own precondition and names the invitation.
              console.warn(
                `[authz] accepted invitation for user ${user.id} in org ${org.id} has no role — no grant written`,
              );
            }
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // Per-seat billing: a new billable member bumps the subscription quantity.
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "join", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.joined", {
              title: `Member joined: ${user.email ?? user.id}`,
              severity: "info",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          // A role change that would leave the org with no ACTIVE owner is refused (#5465), and so
          // is one that makes a suspended member an owner (#5472). better-auth refuses only an
          // owner demoting themselves as the last member whose role contains `owner`, and it
          // counts suspended owners; core's rule counts active ones.
          beforeUpdateMemberRole: async ({ member, newRole, organization: org }) => {
            const refusal = await core.roleChangeOwnerRefusal(org.id, member.id, newRole);
            if (refusal) {
              throw new APIError("BAD_REQUEST", {
                code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
                message: refusal,
              });
            }
          },
          // ensureMemberGrant writes no grant for a member who is not active (#5465), so
          // promoting a suspended member changes their stored role and nothing they can reach.
          afterUpdateMemberRole: async ({
            organization: org,
            user,
            member,
          }) => {
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // A role change can flip billable status (e.g. viewer ⇄ operator).
            await core.syncOrgSeats(org.id);
            core.recordActivity(
              { userId: user.id, orgId: org.id },
              "role_change",
              {
                type: "member",
                id: user.id,
              },
            );
          },
          // A removal that would leave the org with no ACTIVE owner is refused (#5472).
          // better-auth refuses removing an owner only when no other member's role contains
          // `owner`, and it counts suspended owners.
          beforeRemoveMember: async ({ member, organization: org }) => {
            const refusal = await core.removalOwnerRefusal(org.id, member.id);
            if (refusal) {
              throw new APIError("BAD_REQUEST", {
                code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
                message: refusal,
              });
            }
          },
          afterRemoveMember: async ({ organization: org, user }) => {
            await core.revokeMemberGrant(org.id, user.id);
            // Per-seat billing: removing a billable member frees a seat (prorated).
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "remove", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.removed", {
              title: `Member removed: ${user.email ?? user.id}`,
              severity: "warning",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          // Team membership → OpenFGA group tuples (team:T#member@user:U), so
          // team-scoped grants reach members. Postgres resolves team_member at
          // query time; this keeps the FGA store in step.
          afterAddTeamMember: async ({ teamMember, user }) => {
            await tupleSync?.syncTeamMember(teamMember.teamId, user.id);
          },
          afterRemoveTeamMember: async ({ teamMember, user }) => {
            await tupleSync?.removeTeamMember(teamMember.teamId, user.id);
          },
        },
      }),

      // Enterprise SSO (OIDC + SAML): Alethia as the Service Provider consuming
      // the customer's IdP (Okta / Entra ID / AWS IAM Identity Center / …).
      // Loaded after organization() so per-org providers (ssoProvider.organizationId)
      // resolve. A person signing in through their organization's IdP for the first
      // time is added to that organization as a least-privileged member, and the
      // `sso-provisioning` entry of ENTERPRISE_FEATURES — mounted after this plugin —
      // gives that member their grant (./sso-provisioning).
      sso({
        organizationProvisioning: {
          // better-auth's org role (owner/admin/member) — least-privileged "member",
          // which core's `toPdpRole` maps to Alethia's viewer bundle. The SSO plugin
          // writes the member row itself, outside the `organizationHooks` above; the
          // grant, the seat reconciliation and the activity record for that row are
          // ./sso-provisioning's, which grants this role and no other.
          defaultRole: SSO_PROVISIONED_ROLE,
        },
        saml: {
          // Every SAML response must answer an AuthnRequest this instance issued and
          // still remembers: a response that names no request, an unknown one or an
          // expired one is refused. That also refuses IdP-initiated sign-in — a person
          // starts from Alethia's sign-in page, not from the IdP's app launcher. Both
          // values are the installed plugin's defaults, stated so that the behaviour
          // is this file's decision rather than a dependency's.
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          // A response, or a provider configuration, that uses a deprecated algorithm
          // (SHA-1 signatures or digests, RSA 1.5 key transport, 3DES) is refused
          // rather than accepted with a warning.
          algorithms: { onDeprecated: "reject" },
        },
        // Prove the customer controls the domain before we trust the IdP for it.
        // This gates TWO things in @better-auth/sso: (1) sign-in through a provider
        // whose domain isn't verified is rejected, and (2) JIT account-linking by
        // email domain ("isTrustedProvider") — without it, registering a provider for
        // a domain you don't own would let you link into existing accounts on it.
        // The token is a DNS TXT record at `_alethia-sso-<providerId>`; the plugin
        // stores it in the core `verification` table (no schema change needed).
        domainVerification: { enabled: true, tokenPrefix: "alethia-sso" },
      }),

      // Entitlement gate for SSO registration. The @better-auth/sso plugin enforces
      // org membership/admin but NOT the entitlement, so this refuses /sso/register
      // unless the target org holds `sso` (the UI shows the upsell instead). Decided
      // from the same entitlements the organization's scope carries: the instance
      // licence when it grants, else the organization's plan.
      {
        id: "alethia-sso-entitlement-guard",
        hooks: {
          before: [
            {
              matcher: (context: { path?: string }) =>
                context.path === "/sso/register",
              handler: createAuthMiddleware(async (ctx) => {
                const orgId = bodyOrgId(ctx.body);
                if (!orgId || (await resolveEntitlements(orgId)).sso !== true) {
                  throw new APIError("FORBIDDEN", {
                    message: "Single Sign-On requires an Enterprise plan.",
                  });
                }
              }),
            },
          ],
        },
      },

      // The enterprise modules' own plugins, after organization() and sso() so their
      // hooks see what those two wrote.
      ...ENTERPRISE_FEATURES.flatMap((feature) => feature.authPlugins(core)),
    ],

    // Map a verified user to their active org — the personal org named explicitly, else a
    // membership row for the named org, else the primary (earliest) membership, else the
    // personal org. Lifted into ./scope so the rules can be driven directly by a test rather
    // than only through a booted enterprise module; see its JSDoc for why a named org the
    // caller is not a member of still falls back HERE and is refused by the header's reader.
    // STANDUP follow-up: honor session.activeOrganizationId for active-org switching
    // (needs the session/headers threaded into getActiveScope).
    resolveScope: (userId: string, activeOrgId?: string): Promise<ResolvedScope> =>
      resolveActiveScope(core.db, userId, activeOrgId),

    // Per-org entitlement resolution — the resolver the gates above read.
    resolveEntitlements,

    // The enterprise agent-policy toggles the approval engine consults, gated by the same
    // entitlement resolver: an organization without `agentPolicy` is answered as core answers.
    agentPolicy: ENTERPRISE_FEATURES.find((feature) => feature.agentPolicy)?.agentPolicy?.(resolveEntitlements),

    // The instance edition report: the licence state, the capabilities it grants and the
    // module registry, read by the console's one edition reader.
    instanceEdition: async (): Promise<EnterpriseEditionReport> =>
      editionReport(
        await resolveInstanceLicense(),
        ENTERPRISE_FEATURES,
        new Date(),
        (process.env.ALETHIA_LICENSE_KEY ?? "") !== "",
      ),

    // OpenFGA engine + dual-write, both only when OpenFGA is configured; otherwise
    // undefined ⇒ the community PostgresRbacPDP + no-op seam stay in place.
    pdp: fgaClient ? new OpenFgaPdp(core, fgaClient) : undefined,
    tupleSync,
  };
};
