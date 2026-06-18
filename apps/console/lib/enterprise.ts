// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE single open-core integration point. The AGPL core never imports `ee/`
// statically — the enterprise build pushes its implementations in here via
// registerEnterprise() at boot, and the seams (getPdp / getActiveScope /
// getAuthPlugins / getEntitlements) read them, falling back to community defaults
// when nothing is registered. The boundary-guard lint (scripts/check-ee-boundary.mjs)
// allowlists ONLY this file to reference `@alethia/ee`. See spec 12 (Part: ee/ mechanism).

import type { BetterAuthOptions } from "better-auth";
import type { Actor, Entitlements, Pdp } from "@/lib/authz/types";

export interface EnterpriseModule {
	/** Engine override (e.g. OpenFgaPdp). Community uses the default PostgresRbacPDP. */
	pdp?: Pdp;
	/** Resolves a user's active tenancy scope (multi-org). Community = personal org. */
	resolveScope?: (userId: string) => Promise<Actor>;
	/** Extra Better Auth plugins (organization, sso). Community = none. */
	authPlugins?: NonNullable<BetterAuthOptions["plugins"]>;
	/** Feature entitlements for a scope, gated by a signed license. */
	entitlements?: (actor: Actor) => Entitlements;
}

let registered: EnterpriseModule | null = null;

/** Called by `@alethia/ee` at boot (via loadEnterprise). No-op in community. */
export function registerEnterprise(mod: EnterpriseModule): void {
	registered = mod;
}

/** The registered enterprise module, or null in a community build. */
export function getEnterprise(): EnterpriseModule | null {
	return registered;
}
