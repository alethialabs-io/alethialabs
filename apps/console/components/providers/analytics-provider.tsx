// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Mounts the enabled analytics providers after the matching consent choice:
//  - PostHog (prod suite): product analytics + optional session replay + web-vitals/performance + errors,
//  - Umami (OSS self-host): product analytics + funnels, with the custom Web-Vitals reporter,
//  - OpenReplay (OSS self-host): session replay.
// Consent defaults to denied. With nothing configured this renders only its children, so the open-source
// build ships zero telemetry.

import Script from "next/script";
import { useEffect } from "react";
import type React from "react";
import { useConsent } from "@repo/privacy/consent-provider";
import { analyticsConfig } from "@/lib/analytics/config";
import { WebVitals } from "@/components/analytics/web-vitals";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	const cfg = analyticsConfig();
	const { consent } = useConsent();
	const analyticsAllowed = consent?.analytics === true;
	const replayAllowed = consent?.replay === true;

	// PostHog — the all-in-one suite. Dynamically imported so its bundle only ships when enabled.
	// Captures pageviews + autocapture and Core Web Vitals only after analytics consent. Session replay
	// additionally requires replay consent; all text and inputs are masked. Sampling + billing limits are
	// set in the PostHog project settings.
	useEffect(() => {
		if (!cfg.posthog || !analyticsAllowed) return;
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
					// session replay attached). Replaces a separate Sentry.
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
					disable_session_recording: !replayAllowed,
					session_recording: {
						maskAllInputs: true,
						maskTextSelector: "*",
					},
				});
				posthog.opt_in_capturing();
				// Tag every event (incl. $exception) with the deploy release, so a captured stack
				// symbolicates against the source maps uploaded for that same build (see next.config.ts).
				if (cfg.posthog!.release) posthog.register({ release: cfg.posthog!.release });
				if (replayAllowed) posthog.startSessionRecording();
				window.__posthog = posthog;
				stopPosthog = () => {
					posthog.stopSessionRecording();
					posthog.reset();
					posthog.opt_out_capturing();
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
		replayAllowed,
		cfg.posthog?.key,
		cfg.posthog?.host,
		cfg.posthog?.release,
	]);

	// OpenReplay session replay — dynamically imported so its bundle only ships when enabled. Inputs
	// are obscured by default; sensitive subtrees (billing, OTP) add data-openreplay-obscured.
	useEffect(() => {
		if (!cfg.openreplay || !replayAllowed) return;
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
	}, [replayAllowed, cfg.openreplay?.projectKey, cfg.openreplay?.ingest]);

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
			    for the OSS Umami/OpenReplay path — skip it when PostHog is active to avoid double counts. */}
			{analyticsAllowed && (cfg.umami || cfg.openreplay) && !cfg.posthog ? (
				<WebVitals />
			) : null}
			{children}
		</>
	);
}
