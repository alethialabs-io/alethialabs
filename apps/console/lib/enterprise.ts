// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE single open-core integration point. The AGPL core never imports `ee/`
// statically — this allowlisted file performs ONE tolerant, synchronous load of the
// enterprise package and registers its implementations; the seams (getPdp /
// getActiveScope / getAuthPlugins / getEntitlements) read them, falling back to
// community defaults when nothing is registered. The boundary-guard lint
// (scripts/check-ee-boundary.mjs) allowlists ONLY this file. See spec 12.

import { createRequire } from "node:module";
import type { BetterAuthOptions } from "better-auth";
import { buildAuthorizationModel } from "@/lib/authz/fga-model";
import {
	expandGrant,
	hierarchyTuple,
	teamMemberTuple,
} from "@/lib/authz/fga-tuples";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import type { TupleSync } from "@/lib/authz/tuple-sync";
import type { Actor, Entitlements, Pdp } from "@/lib/authz/types";
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
	fga: {
		buildModel: typeof buildAuthorizationModel;
		expandGrant: typeof expandGrant;
		hierarchyTuple: typeof hierarchyTuple;
		teamMemberTuple: typeof teamMemberTuple;
		rolePermissionKeys: typeof rolePermissionKeys;
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
	/** Feature entitlements for a scope, gated by a signed license. */
	entitlements?: (actor: Actor) => Entitlements;
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
			fga: {
				buildModel: buildAuthorizationModel,
				expandGrant,
				hierarchyTuple,
				teamMemberTuple,
				rolePermissionKeys,
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
