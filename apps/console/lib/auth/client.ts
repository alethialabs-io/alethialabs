// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "next-runtime-env";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";

/**
 * Browser-side Better Auth client. Exposes sign-in (social + email OTP), account
 * linking, session hooks, and sign-out. Plugins must mirror the server instance.
 *
 * There is no generic-OAuth client plugin any more. Better Auth 1.7 deleted
 * `genericOAuthClient()` and promoted generic providers (gitlab, bitbucket) to
 * first-class social providers, so `signIn.social()` / `linkSocial()` now drive
 * every provider and the old `signIn.oauth2()` / `oauth2.link()` pair is gone.
 * `organizationClient` (core better-auth) adds `authClient.organization.*` for the
 * settings UI, configured with our shared role set (owner/admin/operator/viewer) so
 * the org-plugin role types match the PDP. The calls only resolve when the server
 * organization plugin is loaded (Enterprise) — the UI gates them behind the
 * `organizations` entitlement.
 */
export const authClient = createAuthClient({
	baseURL: env("NEXT_PUBLIC_APP_URL") || undefined,
	plugins: [
		emailOTPClient(),
		organizationClient({ ac: orgAc, roles: orgRoles, teams: { enabled: true } }),
	],
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
