// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What happens around an organization's deletion beyond the rows Postgres cascades.
//
// The organization plugin deletes the `organization` row, and the database cascades its members,
// teams, billing record and projects. Three things are NOT in Postgres and used to be left behind:
//
//   · the OpenFGA tuples granted on the org and its teams — removed by the ee/ hook through its own
//     tuple writer (`removeOrgTuples`), using the team ids captured here BEFORE the cascade;
//   · the org's Stripe subscription — cancelled here, so a deleted team is not charged again;
//   · the members — each active member other than the person who deleted it is emailed.
//
// The work is split in two because the cascade takes the evidence with it: `snapshotOrgForDeletion`
// runs in the plugin's `beforeDeleteOrganization` hook and reads what the second half needs;
// `finishOrgDeletion` runs in `afterDeleteOrganization`, once the delete has happened. Each step of
// the second half is best-effort and logged: the organization is already gone, and refusing would
// change nothing but the error the owner sees.

import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { OrganizationDeletedEmail, subject as orgDeletedSubject } from "@/emails/organization-deleted";
import { getEmailConfig } from "@repo/email/config";
import { isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { member, organization, organizationBilling, team, user } from "@/lib/db/schema";
import { sendGuardedEmail } from "@/lib/email/guard";
import { log } from "@/lib/observability/log";

const olog = log.child({ component: "org-deletion" });

/** Subscription states Stripe would still charge, or will at a trial's end. */
const LIVE_SUBSCRIPTION = new Set(["trialing", "active", "past_due"]);

/** What the second half needs, read before the cascade removes it. */
export interface OrgDeletionSnapshot {
	orgId: string;
	orgName: string;
	/** The org's team ids, for the OpenFGA team tuples. */
	teamIds: string[];
	/** The active members to email: everyone but the person deleting it. */
	recipients: string[];
	/** The subscription to cancel, when one is live. */
	stripeSubscriptionId: string | null;
}

/** Reads what {@link finishOrgDeletion} needs. Called before the delete. */
export async function snapshotOrgForDeletion(
	orgId: string,
	deletedByUserId: string,
): Promise<OrgDeletionSnapshot> {
	const db = getServiceDb();
	const [org] = await db
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const teams = await db
		.select({ id: team.id })
		.from(team)
		.where(eq(team.organizationId, orgId));
	const members = await db
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(
			and(
				eq(member.organizationId, orgId),
				eq(member.status, "active"),
				ne(member.userId, deletedByUserId),
			),
		);
	const [billing] = await db
		.select({
			subscriptionId: organizationBilling.stripeSubscriptionId,
			status: organizationBilling.status,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return {
		orgId,
		orgName: org?.name ?? "Your team",
		teamIds: teams.map((t) => t.id),
		recipients: members.map((m) => m.email),
		stripeSubscriptionId:
			billing?.subscriptionId && LIVE_SUBSCRIPTION.has(billing.status) ? billing.subscriptionId : null,
	};
}

/** What {@link finishOrgDeletion} did, for the caller's log and the tests. */
export interface OrgDeletionOutcome {
	subscriptionCancelled: boolean;
	membersEmailed: number;
}

/** Cancels the deleted org's subscription and emails its members. Called after the delete. */
export async function finishOrgDeletion(snapshot: OrgDeletionSnapshot): Promise<OrgDeletionOutcome> {
	let subscriptionCancelled = false;
	if (snapshot.stripeSubscriptionId && isStripeConfigured()) {
		try {
			await getStripe().subscriptions.cancel(snapshot.stripeSubscriptionId, {
				cancellation_details: { comment: "organization deleted" },
			});
			subscriptionCancelled = true;
		} catch (err) {
			olog.error("cancelling a deleted organization's subscription failed", {
				err,
				org_id: snapshot.orgId,
			});
		}
	} else if (snapshot.stripeSubscriptionId) {
		olog.error("a deleted organization has a live subscription and Stripe is not configured", {
			org_id: snapshot.orgId,
		});
	}

	const config = getEmailConfig();
	let membersEmailed = 0;
	for (const to of snapshot.recipients) {
		try {
			await sendGuardedEmail({
				from: config.from.general,
				configurationSetName: config.configSet.general,
				to,
				subject: orgDeletedSubject(snapshot.orgName),
				react: OrganizationDeletedEmail({ orgName: snapshot.orgName, subscriptionCancelled }),
			});
			membersEmailed += 1;
		} catch (err) {
			olog.error("emailing a member of a deleted organization failed", { err, org_id: snapshot.orgId });
		}
	}
	return { subscriptionCancelled, membersEmailed };
}
