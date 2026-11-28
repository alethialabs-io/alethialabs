// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff identity on a call from the staff app (apps/admin) to a console platform route.
//
// The staff app forwards the staff member's Cloudflare Access application token in
// STAFF_ACCESS_TOKEN_HEADER. This module verifies it with the SAME verifier the staff app uses
// (@repo/platform/access-jwt) and the same settings — CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, the
// staff app's Access application — and answers the verified `email` claim. The platform provisioning
// bearer still says the call comes from the staff app; this says which staff member is acting.
//
// The rule is the staff app's, unchanged: in production a missing setting, a missing token or a token
// that does not verify means no identity. Outside production, with Access unconfigured or no token
// sent, SUPPORT_ADMIN_DEV_EMAIL stands in, as it does in apps/admin/lib/auth/staff.ts.

import { resolveStaffEmail, STAFF_ACCESS_TOKEN_HEADER } from "@repo/platform/access-jwt";

/**
 * The lowercased email of the staff member a platform call is made for, from the forwarded and
 * verified Access token; null when no identity can be established. Never throws.
 */
export async function verifiedStaffEmail(req: Request): Promise<string | null> {
	return resolveStaffEmail({
		token: req.headers.get(STAFF_ACCESS_TOKEN_HEADER),
		teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
		audience: process.env.CF_ACCESS_AUD,
		devEmail: process.env.SUPPORT_ADMIN_DEV_EMAIL,
		production: process.env.NODE_ENV === "production",
	});
}
