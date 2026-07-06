// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-case pg enums + their TS unions. Shared by the console (customer support) and
// the admin app (staff). The console re-exports these from its schema/enums.ts so
// every existing `@/lib/db/schema/enums` import site keeps working.

import { pgEnum } from "drizzle-orm/pg-core";

// Support cases (dataroom/spec: support experience). A tenant-owned help-desk case
// system: submit → track in "My cases" → converse in a per-case thread. Cases are
// org-scoped like agent_threads; staff answer via an out-of-band surface (Slack) so
// our DB stays the source of truth.
export const supportCaseType = pgEnum("support_case_type", [
	"technical",
	"billing",
	"account",
	"general",
	"abuse",
]);
// Service / area the case is about (AWS-style), used for routing + triage.
export const supportCaseCategory = pgEnum("support_case_category", [
	"clusters",
	"jobs",
	"runners",
	"connectors",
	"networking",
	"billing_invoices",
	"account_access",
	"quotas_limits",
	"api_cli",
	"agent_ai",
	"other",
]);
// low = general guidance … urgent = production impact. Drives expected-response copy.
export const supportCaseSeverity = pgEnum("support_case_severity", [
	"low",
	"normal",
	"high",
	"urgent",
]);
export const supportCaseStatus = pgEnum("support_case_status", [
	"open", // submitted, awaiting first staff response
	"pending_support", // waiting on Alethia
	"pending_customer", // waiting on the customer's reply
	"resolved", // staff (or customer) marked resolved
	"closed", // closed (by customer or auto after resolved)
]);
// Who authored a thread message. `ai` = the elench support assistant autoreply;
// `system` = status-change / automated notes.
export const supportAuthorType = pgEnum("support_author_type", [
	"customer",
	"staff",
	"system",
	"ai",
]);
// Abuse taxonomy (only when support_case_type = 'abuse').
export const supportAbuseCategory = pgEnum("support_abuse_category", [
	"phishing",
	"malware",
	"spam",
	"copyright",
	"csam",
	"other",
]);

export type SupportCaseType = (typeof supportCaseType.enumValues)[number];
export type SupportCaseCategory =
	(typeof supportCaseCategory.enumValues)[number];
export type SupportCaseSeverity =
	(typeof supportCaseSeverity.enumValues)[number];
export type SupportCaseStatus = (typeof supportCaseStatus.enumValues)[number];
export type SupportAuthorType = (typeof supportAuthorType.enumValues)[number];
export type SupportAbuseCategory =
	(typeof supportAbuseCategory.enumValues)[number];
