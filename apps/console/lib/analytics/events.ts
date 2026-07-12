// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The analytics event catalog — one source of truth so Umami funnels/journeys and OpenReplay tags
// stay consistent. Event names mirror the customer journeys mapped in docs/qa/flow-catalog.md, so a
// funnel like signup → onboarding → org → connector → project → deploy reads directly off these.

export const ANALYTICS_EVENTS = [
	// ── Acquisition ──
	"signup_email_requested",
	"signup_otp_verified",
	"login_succeeded",
	// ── Onboarding / activation ──
	"onboarding_plan_selected",
	"org_created",
	"connector_connect_started",
	"connector_connected",
	"project_created",
	"deploy_queued",
	/** Terminal DEPLOY-job outcomes — the actual value moment (vs. `deploy_queued` = intent). */
	"deploy_succeeded",
	"deploy_failed",
	"member_invited",
	"support_case_opened",
	// ── Revenue (upgrade_started/trial_started are client; the rest fire server-side from the
	//    Stripe webhook via lib/analytics/server.ts) ──
	"upgrade_started",
	"trial_started",
	"subscription_active",
	"subscription_canceled",
	"payment_failed",
	/** Core Web Vitals sample (LCP/CLS/INP/FCP/TTFB) — see components/analytics/web-vitals.tsx. */
	"web_vitals",
	// ── Elench AI chat surface (client-instrumented; spend/tokens stay server-side) ──
	"elench_chat_opened",
	"elench_message_sent",
	"elench_suggestion_clicked",
	"elench_try_now_used",
	"elench_tool_approved",
	"elench_tool_denied",
	"elench_thread_created",
	"elench_dashboard_built",
	"elench_grid_opened",
	"elench_error",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
