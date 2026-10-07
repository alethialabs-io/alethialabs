// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE single open-core integration point. The AGPL core never imports `ee/`
// statically — this allowlisted file performs ONE tolerant, synchronous load of the
// enterprise package and registers its implementations; the seams (getPdp /
// getActiveScope / getAuthPlugins / getEntitlements) read them, falling back to
// community defaults when nothing is registered. The boundary-guard lint
// (scripts/check-ee-boundary.mjs) allowlists ONLY this file. See project 12.

import { createRequire } from "node:module";
import {
  parseAlethiaEdition,
  type EnterpriseEntrypoint,
  type EnterprisePackage,
} from "@alethia/enterprise-api";
import type { BetterAuthOptions } from "better-auth";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { enforceDecision, recordActivity } from "@/lib/authz/activity";
import { checksFor, denyChecksFor } from "@/lib/authz/fga-mapping";
import { buildAuthorizationModel } from "@/lib/authz/fga-model";
import {
  expandGrant,
  grantScopeFromRow,
  hierarchyTuple,
  teamMemberTuple,
} from "@/lib/authz/fga-tuples";
import { listOrgResourceIds } from "@/lib/authz/resource-tables";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import { canOrgCreateTeams, canOrgInvite } from "@/lib/billing/collaboration";
import { syncOrgSeats } from "@/lib/billing/seats";
import { removalOwnerRefusal, roleChangeOwnerRefusal } from "@/lib/authz/active-owner";
import {
  ensureMemberGrant,
  inviterRefusal,
  isNonActiveMember,
  lacksActiveMembership,
  revokeMemberGrant,
} from "@/lib/authz/grants";
import { INSTANCE_TYPES } from "@/lib/authz/fga-hierarchy";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import type { TupleSync } from "@/lib/authz/tuple-sync";
import type { Actor, Entitlements, Pdp } from "@/lib/authz/types";
import { resolveOrgEntitlements } from "@/lib/billing/queries";
import { getOpenFgaConfig, isOpenFgaEnabled } from "@/lib/config/openfga";
import { getServiceDb } from "@/lib/db";
import { sendInviteEmail } from "@/lib/email/notify-email";
import { isMember } from "@/lib/platform/provision";
import { reservedOrgSlugRefusal } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";
import {
  keepStoredNewOrgMarker,
  recordNewOrgCreated,
  stampNewOrgMetadata,
} from "@/lib/billing/pending-org-setup";

/**
 * Capabilities the core injects into the enterprise module. `ee/` queries through
 * `core.db` (raw SQL), uses `core.orgAc`/`core.orgRoles` so the organization plugin's
 * membership roles match the PDP, `core.ensureMemberGrant`/`core.revokeMemberGrant` to
 * sync membership → PDP grants, `core.sendInviteEmail` to send the invitation email,
 * and `core.fga` (the pure OpenFGA model/tuple helpers + config) so the ee/ engine +
 * tuple writer use core logic without importing core at runtime — only erased type
 * imports. Keeps the dependency direction clean.
 */
export interface CoreContext {
  db: ReturnType<typeof getServiceDb>;
  orgAc: typeof orgAc;
  orgRoles: typeof orgRoles;
  ensureMemberGrant: typeof ensureMemberGrant;
  revokeMemberGrant: typeof revokeMemberGrant;
  sendInviteEmail: typeof sendInviteEmail;
  /**
   * The pay-to-collaborate gate: whether an org may invite members (paid or
   * card-backed trial). Injected so the organization plugin's beforeCreateInvitation
   * hook can block invites on a card-less trial without ee/ importing core billing.
   */
  canOrgInvite: typeof canOrgInvite;
  /**
   * The Enterprise gate for team creation: whether an org may create teams. Injected so
   * the organization plugin's beforeCreateTeam hook can block team creation on a
   * non-Enterprise org without ee/ importing core billing.
   */
  canOrgCreateTeams: typeof canOrgCreateTeams;
  /**
   * Why a slug is reserved (a console route / the marketing zone / a sibling app owns that path),
   * or null. Injected so the organization plugin's beforeCreateOrganization /
   * beforeUpdateOrganization hooks refuse a reserved slug SERVER-SIDE — the client checks were the
   * only enforcement, so a direct `/organization/create` with slug `docs` succeeded (#5445) — without
   * ee/ importing core's routing table.
   */
  reservedOrgSlugRefusal: typeof reservedOrgSlugRefusal;
  /**
   * Why a slug breaks the org-slug rule's shape (too long, or its characters), or null — the one
   * rule every console form checks (@repo/org-slug). Injected for the same two hooks, so a direct
   * `/organization/create` or `/organization/update` cannot store `-acme` or a 64-character slug
   * that every form refuses (#5509).
   */
  orgSlugShapeRefusal: typeof orgSlugShapeRefusal;
  /**
   * The paid create-a-team setup's two organization-create hooks (#5445): `stampMetadata` keeps the
   * marker that ties a new org to its charge only for the user who owns that charge's setup record
   * (and refuses a second org for one charge); `recordCreated` writes the new org onto that record;
   * `keepStoredMarker` makes an update carry the stored marker, never the request's. Injected so the organization plugin's create hooks can run them without ee/ importing core billing.
   */
  /**
   * Whether a user already holds a membership in an organization. Injected so the organization
   * plugin's `beforeAcceptInvitation` refuses an invitation accepted by an existing member with a
   * reason, instead of the raw unique violation the `member` index raises (#5445).
   */
  isOrgMember: typeof isMember;
  /**
   * Why a member role change would leave the org with no active owner, or null. Injected so the
   * organization plugin's `beforeUpdateMemberRole` refuses it (#5465) without ee/ importing core's
   * role reading or the database.
   */
  roleChangeOwnerRefusal: typeof roleChangeOwnerRefusal;
  /**
   * Why removing a member would leave the org with no active owner, or null. Injected so the
   * organization plugin's `beforeRemoveMember` refuses it (#5472).
   */
  removalOwnerRefusal: typeof removalOwnerRefusal;
  /**
   * Whether a user's member row in an org has a status other than `active`. Injected so the
   * organization plugin's `beforeCreateInvitation` refuses a suspended inviter (#5472).
   */
  isNonActiveMember: typeof isNonActiveMember;
  /**
   * Whether a user is not an active member of an org (a non-active row, or no row outside their
   * personal scope). Injected so the OpenFGA PDP denies such an actor before reading a tuple, the
   * rule `PostgresRbacPDP` applies in its own query (#5472).
   */
  lacksActiveMembership: typeof lacksActiveMembership;
  /**
   * Why an invitation may not be accepted because its inviter is no longer an active member, or
   * null. Injected so the organization plugin's `beforeAcceptInvitation` refuses it (#5472).
   */
  inviterRefusal: typeof inviterRefusal;
  newOrgSetup: {
    stampMetadata: typeof stampNewOrgMetadata;
    recordCreated: typeof recordNewOrgCreated;
    keepStoredMarker: typeof keepStoredNewOrgMarker;
  };
  /**
   * Reconciles an org's per-seat subscription quantity with its billable membership
   * (prorated). Injected so the organization plugin's member lifecycle hooks keep
   * Stripe seats in step without ee/ importing core billing.
   */
  syncOrgSeats: typeof syncOrgSeats;
  /**
   * Emits an alert event (best-effort, fire-and-forget) so ee/ membership hooks can
   * raise `system.member.*` alerts without importing core's alerting runtime — only
   * this core-provided method. Keeps the ee→core boundary clean.
   */
  emitAlertEvent: typeof emitAlertEventSafe;
  /**
   * Records an Activity-log entry (best-effort) so ee/ membership hooks can log
   * invites/removals/role-changes into the org Activity feed without importing core's
   * authz runtime — only this core-provided method.
   */
  recordActivity: typeof recordActivity;
  /**
   * Resolves an org's entitlements from its billing record (plan + subscription
   * status). Injected so the ee/ entitlement resolver decides per-org from billing
   * without importing core runtime — the hosted path. (A signed license / dev flag
   * can still short-circuit to an instance-wide grant.)
   */
  resolveOrgEntitlements: typeof resolveOrgEntitlements;
  fga: {
    buildModel: typeof buildAuthorizationModel;
    expandGrant: typeof expandGrant;
    /**
     * Narrows a raw `grants` row to the typed `GrantScope` `expandGrant` takes — or null when the
     * row resolves to nothing for its effect (under `EMPTY_SCOPE_DENIES = "the_whole_org"`, only
     * an ALLOW row can). Injected here rather than imported in ee/, on
     * the same seam as `expandGrant`, because the two must never be able to disagree: ee's tuple
     * writer decides where a grant's tuples LIVE and `expandGrant` decides what they ARE, and if
     * those two read the scope separately a revoke deletes from an object the write never touched.
     *
     * It applies `targetForEffect` (lib/authz/grant-scope.ts), the one predicate both PDP engines
     * answer "what does this row scope to?" with — effect-aware because an allow row is asked what
     * it CONFERS and a deny row what it EXCLUDES (see `EMPTY_SCOPE_DENIES`).
     */
    grantScopeFromRow: typeof grantScopeFromRow;
    hierarchyTuple: typeof hierarchyTuple;
    teamMemberTuple: typeof teamMemberTuple;
    rolePermissionKeys: typeof rolePermissionKeys;
    checksFor: typeof checksFor;
    denyChecksFor: typeof denyChecksFor;
    enforceDecision: typeof enforceDecision;
    listOrgResourceIds: typeof listOrgResourceIds;
    /**
     * The resource kinds with their own per-instance FGA object (each carries a `parent` tuple to
     * its org). The tuple writer reads them to find which of a user's tuples live in one org.
     */
    instanceTypes: typeof INSTANCE_TYPES;
    isEnabled: typeof isOpenFgaEnabled;
    getConfig: typeof getOpenFgaConfig;
  };
}

export interface EnterpriseModule {
  /** Engine override (e.g. OpenFgaPdp). Community uses the default PostgresRbacPDP. */
  pdp?: Pdp;
  /** OpenFGA dual-write writer. Community = absent → the seam's no-op. */
  tupleSync?: TupleSync;
  /**
   * Resolves a user's active tenancy scope (multi-org). `activeOrgId` is the org the
   * session selected (validate membership before honoring it); fall back to the
   * user's primary org, then the personal org. Community = personal org.
   */
  resolveScope?: (userId: string, activeOrgId?: string) => Promise<Actor>;
  /** Extra Better Auth plugins (organization, SSO). Community = none. */
  authPlugins?: NonNullable<BetterAuthOptions["plugins"]>;
  /**
   * Feature entitlements for an org, resolved per-org (async) when the scope is
   * built: a signed license / dev flag grants instance-wide (self-managed); else the
   * org's billing record drives it (hosted). Community (no ee/) = all-off baseline.
   */
  resolveEntitlements?: (orgId: string) => Promise<Entitlements>;
}

/** `@alethia/ee`'s entry point: receives core capabilities, returns its module. */
export type EnterpriseRegister = EnterpriseEntrypoint<
  CoreContext,
  EnterpriseModule
>;

let registered: EnterpriseModule | null = null;
let loaded = false;

/** Whether an unknown error is Node's missing-module error for the optional package. */
function isMissingEnterprisePackage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  const normalizedMessage = error.message.replaceAll("\\", "/");
  return (
    code === "MODULE_NOT_FOUND" &&
    (normalizedMessage.includes("'@alethia/ee'") ||
      normalizedMessage.includes('"@alethia/ee"') ||
      normalizedMessage.includes("Cannot find module @alethia/ee") ||
      normalizedMessage.includes("/@alethia/ee/dist/index.js"))
  );
}

/** Validate the intentionally dynamic module before invoking its entry point. */
function isEnterprisePackage(
  value: unknown,
): value is EnterprisePackage<CoreContext, EnterpriseModule> {
  return (
    typeof value === "object" &&
    value !== null &&
    "register" in value &&
    typeof value.register === "function"
  );
}

/**
 * One-time, tolerant, SYNCHRONOUS load of the enterprise package. Synchronous so the
 * enterprise auth plugins are available when lib/auth/index.ts builds betterAuth()
 * at module-eval (getAuthPlugins → getEnterprise → here). Community: `@alethia/ee` is
 * not installed → require throws → `registered` stays null → seams keep their
 * defaults. The specifier is held in a variable so the bundler can't statically
 * resolve (and fail to find) it in a community build.
 */
function loadEnterprise(): void {
  if (loaded) return;
  loaded = true;
  const edition = parseAlethiaEdition(process.env.ALETHIA_EDITION);
  if (edition === "community") {
    registered = null;
    return;
  }
  const pkg = "@alethia/ee";
  try {
    const mod: unknown = createRequire(import.meta.url)(pkg);
    if (!isEnterprisePackage(mod)) {
      throw new Error("@alethia/ee does not export register(core).");
    }
    registered = mod.register({
      db: getServiceDb(),
      orgAc,
      orgRoles,
      ensureMemberGrant,
      revokeMemberGrant,
      sendInviteEmail,
      canOrgInvite,
      canOrgCreateTeams,
      reservedOrgSlugRefusal,
      orgSlugShapeRefusal,
      isOrgMember: isMember,
      roleChangeOwnerRefusal,
      removalOwnerRefusal,
      isNonActiveMember,
      lacksActiveMembership,
      inviterRefusal,
      newOrgSetup: {
        stampMetadata: stampNewOrgMetadata,
        recordCreated: recordNewOrgCreated,
        keepStoredMarker: keepStoredNewOrgMarker,
      },
      syncOrgSeats,
      emitAlertEvent: emitAlertEventSafe,
      recordActivity,
      resolveOrgEntitlements,
      fga: {
        buildModel: buildAuthorizationModel,
        expandGrant,
        grantScopeFromRow,
        hierarchyTuple,
        teamMemberTuple,
        rolePermissionKeys,
        checksFor,
        denyChecksFor,
        enforceDecision,
        listOrgResourceIds,
        instanceTypes: INSTANCE_TYPES,
        isEnabled: isOpenFgaEnabled,
        getConfig: getOpenFgaConfig,
      },
    });
  } catch (error) {
    if (edition !== "enterprise" && isMissingEnterprisePackage(error)) {
      registered = null;
      return;
    }
    throw error;
  }
}

/** Explicit registration hook (tests / non-bundler hosts). Marks load complete. */
export function registerEnterprise(mod: EnterpriseModule): void {
  registered = mod;
  loaded = true;
}

/** The registered enterprise module, or null in a community build. */
export function getEnterprise(): EnterpriseModule | null {
  if (!loaded) loadEnterprise();
  return registered;
}
