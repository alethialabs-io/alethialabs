// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of the authorization layer: the PDP contract + the `getPdp()` seam
// (community PostgresRbacPDP, overridable by ee/), the registry-as-code, and the
// entitlement seam. Call sites use getPdp().enforce(...) / .listAccessible(...).

import { getEnterprise } from "@/lib/enterprise";
import { PostgresRbacPDP } from "./postgres-rbac-pdp";
import { withScopeCeiling } from "./scope-ceiling";
import type { Pdp } from "./types";

export type {
	Actor,
	BulkCheck,
	Decision,
	Entitlements,
	Pdp,
	ResourceRef,
} from "./types";
export { ForbiddenError } from "./types";
export {
	ACTIONS,
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	PERMISSIONS,
	RESOURCES,
	isPermissionKey,
} from "./registry";
export type { Action, BuiltInRole, PermissionKey, Resource } from "./registry";
export { getEntitlements } from "./entitlements";

declare global {
	var __alethiaPdp: Pdp | undefined;
}

/**
 * The active PDP — the enterprise engine if registered, else community PostgresRbacPDP — held to
 * the scope ceiling of the actor it is asked about (lib/authz/scope-ceiling.ts). An actor with no
 * ceiling gets the engine's answer unchanged; one built from a limited credential is refused a verb
 * outside its scopes or a project outside its list, whichever engine is behind it.
 */
export function getPdp(): Pdp {
	return withScopeCeiling(enginePdp());
}

/** The decision engine itself: the enterprise one if registered, else the community one. */
function enginePdp(): Pdp {
	const ee = getEnterprise()?.pdp;
	if (ee) return ee;
	if (!globalThis.__alethiaPdp) {
		globalThis.__alethiaPdp = new PostgresRbacPDP();
	}
	return globalThis.__alethiaPdp;
}
