// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Core Web Vitals reporter. Uses Next's built-in useReportWebVitals (no extra dependency — Next
// measures LCP/CLS/INP/FCP/TTFB natively) and forwards each sample to the analytics layer as a
// `web_vitals` event, tagged with the route so Umami can chart page performance per surface.

import { useReportWebVitals } from "next/web-vitals";
import { track } from "@/lib/analytics/track";

/** Renders nothing; subscribes to Web Vitals and forwards them to the analytics providers. */
export function WebVitals() {
	useReportWebVitals((metric) => {
		track("web_vitals", {
			metric: metric.name, // LCP | CLS | INP | FCP | TTFB
			// CLS is a unitless score (keep 3 decimals); the rest are milliseconds.
			value: metric.name === "CLS" ? Math.round(metric.value * 1000) / 1000 : Math.round(metric.value),
			rating: metric.rating, // good | needs-improvement | poor
			route: typeof window !== "undefined" ? window.location.pathname : "",
			navigationType: metric.navigationType,
		});
	});
	return null;
}
