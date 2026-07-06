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

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Renames the current user's primary organization and sets its URL slug (the
 * "Create your organization" step of /onboarding). Owner-gated; validates the slug
 * format and global uniqueness, treating the org's own current slug as available.
 * Returns the persisted slug.
 */
export async function configureOnboardingOrg(input: {
	name: string;
	slug: string;
}): Promise<{ slug: string }> {
	const userId = await getOwner();
	if (!userId) throw new Error("Not authenticated");

	const org = await getPrimaryOrg(userId);
	if (!org) throw new Error("No organization to configure.");
	if (org.role !== "owner") {
		throw new Error("Only the organization owner can configure it.");
	}

	const name = input.name.trim();
	const slug = input.slug.trim().toLowerCase();
	if (name.length < 2) throw new Error("Give your organization a name.");
	if (!SLUG_RE.test(slug)) {
		throw new Error("Use lowercase letters, numbers and hyphens.");
	}
	if (RESERVED_SLUGS.has(slug)) {
		throw new Error("That slug is reserved — try another.");
	}

	// Unique across all orgs except this one (the user keeps their own slug).
	const [taken] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(and(eq(organization.slug, slug), ne(organization.id, org.id)))
		.limit(1);
	if (taken) throw new Error("That slug is taken — try another.");

	await getServiceDb()
		.update(organization)
		.set({ name, slug, updatedAt: new Date() })
		.where(eq(organization.id, org.id));

	return { slug };
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
		db
			.select({ n: count() })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.org_id, orgId)),
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
