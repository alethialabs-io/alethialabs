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
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import type { Actor, Entitlements, Pdp } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";

/**
 * Capabilities the core injects into the enterprise module. `ee/` queries through
 * `core.db` (raw SQL) and reads `core.builtinRoleIds` for stable role ids, so it
 * needs NO runtime import of core internals — only erased type imports. Keeps the
 * dependency direction clean (ee → core types only).
 */
export interface CoreContext {
	db: ReturnType<typeof getServiceDb>;
	builtinRoleIds: typeof BUILTIN_ROLE_IDS;
}

export interface EnterpriseModule {
	/** Engine override (e.g. OpenFgaPdp). Community uses the default PostgresRbacPDP. */
	pdp?: Pdp;
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
			builtinRoleIds: BUILTIN_ROLE_IDS,
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
