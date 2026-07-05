// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which self-hosted, open-source analytics providers are enabled, resolved from RUNTIME env (via
// next-runtime-env's env(), so a Docker image can be pointed at an analytics host at container start
// without a rebuild). Everything is optional: with nothing configured the analytics layer no-ops and
// the open-source / self-hosted-without-analytics build ships zero telemetry.

import { env } from "next-runtime-env";

export interface AnalyticsConfig {
	/** Umami tracker (product analytics + funnels + Core Web Vitals). */
	umami: { host: string; websiteId: string } | null;
	/** OpenReplay session replay (watch where users get stuck). */
	openreplay: { projectKey: string; ingest?: string } | null;
}

/** Resolves the enabled analytics providers from `NEXT_PUBLIC_*` runtime env. */
export function analyticsConfig(): AnalyticsConfig {
	const umamiHost = env("NEXT_PUBLIC_UMAMI_HOST");
	const umamiWebsiteId = env("NEXT_PUBLIC_UMAMI_WEBSITE_ID");
	const orProjectKey = env("NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY");
	const orIngest = env("NEXT_PUBLIC_OPENREPLAY_INGEST");

	return {
		umami:
			umamiHost && umamiWebsiteId
				? { host: umamiHost.replace(/\/$/, ""), websiteId: umamiWebsiteId }
				: null,
		openreplay: orProjectKey ? { projectKey: orProjectKey, ingest: orIngest || undefined } : null,
	};
}
