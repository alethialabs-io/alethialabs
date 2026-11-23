// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Who is told what in the Early Access grant flow (EA-3, #7325):
//
//   · a request is filed  → the maintainer, at once: an operator alert and an email to the legal
//                           inbox, naming the organization, the country and the VAT number, with the
//                           Art. 97a reminder;
//   · staff grant it      → the organization's owner, with the complimentary-terms email.
//
// `server-only`, with no "use server": an exported function of a "use server" file is a server
// action any client can call, and calling the first of these pages the maintainer.

import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { formatDate } from "@repo/format";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { aiPlanMeta, planMeta } from "@repo/plan-catalog";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getServiceDb } from "@/lib/db";
import { type EarlyAccessPlan, member, organization, user } from "@/lib/db/schema";
import { sendGuardedEmail } from "@/lib/email/guard";
import { log } from "@/lib/observability/log";
import {
	ART_97A_REMINDER,
	EarlyAccessRequestEmail,
	type EarlyAccessViesLine,
	subject as requestSubject,
} from "@/emails/early-access-request";
import {
	EarlyAccessGrantedEmail,
	subject as grantedSubject,
} from "@/emails/early-access-granted";

/** The display name of a plan a grant can be asked for ("Team", "AI Plus"). */
export function earlyAccessPlanName(plan: EarlyAccessPlan): string {
	return plan === "team" ? planMeta("team").name : aiPlanMeta(plan).name;
}

/** The facts of one filed request, as both notifications state them. */
export interface FiledRequest {
	requestId: string;
	organizationId: string;
	country: string;
	vatId: string;
	plan: EarlyAccessPlan;
	vies: EarlyAccessViesLine;
	viesName: string | null;
	requesterUserId: string;
	note: string | null;
}

/** The organization's name and slug, for the alert. */
async function orgFacts(orgId: string): Promise<{ name: string; slug: string | null }> {
	const [row] = await getServiceDb()
		.select({ name: organization.name, slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	return { name: row?.name ?? "an organization", slug: row?.slug ?? null };
}

/** A user's email, or null. */
async function userEmail(userId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return row?.email ?? null;
}

/**
 * Tells the maintainer a request was filed: an operator alert (`alertOperator`) and an email to the
 * legal inbox. Both carry the organization, the country, the VAT number and the Art. 97a reminder.
 * Never throws — the request is already stored, and a notification failure is logged, not surfaced
 * to the customer as a failed request. Resolves which of the two went out.
 */
export async function notifyEarlyAccessRequest(
	req: FiledRequest,
): Promise<{ alerted: boolean; emailed: boolean }> {
	let org: { name: string; slug: string | null } = { name: "an organization", slug: null };
	let requesterEmail: string | null = null;
	try {
		[org, requesterEmail] = await Promise.all([
			orgFacts(req.organizationId),
			userEmail(req.requesterUserId),
		]);
	} catch (err) {
		log.error("[early-access] could not read the request's organization", {
			org_id: req.organizationId,
			err,
		});
	}
	const planName = earlyAccessPlanName(req.plan);

	const alerted = await alertOperator({
		title: "Early Access grant requested",
		// The requester is the resource: the operator-alert subject types have no organization, and the
		// summary names the organization in full.
		subject: { type: "user", id: req.requesterUserId },
		summary: `Early Access request ${req.requestId}: ${org.name} (${req.country}) asks for ${planName}, VAT number ${req.vatId}, VIES ${req.vies}. ${ART_97A_REMINDER}`,
	});

	let emailed = false;
	try {
		await sendEmail({
			from: getEmailConfig().from.general,
			to: LEGAL_ENTITY.contactEmail,
			subject: requestSubject({ orgName: org.name, country: req.country, vatId: req.vatId }),
			react: EarlyAccessRequestEmail({
				requestId: req.requestId,
				orgName: org.name,
				orgSlug: org.slug,
				country: req.country,
				vatId: req.vatId,
				planName,
				vies: req.vies,
				viesName: req.viesName,
				requesterEmail,
				note: req.note,
			}),
			devLog: `early access request ${req.requestId} for org ${req.organizationId}`,
		});
		emailed = true;
	} catch (err) {
		log.error("[early-access] legal inbox email failed", { org_id: req.organizationId, err });
	}
	return { alerted, emailed };
}

/** The organization's earliest owner's email — the grant email's recipient. */
async function ownerEmail(orgId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
		.orderBy(asc(member.createdAt))
		.limit(1);
	return row?.email ?? null;
}

/**
 * Sends the complimentary-terms email for a granted request to the organization's owner. Resolves
 * false when the organization has no owner to write to. Throws on a send failure; the caller decides
 * whether that fails the grant (it does not: the plan is already set).
 */
export async function sendEarlyAccessGrantedEmail(input: {
	orgId: string;
	plan: EarlyAccessPlan;
	periodEnd: Date | null;
}): Promise<boolean> {
	const to = await ownerEmail(input.orgId);
	if (!to) return false;
	const { name } = await orgFacts(input.orgId);
	const planName = earlyAccessPlanName(input.plan);
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: grantedSubject({ planName }),
		react: EarlyAccessGrantedEmail({
			orgName: name,
			planName,
			endsOn: input.periodEnd ? formatDate(input.periodEnd) : null,
		}),
		devLog: `early access granted: ${planName} for org ${input.orgId}`,
	});
	return true;
}
