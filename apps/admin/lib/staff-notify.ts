// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff-side support notifications — the customer-facing side effects that run when a
// support AGENT replies to, assigns, or transitions a case from the admin
// dashboard. The staff path has no user session, so it reads through getServiceDb()
// (RLS-bypass; the allowlist behind Cloudflare Access is the trust boundary) and resolves
// the case's customer-facing deep link from the org's slug. Unlike the console's
// staff-notify this fires EMAIL ONLY — there is no alerts/org-observability subsystem in
// this app, so all emitAlertEventSafe (Layer-B) calls are intentionally dropped.

import { eq } from "drizzle-orm";
import { env } from "next-runtime-env";
import { supportCases } from "@repo/support/schema";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db-schema";
import {
	sendCaseAssignedEmail,
	sendCaseClosedEmail,
	sendCaseReopenedEmail,
	sendCaseResolvedEmail,
	sendStaffReplyEmail,
	wantsEmail,
} from "@/lib/email";

/**
 * The customer-facing deep link for a case, resolved WITHOUT a session (staff/service-role
 * path). The link points at the CONSOLE's case page — that's where the customer reads it —
 * so the base is `NEXT_PUBLIC_CONSOLE_URL` and the org segment is the org's slug (falling
 * back to `~`, which the console's `[org]` layout maps to the personal scope). Shape:
 * `{base}/{orgSlug}/~/support/cases/{caseId}`.
 */
export async function resolveCaseUrlForOrg(
	caseId: string,
	orgId: string,
): Promise<string> {
	const base = (env("NEXT_PUBLIC_CONSOLE_URL") || "").replace(/\/$/, "");
	const [org] = await getServiceDb()
		.select({ slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const slug = org?.slug ?? "~";
	return `${base}/${slug}/~/support/cases/${caseId}`;
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
 * Notifies the customer that a support agent replied on their case (respecting the
 * channel/CC prefs). Best-effort — never throws into the staff write-path.
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
			await sendStaffReplyEmail(row.contact.notifyEmail, {
				caseNumber: row.case_number,
				author: args.author,
				snippet: args.snippet.slice(0, 500),
				url,
				cc: row.contact.ccEmails,
			});
		}
	} catch (err) {
		console.warn("[support] staff-reply notify failed", { caseId }, err);
	}
}

/**
 * Notifies the customer that an agent picked up their case. Best-effort.
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
	} catch (err) {
		console.warn("[support] assigned notify failed", { caseId }, err);
	}
}

/**
 * Notifies the customer that staff changed their case's lifecycle status (resolved /
 * reopened / closed). Best-effort.
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
	} catch (err) {
		console.warn("[support] status-change notify failed", { caseId }, err);
	}
}
