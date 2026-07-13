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
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import { invitation, member, organization, user } from "@/lib/db/schema";
import { RESERVED_SLUGS } from "@/lib/routing";

/** org-slug shape: lowercase alphanumeric words joined by single dashes (mirrors onboarding). */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
 * uses (SLUG_RE + RESERVED_SLUGS + global uniqueness). We ALWAYS invite the owner (never force-add an
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
	if (!SLUG_RE.test(slug)) throw new ProvisionError("Invalid slug.");
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
		console.error(`[platform] owner invite email failed for ${orgId}:`, err);
	}

	return { orgId, invitationId: invite.id };
}

export interface SetOrgPlanInput {
	orgId: string;
	plan: BillingPlan;
	status: BillingStatus;
	seats?: number | null;
	/** The contract term end — the console lapses off-Stripe grants past this (isManualGrantExpired). */
	periodEnd?: Date | null;
}

/**
 * Sets an org's plan by writing the ONE billing record through the real upsertOrgBilling (keeps
 * organization_billing single-writer in the console). On activation, sends the plan-welcome email
 * exactly once (claimPlanWelcome). Used by the OFF-STRIPE onboarding path; the Stripe path lets the
 * webhook do this. No Stripe object is created here.
 */
export async function setOrgPlan(input: SetOrgPlanInput): Promise<void> {
	const [org] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, input.orgId))
		.limit(1);
	if (!org) throw new ProvisionError("Organization not found.");

	await upsertOrgBilling({
		organizationId: input.orgId,
		plan: input.plan,
		status: input.status,
		seats: input.seats ?? null,
		currentPeriodEnd: input.periodEnd ?? null,
	});

	if (input.status === "active" || input.status === "trialing") {
		if (await claimPlanWelcome(input.orgId)) {
			try {
				await sendPlanWelcomeEmailForOrg({
					orgId: input.orgId,
					plan: input.plan,
					isTrial: input.status === "trialing",
				});
			} catch (err) {
				console.error(`[platform] plan-welcome email failed for ${input.orgId}:`, err);
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
