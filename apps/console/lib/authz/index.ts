// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of the authorization layer. The PDP engine (getPdp + the community
// PostgresRbacPDP) is added in sub-phase 4.3; this barrel currently exposes the
// contract, the registry-as-code, and the entitlement seam.

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
	PERMISSIONS,
	RESOURCES,
	isPermissionKey,
} from "./registry";
export type { Action, BuiltInRole, PermissionKey, Resource } from "./registry";
export { getEntitlements } from "./entitlements";
