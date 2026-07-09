// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Provider-agnostic tracking entry point. Instrumentation calls track()/identify() and never names a
// vendor; this fans out to whichever providers are live (PostHog, and/or Umami's global + OpenReplay's
// tracker). It is SSR-safe and defensively wrapped — analytics must NEVER throw into the app.

import type { AnalyticsEvent } from "./events";

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

/** The subset of the Umami browser global we use (injected by its /script.js). */
interface UmamiGlobal {
	track: (event: string, data?: AnalyticsProps) => void;
	identify?: (id: string, data?: AnalyticsProps) => void;
}

/** The subset of the OpenReplay tracker we use (set on window by AnalyticsProvider). */
interface OpenReplayLike {
	event: (name: string, payload?: Record<string, unknown>) => void;
	setUserID: (id: string) => void;
}

/** The subset of the PostHog browser SDK we use (set on window by AnalyticsProvider). */
interface PostHogLike {
	capture: (event: string, props?: Record<string, unknown>) => void;
	identify: (id: string, props?: Record<string, unknown>) => void;
	group: (type: string, key: string, props?: Record<string, unknown>) => void;
	captureException: (error: unknown, props?: Record<string, unknown>) => void;
	isFeatureEnabled: (key: string) => boolean | undefined;
	getFeatureFlag: (key: string) => boolean | string | undefined;
	onFeatureFlags: (cb: (flags: string[]) => void) => () => void;
	reset?: () => void;
}

declare global {
	interface Window {
		umami?: UmamiGlobal;
		__openreplay?: OpenReplayLike;
		__posthog?: PostHogLike;
	}
}

/** Emit an analytics event to every enabled provider. No-ops on the server or when no provider is set. */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
	if (typeof window === "undefined") return;
	try {
		window.__posthog?.capture(event, props);
	} catch {
		/* analytics must never break the app */
	}
	try {
		window.umami?.track(event, props);
	} catch {
		/* noop */
	}
	try {
		window.__openreplay?.event(event, props ?? {});
	} catch {
		/* noop */
	}
}

/** Associate the current session with a user id (call after sign-in). */
export function identify(userId: string, traits?: AnalyticsProps): void {
	if (typeof window === "undefined") return;
	try {
		window.__posthog?.identify(userId, traits);
	} catch {
		/* noop */
	}
	try {
		window.umami?.identify?.(userId, traits);
	} catch {
		/* noop */
	}
	try {
		window.__openreplay?.setUserID(userId);
	} catch {
		/* noop */
	}
}

/**
 * Associate subsequent events with an organization group so PostHog can segment funnels/retention by
 * org (and plan). PostHog-only — Umami/OpenReplay have no group concept, so they no-op. Call after the
 * active org is known (and again on org switch).
 */
export function group(orgId: string, props?: AnalyticsProps): void {
	if (typeof window === "undefined") return;
	try {
		window.__posthog?.group("organization", orgId, props);
	} catch {
		/* noop */
	}
}

/** Clear the identified person + group on sign-out so the next session starts anonymous. */
export function reset(): void {
	if (typeof window === "undefined") return;
	try {
		window.__posthog?.reset?.();
	} catch {
		/* noop */
	}
}

/**
 * Report a caught error to PostHog Error tracking (the current session replay is attached). PostHog
 * auto-captures UNhandled errors via `capture_exceptions`; call this for errors you catch yourself —
 * e.g. from a React error boundary. PostHog-only; no-ops with no provider.
 */
export function captureException(error: unknown, props?: AnalyticsProps): void {
	if (typeof window === "undefined") return;
	try {
		window.__posthog?.captureException(error, props);
	} catch {
		/* noop */
	}
}
