// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE single open-core integration point. The AGPL core never imports `ee/`
// statically — this allowlisted file performs ONE tolerant, synchronous load of the
// enterprise package and registers its implementations; the seams (getPdp /
// getActiveScope / getAuthPlugins / getEntitlements) read them, falling back to
// community defaults when nothing is registered. The boundary-guard lint
// (scripts/check-ee-boundary.mjs) allowlists ONLY this file. See project 12.

import { createRequire } from "node:module";
import type { BetterAuthOptions } from "better-auth";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { enforceDecision, recordActivity } from "@/lib/authz/activity";
import { checksFor } from "@/lib/authz/fga-mapping";
import { buildAuthorizationModel } from "@/lib/authz/fga-model";
import {
	expandGrant,
	hierarchyTuple,
	teamMemberTuple,
} from "@/lib/authz/fga-tuples";
import { listOrgResourceIds } from "@/lib/authz/resource-tables";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import { canOrgCreateTeams, canOrgInvite } from "@/lib/billing/collaboration";
import { syncOrgSeats } from "@/lib/billing/seats";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import type { TupleSync } from "@/lib/authz/tuple-sync";
import type { Actor, Entitlements, Pdp } from "@/lib/authz/types";
import { resolveOrgEntitlements } from "@/lib/billing/queries";
import { getOpenFgaConfig, isOpenFgaEnabled } from "@/lib/config/openfga";
import { getServiceDb } from "@/lib/db";
import { sendInviteEmail } from "@/lib/email/notify-email";

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
		hierarchyTuple: typeof hierarchyTuple;
		teamMemberTuple: typeof teamMemberTuple;
		rolePermissionKeys: typeof rolePermissionKeys;
		checksFor: typeof checksFor;
		enforceDecision: typeof enforceDecision;
		listOrgResourceIds: typeof listOrgResourceIds;
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
export type EnterpriseRegister = (core: CoreContext) => EnterpriseModule;

let registered: EnterpriseModule | null = null;
let loaded = false;

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
	const pkg = "@alethia/ee";
	try {
		const mod: { register: EnterpriseRegister } = createRequire(import.meta.url)(
			pkg,
		);
		registered = mod.register({
			db: getServiceDb(),
			orgAc,
			orgRoles,
			ensureMemberGrant,
			revokeMemberGrant,
			sendInviteEmail,
			canOrgInvite,
			canOrgCreateTeams,
			syncOrgSeats,
			emitAlertEvent: emitAlertEventSafe,
			recordActivity,
			resolveOrgEntitlements,
			fga: {
				buildModel: buildAuthorizationModel,
				expandGrant,
				hierarchyTuple,
				teamMemberTuple,
				rolePermissionKeys,
				checksFor,
				enforceDecision,
				listOrgResourceIds,
				isEnabled: isOpenFgaEnabled,
				getConfig: getOpenFgaConfig,
			},
		});
	} catch {
		registered = null; // community build — enterprise package absent
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
