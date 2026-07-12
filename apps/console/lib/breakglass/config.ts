// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Break-glass feature gate + operator allowlist. THIS IS THE MASTER SWITCH.
//
// The ENTIRE break-glass surface (routes, actions, audit) is fail-closed behind
// `ALETHIA_BREAKGLASS_ENABLED === "true"`. Unset / anything-but-"true" ⇒ the feature does not exist:
// every route 404s and every lib entry point refuses. This is a plain module reading raw
// `process.env` (the byo-*-flag pattern), synchronous and default-off.
//
// Authorization is a SEPARATE allowlist from the read-only support-staff one (SUPPORT_STAFF_EMAILS,
// apps/admin). Being able to READ cross-tenant (support) is NOT being able to ACT (break-glass) —
// so BREAKGLASS_OPERATORS is its own env var, and the two lists are intentionally decoupled.

/** Whether the break-glass surface is enabled at all. Default-off: unset ⇒ false ⇒ everything refuses. */
export function isBreakglassEnabled(): boolean {
	return process.env.ALETHIA_BREAKGLASS_ENABLED === "true";
}

/** The parsed, lowercased BREAKGLASS_OPERATORS allowlist (comma-separated emails). */
export function breakglassOperators(): string[] {
	return (process.env.BREAKGLASS_OPERATORS || "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
}

/** Whether an email is an authorized break-glass operator (case-insensitive). */
export function isBreakglassOperator(email: string | null | undefined): boolean {
	if (!email) return false;
	return breakglassOperators().includes(email.toLowerCase());
}

/**
 * Local-dev fallback identity, mirroring apps/admin's SUPPORT_ADMIN_DEV_EMAIL. Only consulted when
 * no CF-Access header and no CLI bearer are present (no tunnel in front); it must ALSO be in
 * BREAKGLASS_OPERATORS to authorize anything. Never set in production.
 */
export function breakglassDevEmail(): string | null {
	const e = process.env.BREAKGLASS_DEV_EMAIL;
	return e ? e.trim().toLowerCase() : null;
}

/** Session lifetime — a break-glass session is short-lived by design. */
export const BREAKGLASS_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Two-person approval token lifetime — must be spent promptly after a second operator mints it. */
export const BREAKGLASS_APPROVAL_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Whether the (high-blast) orphan-CLEAN force-destroy is armed. Default-off and INDEPENDENT of the
 * master switch: even an enabled break-glass surface refuses orphan_clean unless this is also true,
 * because a cross-cloud force-destroy is the single most dangerous action and ships INERT until a
 * scoped, proven executor exists (see catalog.ts + actions.ts). orphan_DETECT (read-only) is always
 * available when break-glass is enabled.
 */
export function isOrphanCleanArmed(): boolean {
	return process.env.ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED === "true";
}
