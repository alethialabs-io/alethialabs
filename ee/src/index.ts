// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register()` is invoked once at app boot
// (by the core's allowlisted lib/enterprise.ts loader, sub-phase 4.5) and returns
// the implementations the core seams consult: an optional PDP engine override
// (OpenFgaPdp), a tenancy resolver (multi-org getActiveScope), extra Better Auth
// plugins (organization + SSO), and the entitlement gate (signed license).
//
// Skeleton only — the real implementations land in sub-phase 4.5. Returning an
// empty object keeps every core seam on its community default. (This package is
// intentionally NOT yet in pnpm-workspace; it is wired in 4.5.)

/** Returns the enterprise registration (an `EnterpriseModule` from the core). */
export function register(): Record<string, never> {
	return {};
}
