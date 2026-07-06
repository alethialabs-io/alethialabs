// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation + display copy for the support-cases feature. drizzle-zod derives the
// case-submit contract from the supportCases schema (JSONB columns refined with their
// interface types); the message + label maps are hand-authored zod / display copy shared
// by the console (submit dialog + thread + actions) and the admin app.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
	supportAbuseCategory,
	type SupportAbuseCategory,
	type SupportCaseCategory,
	type SupportCaseSeverity,
	type SupportCaseStatus,
	type SupportCaseType,
} from "./enums";
import { supportCases } from "./schema";

/** Where + how the customer wants to be reached about a case (mirrors SupportContactPrefs). */
export const contactPrefsSchema = z.object({
	notifyEmail: z.string().email(),
	ccEmails: z.array(z.string().email()).max(5).optional(),
	channel: z.enum(["email", "in_app"]).default("email"),
	locale: z.string().optional(),
});

/** Deep-link + selected-resource snapshot captured when the case opened (mirrors SupportCaseContext). */
export const caseContextSchema = z.object({
	projectId: z.string().optional(),
	clusterId: z.string().optional(),
	jobId: z.string().optional(),
	connectorId: z.string().optional(),
	region: z.string().optional(),
	consoleUrl: z.string().optional(),
	userAgent: z.string().optional(),
});

/** Abuse-report specifics; present only when the case type is `abuse` (mirrors SupportAbuseDetails). */
export const abuseDetailsSchema = z
	.object({
		reportedResource: z.string().optional(),
		abuseCategory: z.enum(supportAbuseCategory.enumValues).optional(),
		reporterRelationship: z.enum(["third_party", "affected_party"]).optional(),
	})
	.optional();

/**
 * The new-case submit contract. Derived from the supportCases insert schema (so the
 * enum columns stay in sync) with the JSONB columns refined to their interfaces, then
 * narrowed to the customer-supplied fields plus a free-text `description` that becomes
 * the first thread message.
 */
export const submitCaseSchema = createInsertSchema(supportCases, {
	contact: contactPrefsSchema,
	context: caseContextSchema,
	abuse: abuseDetailsSchema,
})
	.pick({
		type: true,
		category: true,
		severity: true,
		subject: true,
		context: true,
		contact: true,
		abuse: true,
	})
	.extend({
		subject: z.string().min(3).max(200),
		description: z.string().min(10).max(10000),
		// Optional at the schema level: the submit form always supplies contact prefs,
		// but the Ask-AI escalation path omits them and `submitCase` defaults them to the
		// session user's email server-side.
		contact: contactPrefsSchema.optional(),
	});

/** A customer reply on an existing case. */
export const postMessageSchema = z.object({
	caseId: z.string().uuid(),
	body: z.string().min(1).max(10000),
});

/** Display labels for the case `type` select. */
export const SUPPORT_CASE_TYPE_LABELS: Record<SupportCaseType, string> = {
	technical: "Technical",
	billing: "Billing",
	account: "Account",
	general: "General",
	abuse: "Report abuse",
};

/** Display labels for the case `category` (service / area) select. */
export const SUPPORT_CATEGORY_LABELS: Record<SupportCaseCategory, string> = {
	clusters: "Clusters",
	jobs: "Jobs",
	runners: "Runners",
	connectors: "Connectors",
	networking: "Networking",
	billing_invoices: "Billing & invoices",
	account_access: "Account & access",
	quotas_limits: "Quotas & limits",
	api_cli: "API & CLI",
	agent_ai: "Agent & AI",
	other: "Other",
};

/** Display labels for the case `severity` select. */
export const SUPPORT_SEVERITY_LABELS: Record<SupportCaseSeverity, string> = {
	low: "Low",
	normal: "Normal",
	high: "High",
	urgent: "Urgent",
};

/** Display labels for the case `status` badge. */
export const SUPPORT_STATUS_LABELS: Record<SupportCaseStatus, string> = {
	open: "Open",
	pending_support: "Awaiting support",
	pending_customer: "Awaiting your reply",
	resolved: "Resolved",
	closed: "Closed",
};

/** One-line expected-response guidance shown beside each severity option. */
export const SUPPORT_SEVERITY_GUIDANCE: Record<SupportCaseSeverity, string> = {
	low: "General guidance — no rush",
	normal: "A question or issue that isn't blocking",
	high: "Important workflow impaired — needs attention soon",
	urgent: "Production system down — fastest response",
};

/** Display labels for the abuse-report category select. */
export const SUPPORT_ABUSE_CATEGORY_LABELS: Record<SupportAbuseCategory, string> =
	{
		phishing: "Phishing",
		malware: "Malware",
		spam: "Spam",
		copyright: "Copyright",
		csam: "CSAM",
		other: "Other",
	};

export type SubmitCaseInput = z.infer<typeof submitCaseSchema>;
export type PostMessageInput = z.infer<typeof postMessageSchema>;
export type ContactPrefsInput = z.infer<typeof contactPrefsSchema>;
