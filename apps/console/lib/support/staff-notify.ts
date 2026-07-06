// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff-side support notifications — the machinery that runs when a support AGENT
// replies to or is assigned a case. The staff write-path itself (Slack two-way ingest /
// staff console, P2) doesn't exist yet; these helpers are built now so it's a one-line
// call to fire the customer-facing email + org-observability alert the moment it lands.
//
// Unlike the customer actions (app/server/actions/support.ts), the staff path has no
// user session, so it reads through getServiceDb() (RLS-bypass; the staff ingest is the
// trust boundary) and resolves the case URL from the org's slug rather than the session.

import { eq } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getAuthConfig } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { organization, supportCases } from "@/lib/db/schema";
import {
	sendCaseAssignedEmail,
	sendCaseClosedEmail,
	sendCaseReopenedEmail,
	sendCaseRepliedEmail,
	sendCaseResolvedEmail,
	wantsEmail,
} from "@/lib/email/support-email";
import { globalHref, PERSONAL_ORG_SLUG } from "@/lib/routing";

/** `CASE-000123` display form of a case number. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/**
 * Absolute case deep link resolved WITHOUT a session — for the staff/service-role path.
 * Reads the org's slug via the service DB; a personal org (no slug row) falls back to `~`,
 * which the `[org]` layout maps to personal scope.
 */
export async function resolveCaseUrlForOrg(
	caseId: string,
	orgId: string,
): Promise<string> {
	const base = getAuthConfig().baseURL?.replace(/\/$/, "") ?? "";
	const [org] = await getServiceDb()
		.select({ slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const slug = org?.slug ?? PERSONAL_ORG_SLUG;
	return `${base}${globalHref(slug, `support/cases/${caseId}`)}`;
}

/** The case fields the staff notifiers need, loaded via the service DB. */
async function loadCase(caseId: string) {
	const [row] = await getServiceDb()
		.select({
			case_number: supportCases.case_number,
			subject: supportCases.subject,
			contact: supportCases.contact,
			org_id: supportCases.org_id,
			user_id: supportCases.user_id,
		})
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	return row;
}

/**
 * Notifies the customer that a support agent replied on their case (Layer A email,
 * respecting the channel/CC prefs) and emits the org-observability `replied` event
 * (Layer B). Best-effort — never throws into the staff write-path.
 */
export async function notifyStaffReply(
	caseId: string,
	args: { author: string; snippet: string },
): Promise<void> {
	try {
		const row = await loadCase(caseId);
		if (!row) return;
		const orgId = row.org_id ?? row.user_id;
		const url = await resolveCaseUrlForOrg(caseId, orgId);
		if (wantsEmail(row.contact)) {
			await sendCaseRepliedEmail(row.contact.notifyEmail, {
				caseNumber: row.case_number,
				author: args.author,
				snippet: args.snippet.slice(0, 500),
				url,
				audience: "customer",
				cc: row.contact.ccEmails,
			});
		}
		emitAlertEventSafe(orgId, "system.support.case.replied", {
			title: `New reply on support case ${caseLabel(row.case_number)}`,
			summary: row.subject,
			severity: "info",
			resource_type: "support_case",
			resource_id: caseId,
			link: url,
		});
	} catch (err) {
		console.warn(`[support] staff-reply notify failed (${caseId}):`, err);
	}
}

/**
 * Notifies the customer that an agent picked up their case (Layer A email) and emits the
 * `assigned` event (Layer B). Best-effort.
 */
export async function notifyAssigned(
	caseId: string,
	args: { agentName?: string },
): Promise<void> {
	try {
		const row = await loadCase(caseId);
		if (!row) return;
		const orgId = row.org_id ?? row.user_id;
		const url = await resolveCaseUrlForOrg(caseId, orgId);
		if (wantsEmail(row.contact)) {
			await sendCaseAssignedEmail(row.contact.notifyEmail, {
				caseNumber: row.case_number,
				agentName: args.agentName,
				url,
				cc: row.contact.ccEmails,
			});
		}
		emitAlertEventSafe(orgId, "system.support.case.assigned", {
			title: `Support case ${caseLabel(row.case_number)} assigned`,
			summary: args.agentName ? `Assigned to ${args.agentName}` : row.subject,
			severity: "info",
			resource_type: "support_case",
			resource_id: caseId,
			link: url,
		});
	} catch (err) {
		console.warn(`[support] assigned notify failed (${caseId}):`, err);
	}
}

/**
 * Notifies the customer that staff changed their case's lifecycle status (resolved /
 * reopened / closed) — the Layer A email + the Layer B org event, mirroring the
 * customer-driven transitions in support.ts. Best-effort.
 */
export async function notifyStatusChange(
	caseId: string,
	kind: "resolved" | "reopened" | "closed",
): Promise<void> {
	try {
		const row = await loadCase(caseId);
		if (!row) return;
		const orgId = row.org_id ?? row.user_id;
		const url = await resolveCaseUrlForOrg(caseId, orgId);
		if (wantsEmail(row.contact)) {
			const args = {
				caseNumber: row.case_number,
				url,
				cc: row.contact.ccEmails,
			};
			const to = row.contact.notifyEmail;
			if (kind === "resolved") await sendCaseResolvedEmail(to, args);
			else if (kind === "reopened") await sendCaseReopenedEmail(to, args);
			else await sendCaseClosedEmail(to, args);
		}
		emitAlertEventSafe(orgId, `system.support.case.${kind}`, {
			title: `Support case ${caseLabel(row.case_number)} ${kind}`,
			summary: row.subject,
			severity: kind === "reopened" ? "warning" : "info",
			resource_type: "support_case",
			resource_id: caseId,
			link: url,
		});
	} catch (err) {
		console.warn(`[support] status-change notify failed (${caseId}):`, err);
	}
}
