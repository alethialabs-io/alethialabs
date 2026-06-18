// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { emailOTPClient, genericOAuthClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "next-runtime-env";

/**
 * Browser-side Better Auth client. Exposes sign-in (social + email OTP), account
 * linking, session hooks, and sign-out. Plugins must mirror the server instance.
 */
export const authClient = createAuthClient({
	baseURL: env("NEXT_PUBLIC_APP_URL") || undefined,
	plugins: [emailOTPClient(), genericOAuthClient()],
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
