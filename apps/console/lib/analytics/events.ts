// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The analytics event catalog — one source of truth so Umami funnels/journeys and OpenReplay tags
// stay consistent. Event names mirror the customer journeys mapped in docs/qa/flow-catalog.md, so a
// funnel like signup → onboarding → org → connector → project → deploy reads directly off these.

export const ANALYTICS_EVENTS = [
	"signup_email_requested",
	"signup_otp_verified",
	"onboarding_plan_selected",
	"org_created",
	"connector_connect_started",
	"connector_connected",
	"project_created",
	"deploy_queued",
	"member_invited",
	"upgrade_started",
	/** Core Web Vitals sample (LCP/CLS/INP/FCP/TTFB) — see components/analytics/web-vitals.tsx. */
	"web_vitals",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
