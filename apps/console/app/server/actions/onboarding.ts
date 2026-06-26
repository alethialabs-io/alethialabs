"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the post-signup /onboarding setup flow. The org plugin is
// EE-gated and not loaded in the community build, so we configure the
// auto-provisioned primary org by writing the `organization` table directly
// (mirroring provisionPrimaryOrg) rather than via authClient.organization.*.

import { and, eq, ne } from "drizzle-orm";
import { completeOnboarding, getPrimaryOrg } from "@/lib/auth/onboarding";
import { getOwner } from "@/lib/auth/owner";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";
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
