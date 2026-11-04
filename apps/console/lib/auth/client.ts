// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "next-runtime-env";
import type { SessionUserLike } from "@/lib/auth/viewer";
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

/** The part of the live session `useViewer()` reads. */
export interface LiveSessionRead {
	data: { user: SessionUserLike } | null;
	isPending: boolean;
	error: unknown;
	/**
	 * True once the live session has answered at least once in this page — successfully, or with a
	 * 401 (nobody signed in). From then on
	 * `data` is that answer — better-auth keeps the last good data through a later failed or
	 * in-flight fetch — so it stays the viewer even while `error` or `isPending` is set.
	 */
	settled: boolean;
}

/** A nanostores atom, as far as this module uses one. */
interface AtomLike {
	get(): unknown;
	listen(listener: () => void): () => void;
}

/** Whether `value` has the two atom methods this module calls. */
function isAtomLike(value: unknown): value is AtomLike {
	return (
		typeof value === "object" &&
		value !== null &&
		"get" in value &&
		typeof value.get === "function" &&
		"listen" in value &&
		typeof value.listen === "function"
	);
}

/** The atom an unreachable store answers with: never changes, never fetches. */
const INERT_ATOM: AtomLike = { get: () => null, listen: () => () => {} };

/**
 * Whether better-auth's store still has the two atoms this module follows, as atoms. If a
 * better-auth upgrade renamed them, `atom()` would answer the inert stand-in and the viewer would
 * silently stop following session changes — `tests/lib/auth/live-session-atoms.test.ts` asserts
 * this against the real client so that cannot happen quietly.
 */
export function sessionAtomsReachable(): boolean {
	return atom("session") !== INERT_ATOM && atom("$sessionSignal") !== INERT_ATOM;
}

/**
 * THE TYPE BOUNDARY. better-auth types its store's atoms as `WritableAtom<any>`, so nothing about
 * them is checked at compile time. They enter this module as `unknown`, are narrowed to `AtomLike`
 * here, and every VALUE they hold is parsed by `readLiveSession` below — no `any` leaves this file.
 */
function atom(name: "session" | "$sessionSignal"): AtomLike {
	const value: unknown = authClient.$store.atoms[name];
	return isAtomLike(value) ? value : INERT_ATOM;
}

/** A user the client session carries, or null when `value` is not one. */
function readUser(value: unknown): SessionUserLike | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("id" in value) || typeof value.id !== "string") return null;
	if (!("email" in value) || typeof value.email !== "string") return null;
	const name = "name" in value && typeof value.name === "string" ? value.name : "";
	const image = "image" in value && typeof value.image === "string" ? value.image : null;
	const raw = "createdAt" in value ? value.createdAt : null;
	const createdAt = raw instanceof Date ? raw : new Date(typeof raw === "string" ? raw : 0);
	return { id: value.id, name, email: value.email, image, createdAt };
}

/** The pending answer: before the first fetch, and for a value that is not a session state. */
const PENDING: LiveSessionRead = { data: null, isPending: true, error: null, settled: false };

/** Whether the live session has answered successfully at least once (see `LiveSessionRead`). */
let settledOnce = false;

/** better-auth's session-atom value, parsed into what `useViewer()` reads. */
function readLiveSession(value: unknown): LiveSessionRead {
	if (typeof value !== "object" || value === null) return PENDING;
	const isPending = "isPending" in value && value.isPending === true;
	const error = "error" in value ? value.error : null;
	const data = "data" in value ? value.data : null;
	const user = typeof data === "object" && data !== null && "user" in data ? readUser(data.user) : null;
	// A 401 is an answer too — nobody is signed in — so it settles like a successful one. better-auth
	// keeps `data` null after it, so a later failed fetch still reads as signed out.
	const unauthorized =
		typeof error === "object" && error !== null && "status" in error && error.status === 401;
	if (!isPending && ((error ?? null) === null || unauthorized)) settledOnce = true;
	return { data: user ? { user } : null, isPending, error: error ?? null, settled: settledOnce };
}

const sessionAtom = atom("session");
const sessionSignal = atom("$sessionSignal");

// `get()` must answer the SAME object while the atom's value is unchanged (it is a
// `useSyncExternalStore` snapshot), so the parse is memoised on the raw value's identity.
let lastRaw: unknown = Symbol("never");
let lastRead: LiveSessionRead = PENDING;

/** How many `useViewer()` hooks are following the live session right now. */
let followers = 0;

/**
 * better-auth's cross-tab message: one `localStorage` key, rewritten on every session change
 * (`better-auth/dist/client/broadcast-channel.mjs`). Other tabs see it as a `storage` event.
 */
const BROADCAST_KEY = "better-auth.message";

/** Seconds of quiet a focus or visibility check waits for — better-auth's own focus rate limit. */
const FOCUS_RATE_LIMIT_MS = 5_000;

/**
 * Tells other tabs the session changed, in better-auth's own format. better-auth only broadcasts from
 * a MOUNTED session atom, and a seeded viewer does not mount it until it has to (see `liveSession`),
 * so a sign-out in this tab would otherwise reach no other tab.
 */
function broadcastSessionChange(): void {
	try {
		localStorage.setItem(
			BROADCAST_KEY,
			JSON.stringify({
				event: "session",
				data: { trigger: "session-changed" },
				clientId: Math.random().toString(36).slice(2, 9),
				timestamp: Math.floor(Date.now() / 1000),
			}),
		);
	} catch {
		// Storage blocked (private mode, a sandboxed frame): nothing to tell, nothing to break.
	}
}

/**
 * The live session, for `useViewer()` alone (#6114).
 *
 * Subscribing mounts better-auth's session atom, and mounting is what makes better-auth fetch
 * `/get-session` — and what wires its own focus refetch and cross-tab sync. A page whose layout
 * already read the session (the private layout's `ViewerProvider` seed) does not need that fetch on
 * load, so a seeded viewer subscribes only once the session may have CHANGED, which
 * `onPossibleChange` reports:
 *   · a client auth call in this tab (sign-out, profile edit — better-auth's session signal), which
 *     is also broadcast to other tabs here, since the unmounted atom would not;
 *   · another tab's session change (better-auth's broadcast);
 *   · this tab becoming visible or focused again (rate-limited).
 * From then on the atom is mounted and better-auth follows every later change itself.
 */
export const liveSession = {
	/** Subscribes to the live session; the FIRST subscriber triggers better-auth's session fetch. */
	subscribe(listener: () => void): () => void {
		followers += 1;
		const stop = sessionAtom.listen(listener);
		return () => {
			followers -= 1;
			stop();
		};
	},
	/** The live session now. Reading it also mounts the atom, so call it only while subscribed. */
	get(): LiveSessionRead {
		const raw = sessionAtom.get();
		if (raw !== lastRaw) {
			lastRaw = raw;
			lastRead = readLiveSession(raw);
		}
		return lastRead;
	},
	/**
	 * Notifies when the session may have changed (see above). Does not mount the session atom.
	 * Browser-only; returns the unsubscribe.
	 */
	onPossibleChange(listener: () => void): () => void {
		const stopSignal = sessionSignal.listen(() => {
			// Nobody had the atom mounted, so better-auth's own broadcast was a no-op: send it.
			if (followers === 0) broadcastSessionChange();
			listener();
		});
		const onStorage = (event: StorageEvent) => {
			if (event.key === BROADCAST_KEY) listener();
		};
		let lastCheck = Date.now();
		const onFocus = () => {
			if (document.visibilityState !== "visible") return;
			if (Date.now() - lastCheck < FOCUS_RATE_LIMIT_MS) return;
			lastCheck = Date.now();
			listener();
		};
		window.addEventListener("storage", onStorage);
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			stopSignal();
			window.removeEventListener("storage", onStorage);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	},
};
