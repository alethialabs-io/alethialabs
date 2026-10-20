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

// `useSession` is deliberately NOT re-exported: render from `useViewer()`
// (components/providers/viewer-provider.tsx), the one hydration-safe reader of the session (#5382).
export const { signIn, signOut, signUp, getSession } = authClient;

/** The live client session as better-auth's session hook reports it. */
type LiveSessionState = ReturnType<typeof authClient.useSession>;

/** The part of the live session `useViewer()` reads. */
export interface LiveSessionRead {
	data: { user: NonNullable<LiveSessionState["data"]>["user"] } | null;
	isPending: boolean;
	error: unknown;
}

/** A nanostores atom, narrowed to the two calls made on it here. */
interface Listenable<T> {
	get(): T;
	listen(listener: () => void): () => void;
}

// better-auth types its store's atoms loosely (`WritableAtom<any>`); these two names give them the
// types its own hooks give them. `session` is the atom `useSession()` renders from; `$sessionSignal`
// flips after every client call that changes the session (update-user, sign-out, …).
const sessionAtom: Listenable<LiveSessionState> = authClient.$store.atoms.session;
const sessionSignal: Listenable<boolean> = authClient.$store.atoms.$sessionSignal;

/**
 * The live session, for `useViewer()` alone (#6114). Unlike `useSession()`, which subscribes the
 * moment it renders, this lets the viewer subscribe ONLY when it needs to: subscribing mounts the
 * atom, and mounting is what makes better-auth fetch `/get-session`. A page whose layout already read
 * the session (the private layout's `ViewerProvider` seed) therefore fetches nothing — until a
 * client call changes the session, which `onChange` reports.
 */
export const liveSession = {
	/** Subscribes to the live session; the FIRST subscriber triggers better-auth's session fetch. */
	subscribe: (listener: () => void): (() => void) => sessionAtom.listen(listener),
	/** The live session now. Reading it also mounts the atom, so call it only while subscribed. */
	get: (): LiveSessionRead => sessionAtom.get(),
	/** Notifies after a client auth call changed the session. Does not mount the session atom. */
	onChange: (listener: () => void): (() => void) => sessionSignal.listen(listener),
};
