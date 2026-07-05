// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Mounts the self-hosted, open-source analytics providers — the Umami tracker script (product
// analytics + funnels + Core Web Vitals) and the OpenReplay session-replay tracker — plus the
// Web-Vitals reporter. Everything is gated on runtime env (see lib/analytics/config.ts): with nothing
// configured this renders only its children, so the open-source build ships zero telemetry.

import Script from "next/script";
import { useEffect } from "react";
import type React from "react";
import { analyticsConfig } from "@/lib/analytics/config";
import { WebVitals } from "@/components/analytics/web-vitals";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	const cfg = analyticsConfig();

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
				window.__openreplay = tracker as unknown as Window["__openreplay"];
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
			{cfg.umami || cfg.openreplay ? <WebVitals /> : null}
			{children}
		</>
	);
}
