// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed JSONB shapes for the support-case schema's `.$type<>()` columns. Shared by the
// console and the admin app; the console re-exports them from types/jsonb.types.ts.

/** Where + how the customer wants to be reached about a support case. */
export interface SupportContactPrefs {
	/** Address that receives the ack + reply notifications (prefilled to the session email). */
	notifyEmail: string;
	/** Extra addresses to CC on notifications. */
	ccEmails?: string[];
	/** Preferred notification channel. `in_app` = console toasts only (no email). */
	channel: "email" | "in_app";
	/** BCP-47 tag, for future localized replies. */
	locale?: string;
}

/**
 * Snapshot of what the customer had in view when opening the case — deep links + the
 * resource ids they selected. Stored as a snapshot (no FKs) so a case survives the
 * teardown of the project/cluster/job it references.
 */
export interface SupportCaseContext {
	projectId?: string;
	clusterId?: string;
	jobId?: string;
	connectorId?: string;
	region?: string;
	/** Deep link back to the surface the case was opened from. */
	consoleUrl?: string;
	userAgent?: string;
}

/** Abuse-specific fields; present only when support_cases.type = 'abuse'. */
export interface SupportAbuseDetails {
	/** URL / identifier of the abusive resource being reported. */
	reportedResource?: string;
	/** A supportAbuseCategory value. */
	abuseCategory?: string;
	/** Whether the reporter is a third party or the affected party. */
	reporterRelationship?: "third_party" | "affected_party";
}
