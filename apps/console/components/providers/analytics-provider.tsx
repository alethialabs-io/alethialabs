// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Mounts the enabled analytics providers, all gated on runtime env (see lib/analytics/config.ts):
//  - PostHog (prod suite): product analytics + session replay + web-vitals/performance + errors,
//  - Umami (OSS self-host): product analytics + funnels, with the custom Web-Vitals reporter,
//  - OpenReplay (OSS self-host): session replay.
// With nothing configured this renders only its children, so the open-source build ships zero telemetry.

import Script from "next/script";
import { useEffect } from "react";
import type React from "react";
import { analyticsConfig } from "@/lib/analytics/config";
import { WebVitals } from "@/components/analytics/web-vitals";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	const cfg = analyticsConfig();

	// PostHog — the all-in-one suite. Dynamically imported so its bundle only ships when enabled.
	// Captures pageviews + autocapture (product analytics), session replay (inputs masked; add
	// data-ph-mask to obscure sensitive text), and Core Web Vitals (capture_performance) → PostHog's
	// Web Vitals dashboard. Replay sampling + billing limit are set in the PostHog project settings.
	useEffect(() => {
		if (!cfg.posthog) return;
		let cancelled = false;
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
					capture_pageview: true,
					capture_pageleave: true,
					autocapture: true,
					capture_performance: { web_vitals: true },
					// Surface unhandled errors + promise rejections in PostHog Error tracking (with the
					// session replay attached). Replaces a separate Sentry.
					capture_exceptions: true,
					session_recording: { maskAllInputs: true, maskTextSelector: "[data-ph-mask]" },
				});
				window.__posthog = posthog;
			} catch {
				/* analytics is best-effort — never break the app */
			}
		})();
		return () => {
			cancelled = true;
			try {
				window.__posthog?.reset?.();
			} catch {
				/* noop */
			}
			window.__posthog = undefined;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cfg.posthog?.key, cfg.posthog?.host]);

	// OpenReplay session replay — dynamically imported so its bundle only ships when enabled. Inputs
	// are obscured by default; sensitive subtrees (billing, OTP) add data-openreplay-obscured.
	useEffect(() => {
		if (!cfg.openreplay) return;
		let cancelled = false;
		let stop: (() => void) | null = null;
		void (async () => {
			try {
				const Tracker = (await import("@openreplay/tracker")).default;
				const tracker = new Tracker({
					projectKey: cfg.openreplay!.projectKey,
					ingestPoint: cfg.openreplay!.ingest,
					obscureInputEmails: true,
					obscureInputNumbers: true,
					obscureTextEmails: true,
				});
				if (cancelled) return;
				tracker.start();
				window.__openreplay = tracker;
				stop = () => tracker.stop();
			} catch {
				/* session replay is best-effort — never break the app */
			}
		})();
		return () => {
			cancelled = true;
			try {
				stop?.();
			} catch {
				/* noop */
			}
			window.__openreplay = undefined;
		};
		// Depend on the primitive key/ingest, not the cfg object (recreated each render → would re-run).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cfg.openreplay?.projectKey, cfg.openreplay?.ingest]);

	return (
		<>
			{cfg.umami ? (
				<Script
					src={`${cfg.umami.host}/script.js`}
					data-website-id={cfg.umami.websiteId}
					strategy="afterInteractive"
				/>
			) : null}
			{/* PostHog captures Web Vitals natively (capture_performance); the custom reporter is only
			    for the OSS Umami/OpenReplay path — skip it when PostHog is active to avoid double counts. */}
			{(cfg.umami || cfg.openreplay) && !cfg.posthog ? <WebVitals /> : null}
			{children}
		</>
	);
}
