// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which self-hosted, open-source analytics providers are enabled, resolved from RUNTIME env (via
// next-runtime-env's env(), so a Docker image can be pointed at an analytics host at container start
// without a rebuild). Everything is optional: with nothing configured the analytics layer no-ops and
// the open-source / self-hosted-without-analytics build ships zero telemetry.

import { env } from "next-runtime-env";

export interface AnalyticsConfig {
	/** Umami tracker (product analytics + funnels + Core Web Vitals). Self-host / OSS option. */
	umami: { host: string; websiteId: string } | null;
	/**
	 * PostHog — the all-in-one suite (product analytics + web-vitals/performance + error tracking +
	 * funnels). What alethialabs.io runs in prod; a single project key, no infra. `host` defaults to
	 * PostHog Cloud EU.
	 *
	 * Session replay is NOT part of it. Consent v2 offers one optional choice and replay is not it,
	 * so `disable_session_recording` is pinned on in AnalyticsProvider and the OpenReplay seam that
	 * used to sit beside this one is gone (#2371).
	 */
	posthog: { key: string; host: string; release?: string } | null;
}

/** Resolves the enabled analytics providers from `NEXT_PUBLIC_*` runtime env. */
export function analyticsConfig(): AnalyticsConfig {
	const umamiHost = env("NEXT_PUBLIC_UMAMI_HOST");
	const umamiWebsiteId = env("NEXT_PUBLIC_UMAMI_WEBSITE_ID");
	const phKey = env("NEXT_PUBLIC_POSTHOG_KEY");
	const phHost = env("NEXT_PUBLIC_POSTHOG_HOST");

	return {
		umami:
			umamiHost && umamiWebsiteId
				? { host: umamiHost.replace(/\/$/, ""), websiteId: umamiWebsiteId }
				: null,
		posthog: phKey
			? {
					key: phKey,
					host: (phHost || "https://eu.i.posthog.com").replace(/\/$/, ""),
					// The deploy SHA (inlined at build) — tags every error with the release the uploaded
					// source maps are keyed to, so a captured stack symbolicates to the exact build.
					release: env("NEXT_PUBLIC_APP_VERSION") || undefined,
				}
			: null,
	};
}
