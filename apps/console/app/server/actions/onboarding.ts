"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the post-signup /onboarding setup flow. The org plugin is
// EE-gated and not loaded in the community build, so we configure the
// auto-provisioned primary org by writing the `organization` table directly
// (mirroring provisionPrimaryOrg) rather than via authClient.organization.*.

import { and, count, eq, ne } from "drizzle-orm";
import { completeOnboarding, getPrimaryOrg } from "@/lib/auth/onboarding";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	member,
	organization,
	projects,
} from "@/lib/db/schema";
import { RESERVED_SLUGS } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";

/**
 * {@link configureOnboardingOrg}'s result: the persisted slug, or a refusal the user can read.
 *
 * A refusal is RETURNED, not thrown, because this is a `"use server"` export: in a production build
 * (`next build` + `next start`, which the `qa` release-gate leg drives) Next redacts a thrown
 * `Error`'s message to a digest and answers HTTP 500, so "That slug is reserved" never reached the
 * form — the #4644 class, fixed for `projects.ts` and missed here (#5415). Only refusals the user
 * can act on (name, slug format, reserved, taken) travel this way; an unauthenticated caller, a
 * missing org or a non-owner still throw, because the onboarding form cannot fix any of those.
 */
export type ConfigureOnboardingOrgResult =
	| { ok: true; slug: string }
	| { ok: false; error: string };

/**
 * Renames the current user's primary organization and sets its URL slug (the
 * "Create your organization" step of /onboarding). Owner-gated; validates the slug
 * format and global uniqueness, treating the org's own current slug as available.
 * Returns the persisted slug, or a readable refusal (see {@link ConfigureOnboardingOrgResult}).
 */
export async function configureOnboardingOrg(input: {
	name: string;
	slug: string;
}): Promise<ConfigureOnboardingOrgResult> {
	const userId = await getOwner();
	if (!userId) throw new Error("Not authenticated");

	const org = await getPrimaryOrg(userId);
	if (!org) throw new Error("No organization to configure.");
	if (org.role !== "owner") {
		throw new Error("Only the organization owner can configure it.");
	}

	const name = input.name.trim();
	const slug = input.slug.trim().toLowerCase();
	if (name.length < 2) {
		return { ok: false, error: "Give your organization a name." };
	}
	// The one org-slug rule (@repo/org-slug), which names which half failed: a 64-character slug
	// told "use lowercase letters" has nothing to fix.
	const shape = orgSlugShapeRefusal(slug);
	if (shape) {
		return { ok: false, error: shape.message };
	}
	if (RESERVED_SLUGS.has(slug)) {
		return { ok: false, error: "That slug is reserved — try another." };
	}

	// Unique across all orgs except this one (the user keeps their own slug).
	const [taken] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(and(eq(organization.slug, slug), ne(organization.id, org.id)))
		.limit(1);
	if (taken) return { ok: false, error: "That slug is taken — try another." };

	await getServiceDb()
		.update(organization)
		.set({ name, slug, updatedAt: new Date() })
		.where(eq(organization.id, org.id));

	return { ok: true, slug };
}

/**
 * Marks the current user's post-signup setup (/onboarding) as finished so the
 * post-login gate stops routing them back into it. Called from the wizard's
 * final step (and when they skip ahead to the console).
 */
export async function markOnboardingComplete(): Promise<void> {
	const userId = await getOwner();
	if (!userId) throw new Error("Not authenticated");
	await completeOnboarding(userId);
}

/** Real-data progress for the in-product "Get started" first-run checklist. */
export interface GettingStartedState {
	hasCloud: boolean;
	hasProject: boolean;
	/** A project has been provisioned at least once (a DEPLOY job succeeded). */
	hasProvisioned: boolean;
	/** Inviting teammates is a paid (Pro+) entitlement. */
	canInvite: boolean;
	/** Active members in the org (>1 means a teammate has joined). */
	memberCount: number;
}

/**
 * Derives the "Get started" checklist completion from the active org's real state —
 * connected clouds, projects, members — so steps tick off as the user actually
 * does them (Stripe-style), rather than tracking a wizard.
 */
export async function getGettingStartedState(): Promise<GettingStartedState> {
	const actor = await currentActor();
	const orgId = actor.orgId;
	const db = getServiceDb();
	const [ci, sp, dep, mc] = await Promise.all([
		// Only a *verified* cloud counts as "connected" — a pending/failed placeholder (initIdentity
		// pre-creates one per provider just by viewing the connectors page) must not tick the step.
		db
			.select({ n: count() })
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.org_id, orgId),
					eq(cloudIdentities.is_verified, true),
				),
			),
		db.select({ n: count() }).from(projects).where(eq(projects.org_id, orgId)),
		// Ever provisioned: a deploy job that reached SUCCESS (permanent record —
		// still counts even if the environment was later destroyed).
		db
			.select({ n: count() })
			.from(jobs)
			.where(
				and(
					eq(jobs.org_id, orgId),
					eq(jobs.status, "SUCCESS"),
					eq(jobs.job_type, "DEPLOY"),
				),
			),
		db
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, orgId)),
	]);
	return {
		hasCloud: (ci[0]?.n ?? 0) > 0,
		hasProject: (sp[0]?.n ?? 0) > 0,
		hasProvisioned: (dep[0]?.n ?? 0) > 0,
		canInvite: getEntitlements(actor).organizations,
		memberCount: mc[0]?.n ?? 0,
	};
}
