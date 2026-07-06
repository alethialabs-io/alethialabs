// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of the authorization layer: the PDP contract + the `getPdp()` seam
// (community PostgresRbacPDP, overridable by ee/), the registry-as-code, and the
// entitlement seam. Call sites use getPdp().enforce(...) / .listAccessible(...).

import { getEnterprise } from "@/lib/enterprise";
import { PostgresRbacPDP } from "./postgres-rbac-pdp";
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

const globalForPdp = globalThis as unknown as { __alethiaPdp?: Pdp };

/** The active PDP — the enterprise engine if registered, else community PostgresRbacPDP. */
export function getPdp(): Pdp {
	const ee = getEnterprise()?.pdp;
	if (ee) return ee;
	if (!globalForPdp.__alethiaPdp) {
		globalForPdp.__alethiaPdp = new PostgresRbacPDP();
	}
	return globalForPdp.__alethiaPdp;
}
