// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generic org PROVISIONING primitives, called by the staff app (apps/admin) over a cron-secret
// internal route. This is console-domain infrastructure — the same "create an org + wire its owner"
// that provisionPrimaryOrg does at signup — NOT sales logic (nothing here knows the word "contract").
// Keeping org creation, slug validation, and the owner grant HERE means the staff app never imports
// the console's authz/slug rules, and organization_billing stays single-writer (setOrgPlan calls the
// real upsertOrgBilling).

import { and, eq } from "drizzle-orm";
import { claimPlanWelcome, upsertOrgBilling } from "@/lib/billing/queries";
import { sendPlanWelcomeEmailForOrg } from "@/lib/email/billing-email";
import { sendInviteEmail } from "@/lib/email/notify-email";
import type { AiTier } from "@/lib/billing/ai-plan";
import { hasAiSubscription, hasPlanSubscription } from "@/lib/billing/plan";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import {
	type EarlyAccessPlan,
	invitation,
	member,
	organization,
	organizationBilling,
	user,
} from "@/lib/db/schema";
import { sendEarlyAccessGrantedEmail } from "@/lib/early-access/notify";
import { RESERVED_SLUGS } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";
import { log } from "@/lib/observability/log";

/** Days an operator-issued owner invitation stays valid. */
const INVITE_TTL_DAYS = 14;

export class ProvisionError extends Error {}

/**
 * Ensures the platform system user (PLATFORM_SYSTEM_USER_EMAIL) exists and returns its id. This is
 * the `inviterId` on operator-issued invitations (invitation.inviterId is NOT NULL). Idempotent —
 * resolve-or-create by email. The row is a permanent system principal (deleting it would cascade
 * away every pending operator invitation), never a member of any org.
 */
export async function ensurePlatformSystemUser(): Promise<string> {
	const email = process.env.PLATFORM_SYSTEM_USER_EMAIL?.trim().toLowerCase();
	if (!email) {
		throw new ProvisionError("PLATFORM_SYSTEM_USER_EMAIL is not configured.");
	}
	const db = getServiceDb();
	const [existing] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	if (existing) return existing.id;

	const [created] = await db
		.insert(user)
		.values({ email, name: "Alethia Platform", emailVerified: true })
		.onConflictDoNothing()
		.returning({ id: user.id });
	if (created) return created.id;
	// Lost a create race — re-read.
	const [row] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	if (!row) throw new ProvisionError("Could not seed the platform system user.");
	return row.id;
}

export interface ProvisionOrgInput {
	name: string;
	slug: string;
	ownerEmail: string;
}
export interface ProvisionOrgResult {
	orgId: string;
	invitationId: string;
}

/**
 * Creates an org shell and invites its owner. Validates the slug against the SAME rules the console
 * uses (@repo/org-slug + RESERVED_SLUGS + global uniqueness). We ALWAYS invite the owner (never force-add an
 * existing account without consent): the grant is wired when they accept, by ee/'s afterAcceptInvitation
 * hook. The owner must sign in with exactly `ownerEmail` to accept (Better Auth checks email match).
 */
export async function provisionOrg(
	input: ProvisionOrgInput,
): Promise<ProvisionOrgResult> {
	const slug = input.slug.trim().toLowerCase();
	const name = input.name.trim();
	const ownerEmail = input.ownerEmail.trim().toLowerCase();

	if (name.length < 2) throw new ProvisionError("Org name is too short.");
	// The refusal names its reason (too long, or the characters), so the operator who typed it knows
	// what to change — a bare "Invalid slug." did not say a 64-character slug was over by one.
	const shape = orgSlugShapeRefusal(slug);
	if (shape) throw new ProvisionError(`Invalid slug: ${shape.message}`);
	if (RESERVED_SLUGS.has(slug)) throw new ProvisionError("That slug is reserved.");
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
		throw new ProvisionError("Invalid owner email.");
	}

	const db = getServiceDb();
	const [taken] = await db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, slug))
		.limit(1);
	if (taken) throw new ProvisionError(`The slug "${slug}" is taken.`);

	const inviterId = await ensurePlatformSystemUser();

	// Insert the org, catching the unique-constraint race (a concurrent provision of the same slug).
	let orgId: string;
	try {
		const [org] = await db
			.insert(organization)
			.values({ name, slug })
			.returning({ id: organization.id });
		orgId = org.id;
	} catch {
		throw new ProvisionError(`The slug "${slug}" was just taken — try another.`);
	}

	const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
	const [invite] = await db
		.insert(invitation)
		.values({
			organizationId: orgId,
			email: ownerEmail,
			role: "owner",
			status: "pending",
			expiresAt,
			inviterId,
		})
		.returning({ id: invitation.id });

	// Best-effort invite email (the invitation row is the source of truth; a mail failure doesn't
	// undo the provisioning — the operator can resend).
	try {
		await sendInviteEmail({
			to: ownerEmail,
			inviterName: "Alethia",
			workspaceName: name,
			role: "owner",
			token: invite.id,
			expiresInDays: INVITE_TTL_DAYS,
		});
	} catch (err) {
		log.error(`[platform] owner invite email failed for ${orgId}`, { org_id: orgId, err });
	}

	return { orgId, invitationId: invite.id };
}

export interface SetOrgPlanInput {
	orgId: string;
	/** The org plan to set. Omitted (with `status`) for an AI-tier-only grant. */
	plan?: BillingPlan;
	status?: BillingStatus;
	seats?: number | null;
	/**
	 * The term end — the console lapses off-Stripe grants past this (isManualGrantExpired for the
	 * plan, billingAiTier for an off-Stripe AI tier). One row holds one term end, shared by both.
	 */
	periodEnd?: Date | null;
	/** A standalone AI tier to grant off Stripe, with its status (EA-3: AI plans can be granted). */
	ai?: { tier: AiTier; status: BillingStatus };
	/**
	 * Set when this is a complimentary Early Access grant (EA-3, #7325): the customer gets the
	 * complimentary-terms email for that plan INSTEAD of the plan-welcome email, which talks about
	 * invoices and payment methods. The plan-welcome claim is left untouched, so an organization that
	 * later subscribes still gets its welcome then.
	 */
	earlyAccessGrant?: EarlyAccessPlan;
}

/**
 * Writes an off-Stripe AI tier onto the org's billing row. Refuses where the grant would overwrite or
 * fail to lapse: a Stripe-backed AI subscription is never overwritten (the webhook owns it), and a
 * time-limited AI grant is refused on a row whose PLAN is a Stripe subscription, because the term end
 * it would lapse on belongs to that subscription (billingAiTier).
 *
 * When `planAlsoSet` is false the grant's term end is written too — and refused if it would silently
 * move the term of a live off-Stripe plan grant on the same row; grant both together instead.
 */
async function writeOffStripeAiTier(
	orgId: string,
	ai: { tier: AiTier; status: BillingStatus },
	periodEnd: Date | null,
	planAlsoSet: boolean,
): Promise<void> {
	const db = getServiceDb();
	const [row] = await db
		.select({
			plan: organizationBilling.plan,
			status: organizationBilling.status,
			stripeSubscriptionId: organizationBilling.stripeSubscriptionId,
			paddleSubscriptionId: organizationBilling.paddleSubscriptionId,
			aiStripeSubscriptionId: organizationBilling.aiStripeSubscriptionId,
			aiPaddleSubscriptionId: organizationBilling.aiPaddleSubscriptionId,
			currentPeriodEnd: organizationBilling.currentPeriodEnd,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	if (row && hasAiSubscription(row)) {
		throw new ProvisionError(
			"This organization has a paid AI subscription; an off-Stripe AI grant would overwrite it.",
		);
	}
	// A plan subscription at either provider (Stripe or Paddle) owns the row's term end.
	const planIsSubscription = row ? hasPlanSubscription(row) : false;
	if (!planAlsoSet && periodEnd && planIsSubscription) {
		throw new ProvisionError(
			"A time-limited AI grant cannot be given to an organization whose plan is a Stripe subscription: it would never lapse.",
		);
	}
	if (
		!planAlsoSet &&
		row &&
		!planIsSubscription &&
		row.plan !== "community" &&
		(row.status === "active" || row.status === "trialing") &&
		(row.currentPeriodEnd?.getTime() ?? null) !== (periodEnd?.getTime() ?? null)
	) {
		throw new ProvisionError(
			"This organization has an off-Stripe plan grant with a different term end. Grant the AI tier with the same end date, or grant the plan and the AI tier together.",
		);
	}

	const now = new Date();
	const fields = {
		aiTier: ai.tier,
		aiSubscriptionStatus: ai.status,
		aiStripeSubscriptionId: null,
		updatedAt: now,
		// The plan write (upsertOrgBilling) already set the term end when the plan was set too. A row
		// whose plan is a Stripe subscription keeps that subscription's renewal date.
		...(planAlsoSet || planIsSubscription ? {} : { currentPeriodEnd: periodEnd }),
	};
	await db
		.insert(organizationBilling)
		.values({ organizationId: orgId, ...fields })
		.onConflictDoUpdate({ target: organizationBilling.organizationId, set: fields });
}

/**
 * Sets an org's plan and/or its standalone AI tier. The plan is written through the ONE billing
 * writer, upsertOrgBilling (keeps organization_billing single-writer in the console for the plan
 * columns); an AI tier is written by `writeOffStripeAiTier` onto the AI columns only. On activation
 * it sends the plan-welcome email exactly once (claimPlanWelcome) — or, for a complimentary Early
 * Access grant, the complimentary-terms email instead. Used by the OFF-STRIPE onboarding path; the
 * Stripe path lets the webhook do this. No Stripe object is created here.
 */
export async function setOrgPlan(input: SetOrgPlanInput): Promise<void> {
	if ((input.plan === undefined) !== (input.status === undefined)) {
		throw new ProvisionError("A plan and its status are set together.");
	}
	if (input.plan === undefined && !input.ai) {
		throw new ProvisionError("Nothing to set: give a plan, an AI tier, or both.");
	}
	const [org] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, input.orgId))
		.limit(1);
	if (!org) throw new ProvisionError("Organization not found.");

	const periodEnd = input.periodEnd ?? null;
	if (input.plan !== undefined && input.status !== undefined) {
		await upsertOrgBilling({
			organizationId: input.orgId,
			plan: input.plan,
			status: input.status,
			seats: input.seats ?? null,
			currentPeriodEnd: periodEnd,
		});
	}
	if (input.ai) {
		await writeOffStripeAiTier(input.orgId, input.ai, periodEnd, input.plan !== undefined);
	}

	const activated =
		input.status === "active" ||
		input.status === "trialing" ||
		input.ai?.status === "active" ||
		input.ai?.status === "trialing";
	if (!activated) return;

	if (input.earlyAccessGrant) {
		try {
			await sendEarlyAccessGrantedEmail({
				orgId: input.orgId,
				plan: input.earlyAccessGrant,
				periodEnd,
			});
		} catch (err) {
			log.error(`[platform] early-access grant email failed for ${input.orgId}`, {
				org_id: input.orgId,
				err,
			});
		}
		return;
	}

	if (input.plan !== undefined && (input.status === "active" || input.status === "trialing")) {
		if (await claimPlanWelcome(input.orgId)) {
			try {
				await sendPlanWelcomeEmailForOrg({
					orgId: input.orgId,
					plan: input.plan,
					isTrial: input.status === "trialing",
				});
			} catch (err) {
				log.error(`[platform] plan-welcome email failed for ${input.orgId}`, { org_id: input.orgId, err });
			}
		}
	}
}

/** True if `userId` is a member of `orgId` (helper for the operator plane). */
export async function isMember(orgId: string, userId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1);
	return Boolean(row);
}
