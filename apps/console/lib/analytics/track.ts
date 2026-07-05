// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Provider-agnostic tracking entry point. Instrumentation calls track()/identify() and never names a
// vendor; this fans out to whichever providers are live (Umami's global + OpenReplay's tracker). It is
// SSR-safe and defensively wrapped — analytics must NEVER throw into the app.

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

declare global {
	interface Window {
		umami?: UmamiGlobal;
		__openreplay?: OpenReplayLike;
	}
}

/** Emit an analytics event to every enabled provider. No-ops on the server or when no provider is set. */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
	if (typeof window === "undefined") return;
	try {
		window.umami?.track(event, props);
	} catch {
		/* analytics must never break the app */
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
