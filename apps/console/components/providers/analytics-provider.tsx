// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Mounts the enabled analytics providers after affirmative analytics consent:
//  - PostHog (prod suite): product analytics + web-vitals/performance + errors,
//  - Umami (OSS self-host): product analytics + funnels, with the custom Web-Vitals reporter.
// Consent defaults to denied. With nothing configured this renders only its children, so the open-source
// build ships zero telemetry.
//
// SESSION REPLAY IS GONE (consent v2). Not defaulted off — removed: the product does not run replay,
// and an SDK path that could start it, behind a choice nobody is offered, is a capability the privacy
// disclosures would have to keep describing. The OpenReplay tracker mount went with it; the config
// seam stays for self-hosters, and nothing in this app reads it.
//
// `analyticsAllowed` comes from the consent context, NOT from `consent.analytics`. It folds in Global
// Privacy Control, which is an opt-out signal a stored "yes" must not override.

import Script from "next/script";
import { useEffect } from "react";
import type React from "react";
import { purgePostHogStorage } from "@repo/privacy/consent";
import { useConsent } from "@repo/privacy/consent-provider";
import { analyticsConfig } from "@/lib/analytics/config";
import { WebVitals } from "@/components/analytics/web-vitals";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	const cfg = analyticsConfig();
	const { analyticsAllowed } = useConsent();

	// PostHog — the all-in-one suite. Dynamically imported so its bundle only ships when enabled.
	// Captures pageviews + autocapture and Core Web Vitals only after analytics consent. Sampling +
	// billing limits are set in the PostHog project settings.
	//
	// The withdrawal branch runs BEFORE the guard: turning analytics off has to delete the identifiers
	// already on the device, and at that point `analyticsAllowed` is false, so a plain early return
	// would skip the cleanup entirely and leave them there forever.
	useEffect(() => {
		if (!analyticsAllowed) {
			purgePostHogStorage();
			return;
		}
		if (!cfg.posthog) return;
		let cancelled = false;
		let stopPosthog: (() => void) | null = null;
		void (async () => {
			try {
				const posthog = (await import("posthog-js")).default;
				if (cancelled) return;
				posthog.init(cfg.posthog!.key, {
					// When NEXT_PUBLIC_POSTHOG_HOST is the reverse-proxy path ("/ingest"), ingestion
					// rides our own origin (beats ad-blockers). ui_host keeps "view in PostHog" links
					// pointing at the real dashboard.
					api_host: cfg.posthog!.host,
					ui_host: "https://eu.posthog.com",
					person_profiles: "identified_only",
					opt_out_capturing_by_default: true,
					capture_pageview: true,
					capture_pageleave: true,
					autocapture: true,
					capture_performance: { web_vitals: true },
					// Surface unhandled errors + promise rejections in PostHog Error tracking (with the
					// stack trace attached). Replaces a separate Sentry.
					capture_exceptions: true,
					// Drop the benign "ResizeObserver loop completed with undelivered notifications" — a
					// browser quirk (not an app fault, never actionable) that otherwise floods Error
					// tracking. Real errors (incl. React #310) pass through untouched.
					before_send: (cr) => {
						if (cr?.event === "$exception") {
							const list: unknown = cr.properties?.$exception_list;
							if (
								Array.isArray(list) &&
								list.some(
									(ex) =>
										!!ex &&
										typeof ex === "object" &&
										"value" in ex &&
										typeof ex.value === "string" &&
										ex.value.includes("ResizeObserver loop"),
								)
							) {
								return null;
							}
						}
						return cr;
					},
					// Replay is not a choice this product offers, so the SDK is told never to start it.
					disable_session_recording: true,
				});
				posthog.opt_in_capturing();
				// Tag every event (incl. $exception) with the deploy release, so a captured stack
				// symbolicates against the source maps uploaded for that same build (see next.config.ts).
				if (cfg.posthog!.release) posthog.register({ release: cfg.posthog!.release });
				window.__posthog = posthog;
				stopPosthog = () => {
					posthog.reset();
					posthog.opt_out_capturing();
					// reset() clears the distinct id but leaves PostHog's cookie and localStorage
					// entries on the device. The requirement is that identifiers are DELETED, not
					// that capture stops, so the storage goes too.
					purgePostHogStorage();
				};
			} catch {
				/* analytics is best-effort — never break the app */
			}
		})();
		return () => {
			cancelled = true;
			try {
				stopPosthog?.();
			} catch {
				/* noop */
			}
			window.__posthog = undefined;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		analyticsAllowed,
		cfg.posthog?.key,
		cfg.posthog?.host,
		cfg.posthog?.release,
	]);

	return (
		<>
			{cfg.umami && analyticsAllowed ? (
				<Script
					src={`${cfg.umami.host}/script.js`}
					data-website-id={cfg.umami.websiteId}
					strategy="afterInteractive"
				/>
			) : null}
			{/* PostHog captures Web Vitals natively (capture_performance); the custom reporter is only
			    for the OSS Umami path — skip it when PostHog is active to avoid double counts. */}
			{analyticsAllowed && cfg.umami && !cfg.posthog ? <WebVitals /> : null}
			{children}
		</>
	);
}
